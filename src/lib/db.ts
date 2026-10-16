/** D1 persistence for finished jokes: the feed, per-ticker cache, and stats. */
import { env } from 'cloudflare:workers';
import type { PaymentRecord } from './ledger.ts';

export interface JokeRow {
	id: string;
	conversationId: string;
	ticker: string;
	title: string | null;
	joke: string;
	facts: string[];
	payments: PaymentRecord[];
	totalAuthorizedUsdc: string;
	orchestratorModel: string | null;
	jokeModel: string | null;
	paidBy: 'password' | 'x402' | null;
	createdAt: string;
}

interface RawRow {
	id: string;
	conversation_id: string;
	ticker: string;
	title: string | null;
	joke: string;
	facts: string;
	payments: string;
	total_authorized_usdc: string;
	orchestrator_model: string | null;
	joke_model: string | null;
	paid_by: string | null;
	created_at: string;
}

function db(): D1Database {
	const d = (env as unknown as { DB?: D1Database }).DB;
	if (!d) throw new Error('D1 binding DB is missing; check wrangler.jsonc d1_databases');
	return d;
}

function parse(r: RawRow): JokeRow {
	return {
		id: r.id,
		conversationId: r.conversation_id,
		ticker: r.ticker,
		title: r.title,
		joke: r.joke,
		facts: JSON.parse(r.facts) as string[],
		payments: JSON.parse(r.payments) as PaymentRecord[],
		totalAuthorizedUsdc: r.total_authorized_usdc,
		orchestratorModel: r.orchestrator_model,
		jokeModel: r.joke_model,
		paidBy: (r.paid_by as JokeRow['paidBy']) ?? null,
		createdAt: r.created_at,
	};
}

export async function insertJoke(row: Omit<JokeRow, 'id' | 'createdAt'> & { id?: string; createdAt?: string }): Promise<JokeRow> {
	const full: JokeRow = { ...row, id: row.id ?? crypto.randomUUID(), createdAt: row.createdAt ?? new Date().toISOString() };
	await db()
		.prepare(
			`INSERT INTO jokes (id, conversation_id, ticker, title, joke, facts, payments, total_authorized_usdc, orchestrator_model, joke_model, paid_by, created_at)
			 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)`,
		)
		.bind(full.id, full.conversationId, full.ticker, full.title, full.joke, JSON.stringify(full.facts), JSON.stringify(full.payments), full.totalAuthorizedUsdc, full.orchestratorModel, full.jokeModel, full.paidBy, full.createdAt)
		.run();
	return full;
}

/** Newest first. With `after`, only rows created after that ISO timestamp (oldest first, for appending). */
export async function listJokes(opts: { after?: string; limit?: number } = {}): Promise<JokeRow[]> {
	const limit = Math.min(Math.max(opts.limit ?? 30, 1), 200);
	const stmt = opts.after
		? db().prepare('SELECT * FROM jokes WHERE created_at > ?1 ORDER BY created_at ASC LIMIT ?2').bind(opts.after, limit)
		: db().prepare('SELECT * FROM jokes ORDER BY created_at DESC LIMIT ?1').bind(limit);
	const { results } = await stmt.all<RawRow>();
	return results.map(parse);
}

export async function latestJokeFor(ticker: string): Promise<JokeRow | null> {
	const r = await db().prepare('SELECT * FROM jokes WHERE ticker = ?1 ORDER BY created_at DESC LIMIT 1').bind(ticker.toUpperCase()).first<RawRow>();
	return r ? parse(r) : null;
}

export interface JokeStats {
	count: number;
	tickers: number;
	totalAuthorizedUsdc: string;
	/** Jokes per hour for the last 24 hours, oldest first; `hour` is an ISO timestamp truncated to the hour. */
	perHour: { hour: string; count: number }[];
	latestAt: string | null;
}

export async function jokeStats(): Promise<JokeStats> {
	const totals = await db().prepare('SELECT COUNT(*) AS count, COUNT(DISTINCT ticker) AS tickers, COALESCE(SUM(CAST(total_authorized_usdc AS REAL)), 0) AS total, MAX(created_at) AS latest FROM jokes').first<{ count: number; tickers: number; total: number; latest: string | null }>();
	const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
	const { results } = await db().prepare("SELECT substr(created_at, 1, 13) || ':00:00Z' AS hour, COUNT(*) AS count FROM jokes WHERE created_at > ?1 GROUP BY hour ORDER BY hour ASC").bind(since).all<{ hour: string; count: number }>();
	return {
		count: totals?.count ?? 0,
		tickers: totals?.tickers ?? 0,
		totalAuthorizedUsdc: (totals?.total ?? 0).toFixed(6),
		perHour: results,
		latestAt: totals?.latest ?? null,
	};
}

export async function recordAccess(conversationId: string, paidBy: 'password' | 'x402', amountBaseUnits?: string): Promise<void> {
	const amount = amountBaseUnits ? (Number(amountBaseUnits) / 1e6).toFixed(6) : null;
	await db()
		.prepare('INSERT INTO access (conversation_id, paid_by, amount_usdc, created_at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(conversation_id) DO UPDATE SET paid_by = excluded.paid_by, amount_usdc = excluded.amount_usdc')
		.bind(conversationId, paidBy, amount, new Date().toISOString())
		.run();
}

export async function accessFor(conversationId: string): Promise<{ paidBy: 'password' | 'x402'; amountUsdc: string | null } | null> {
	const r = await db().prepare('SELECT paid_by, amount_usdc FROM access WHERE conversation_id = ?1').bind(conversationId).first<{ paid_by: string; amount_usdc: string | null }>();
	return r ? { paidBy: r.paid_by as 'password' | 'x402', amountUsdc: r.amount_usdc } : null;
}
