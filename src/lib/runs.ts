/**
 * The `runs` and `run_payments` tables: one row per conversation, written at
 * each transition, plus one row per x402 payment the run made. Everything the
 * status route, the permalink and the finish hook need is read from here; the
 * `events` table stays a debug log.
 */
import { env } from 'cloudflare:workers';
import { jokeForConversation } from './db.ts';
import type { PaymentRecord } from './ledger.ts';
import { statusOf, type RunStatus } from './status.ts';

export type RunState = 'queued' | 'running' | 'done' | 'failed';
export type StepState = 'running' | 'done' | 'error';
export type ToolName = 'fetch_stocktwits_signals' | 'search_stock_news' | 'write_joke';
export type StepKey = 'stocktwits' | 'ceramic' | 'joke';

const STEP_KEY: Record<ToolName, StepKey> = { fetch_stocktwits_signals: 'stocktwits', search_stock_news: 'ceramic', write_joke: 'joke' };

export interface RunRow {
	id: string;
	ticker: string | null;
	state: RunState;
	paidBy: 'password' | 'x402' | null;
	amountUsdc: string | null;
	stepStates: Partial<Record<ToolName, { state: StepState; error?: string }>>;
	steps: Partial<Record<StepKey, unknown>> | null;
	turns: number;
	lastError: string | null;
	failedStep: string | null;
	error: string | null;
	createdAt: string;
	updatedAt: string;
	finishedAt: string | null;
}

interface RawRun {
	id: string;
	ticker: string | null;
	state: string;
	paid_by: string | null;
	amount_usdc: string | null;
	step_states: string;
	steps: string | null;
	turns: number;
	last_error: string | null;
	failed_step: string | null;
	error: string | null;
	created_at: string;
	updated_at: string;
	finished_at: string | null;
}

function db(): D1Database {
	const d = (env as unknown as { DB?: D1Database }).DB;
	if (!d) throw new Error('D1 binding DB is missing; check wrangler.jsonc d1_databases');
	return d;
}

const now = () => new Date().toISOString();

function parseJson<T>(text: string | null, fallback: T): T {
	if (!text) return fallback;
	try {
		return JSON.parse(text) as T;
	} catch {
		return fallback;
	}
}

function parse(r: RawRun): RunRow {
	return {
		id: r.id,
		ticker: r.ticker,
		state: r.state as RunState,
		paidBy: (r.paid_by as RunRow['paidBy']) ?? null,
		amountUsdc: r.amount_usdc,
		stepStates: parseJson(r.step_states, {}),
		steps: parseJson(r.steps, null),
		turns: r.turns ?? 0,
		lastError: r.last_error,
		failedStep: r.failed_step,
		error: r.error,
		createdAt: r.created_at,
		updatedAt: r.updated_at,
		finishedAt: r.finished_at,
	};
}

export async function getRun(id: string): Promise<RunRow | null> {
	const r = await db().prepare('SELECT * FROM runs WHERE id = ?1').bind(id).first<RawRun>();
	return r ? parse(r) : null;
}

/** The gate admitted a request: the run is queued. A second message to a finished conversation reopens it. */
export async function startRun(id: string, opts: { ticker: string | null; paidBy: 'password' | 'x402'; amountBaseUnits?: string }): Promise<void> {
	const amount = opts.amountBaseUnits ? (Number(opts.amountBaseUnits) / 1e6).toFixed(6) : null;
	const ts = now();
	await db()
		.prepare(
			`INSERT INTO runs (id, ticker, state, paid_by, amount_usdc, created_at, updated_at)
			 VALUES (?1, ?2, 'queued', ?3, ?4, ?5, ?5)
			 ON CONFLICT(id) DO UPDATE SET state = 'queued', ticker = COALESCE(excluded.ticker, runs.ticker), paid_by = excluded.paid_by,
			   amount_usdc = excluded.amount_usdc, error = NULL, last_error = NULL, failed_step = NULL, finished_at = NULL, updated_at = excluded.updated_at`,
		)
		.bind(id, opts.ticker, opts.paidBy, amount, ts)
		.run();
}

/** Make sure a row exists before a tool or the agent writes to it (the gate's insert is the normal path). */
async function ensureRun(id: string): Promise<void> {
	const ts = now();
	await db().prepare(`INSERT OR IGNORE INTO runs (id, state, created_at, updated_at) VALUES (?1, 'running', ?2, ?2)`).bind(id, ts).run();
}

export async function markRunning(id: string): Promise<void> {
	await ensureRun(id);
	await db().prepare(`UPDATE runs SET state = 'running', updated_at = ?2 WHERE id = ?1 AND state IN ('queued', 'running')`).bind(id, now()).run();
}

/** A tool started, finished (with its full output) or failed. */
export async function setStep(id: string, tool: ToolName, state: StepState, opts: { output?: unknown; error?: string } = {}): Promise<void> {
	await ensureRun(id);
	const entry = JSON.stringify(state === 'error' ? { state, error: opts.error ?? 'failed' } : { state });
	const path = `$.${tool}`;
	if (state === 'done' && opts.output !== undefined) {
		await db()
			.prepare(
				`UPDATE runs SET step_states = json_set(step_states, ?2, json(?3)), steps = json_set(COALESCE(steps, '{}'), ?4, json(?5)),
				 last_error = NULL, updated_at = ?6 WHERE id = ?1`,
			)
			.bind(id, path, entry, `$.${STEP_KEY[tool]}`, JSON.stringify(opts.output), now())
			.run();
		return;
	}
	await db()
		.prepare(
			`UPDATE runs SET step_states = json_set(step_states, ?2, json(?3)), last_error = ?4, failed_step = COALESCE(?5, failed_step), updated_at = ?6 WHERE id = ?1`,
		)
		.bind(id, path, entry, state === 'error' ? (opts.error ?? 'failed').slice(0, 400) : null, state === 'error' ? tool : null, now())
		.run();
}

/** One full tool output from the run's archive, e.g. the StockTwits signals. */
export async function stepOutput<T = unknown>(id: string, key: StepKey): Promise<T | null> {
	const run = await getRun(id);
	return (run?.steps?.[key] as T | undefined) ?? null;
}

/** A paid model turn finished: count it, or record why it failed. */
export async function recordTurn(id: string, ok: boolean, error?: string): Promise<void> {
	await ensureRun(id);
	await db()
		.prepare(ok ? `UPDATE runs SET turns = turns + 1, last_error = NULL, updated_at = ?2 WHERE id = ?1` : `UPDATE runs SET last_error = ?3, updated_at = ?2 WHERE id = ?1`)
		.bind(id, now(), (error ?? 'model turn failed').slice(0, 400))
		.run();
}

export async function finishRun(id: string, outcome: { state: 'done' } | { state: 'failed'; error: string }): Promise<void> {
	await ensureRun(id);
	const ts = now();
	if (outcome.state === 'done') {
		await db().prepare(`UPDATE runs SET state = 'done', error = NULL, finished_at = ?2, updated_at = ?2 WHERE id = ?1`).bind(id, ts).run();
		return;
	}
	// The failed step's own message ("symbol not found", "rate limited") beats "tool failures: <name>".
	await db().prepare(`UPDATE runs SET state = 'failed', error = COALESCE(last_error, ?3), finished_at = ?2, updated_at = ?2 WHERE id = ?1`).bind(id, ts, outcome.error.slice(0, 400)).run();
}

export async function addRunPayment(id: string, p: PaymentRecord): Promise<void> {
	await db()
		.prepare(`INSERT INTO run_payments (run_id, at, label, url, scheme, authorized_usdc, settled, ok, tx, ray) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`)
		.bind(id, p.at, p.label, p.url, p.scheme, p.authorizedUsdc, p.settled ? 1 : 0, p.ok ? 1 : 0, p.tx, p.ray ?? null)
		.run();
}

export async function runPayments(id: string): Promise<PaymentRecord[]> {
	const { results } = await db()
		.prepare('SELECT at, label, url, scheme, authorized_usdc, settled, ok, tx, ray FROM run_payments WHERE run_id = ?1 ORDER BY at ASC, id ASC')
		.bind(id)
		.all<{ at: string; label: string; url: string; scheme: string; authorized_usdc: string; settled: number; ok: number; tx: string | null; ray: string | null }>();
	return results.map((r) => ({
		at: r.at,
		label: r.label,
		url: r.url,
		scheme: r.scheme === 'exact' || r.scheme === 'upto' ? r.scheme : 'unknown',
		authorizedUsdc: r.authorized_usdc,
		settled: r.settled === 1,
		ok: r.ok === 1,
		tx: r.tx,
		ray: r.ray,
	}));
}

/** When each of these conversations was admitted by an x402 payment (conversation id → ISO time). */
export async function x402RunTimes(ids: string[]): Promise<Map<string, string>> {
	const out = new Map<string, string>();
	for (let i = 0; i < ids.length; i += 50) {
		const chunk = ids.slice(i, i + 50);
		const marks = chunk.map((_, k) => `?${k + 1}`).join(', ');
		const { results } = await db().prepare(`SELECT id, created_at FROM runs WHERE paid_by = 'x402' AND id IN (${marks})`).bind(...chunk).all<{ id: string; created_at: string }>();
		for (const r of results) out.set(r.id, r.created_at);
	}
	return out;
}

/** How many jokes buyers paid for through the gateway, and the USDC they paid. */
export async function paidRunTotals(): Promise<{ paidJokes: number; earnedUsdc: number }> {
	const r = await db().prepare("SELECT COUNT(*) AS n, COALESCE(SUM(CAST(amount_usdc AS REAL)), 0) AS total FROM runs WHERE paid_by = 'x402'").first<{ n: number; total: number }>();
	return { paidJokes: r?.n ?? 0, earnedUsdc: r?.total ?? 0 };
}

/** The public status of a run (GET /joke/<id>): the run row, the joke row if one exists, and the run's payments. */
export async function runStatus(id: string): Promise<RunStatus> {
	const [run, joke, payments] = await Promise.all([getRun(id), jokeForConversation(id), runPayments(id)]);
	return statusOf(id, run, joke, payments);
}
