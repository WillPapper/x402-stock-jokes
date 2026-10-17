/** D1 persistence for finished jokes: the feed, per-ticker cache, and stats. Runs live in src/lib/runs.ts. */
import { env } from 'cloudflare:workers';
import type { PaymentRecord } from './ledger.ts';
import { redactAccountIds } from './redact.ts';

/** What a joke cost on-chain, computed once from the wallet's transfers (src/lib/settlement.ts). */
export interface Settled {
	paid: { exactUsdc: number; exactCount: number; aiUsdc: number; aiCount: number; totalUsdc: number };
	buyer: { usdc: number; from: string; tx: string | null; at: string } | null;
}

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
	/** Full tool outputs: { stocktwits, ceramic, joke }. */
	steps: Record<string, unknown> | null;
	/** Null until the chain has been consulted for this joke. */
	settled: Settled | null;
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
	steps: string | null;
	settled: string | null;
	created_at: string;
}

function db(): D1Database {
	const d = (env as unknown as { DB?: D1Database }).DB;
	if (!d) throw new Error('D1 binding DB is missing; check wrangler.jsonc d1_databases');
	return d;
}

function parse(r: RawRow): JokeRow {
	// Rows written before 2026-10-17 carry the Cloudflare account id inside AI
	// Gateway URLs and no `ok` flag on their payments; new rows are written clean.
	const payments = redactAccountIds(JSON.parse(r.payments) as (PaymentRecord & { ok?: boolean })[]).map((p) => ({ ...p, ok: p.ok ?? true }));
	return {
		id: r.id,
		conversationId: r.conversation_id,
		ticker: r.ticker,
		title: r.title,
		joke: r.joke,
		facts: JSON.parse(r.facts) as string[],
		payments,
		totalAuthorizedUsdc: r.total_authorized_usdc,
		orchestratorModel: r.orchestrator_model,
		jokeModel: r.joke_model,
		paidBy: (r.paid_by as JokeRow['paidBy']) ?? null,
		steps: r.steps ? redactAccountIds(JSON.parse(r.steps) as Record<string, unknown>) : null,
		settled: r.settled ? (JSON.parse(r.settled) as Settled) : null,
		createdAt: r.created_at,
	};
}

export async function insertJoke(row: Omit<JokeRow, 'id' | 'createdAt' | 'settled'> & { id?: string; createdAt?: string }): Promise<JokeRow> {
	const full: JokeRow = { ...row, settled: null, id: row.id ?? crypto.randomUUID(), createdAt: row.createdAt ?? new Date().toISOString() };
	await db()
		.prepare(
			`INSERT INTO jokes (id, conversation_id, ticker, title, joke, facts, payments, total_authorized_usdc, orchestrator_model, joke_model, paid_by, steps, created_at)
			 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)`,
		)
		.bind(full.id, full.conversationId, full.ticker, full.title, full.joke, JSON.stringify(full.facts), JSON.stringify(full.payments), full.totalAuthorizedUsdc, full.orchestratorModel, full.jokeModel, full.paidBy, full.steps ? JSON.stringify(full.steps) : null, full.createdAt)
		.run();
	return full;
}

/** Finish a row written by write_joke: the finish hook adds the full step archive and any late payments. */
export async function completeJoke(conversationId: string, patch: { payments: PaymentRecord[]; totalAuthorizedUsdc: string; steps: Record<string, unknown> | null }): Promise<boolean> {
	const res = await db()
		.prepare('UPDATE jokes SET payments = ?2, total_authorized_usdc = ?3, steps = COALESCE(?4, steps) WHERE conversation_id = ?1')
		.bind(conversationId, JSON.stringify(patch.payments), patch.totalAuthorizedUsdc, patch.steps ? JSON.stringify(patch.steps) : null)
		.run();
	return (res.meta?.changes ?? 0) > 0;
}

export async function saveSettled(jokeId: string, settled: Settled): Promise<void> {
	await db().prepare('UPDATE jokes SET settled = ?2 WHERE id = ?1').bind(jokeId, JSON.stringify(settled)).run();
}

/**
 * Newest first. With `after`, only rows created after that ISO timestamp (oldest
 * first, for appending); with `before`, only rows created before it (newest
 * first, for paging back through the feed).
 */
export async function listJokes(opts: { after?: string; before?: string; limit?: number } = {}): Promise<JokeRow[]> {
	const limit = Math.min(Math.max(opts.limit ?? 30, 1), 200);
	const stmt = opts.after
		? db().prepare('SELECT * FROM jokes WHERE created_at > ?1 ORDER BY created_at ASC LIMIT ?2').bind(opts.after, limit)
		: opts.before
			? db().prepare('SELECT * FROM jokes WHERE created_at < ?1 ORDER BY created_at DESC LIMIT ?2').bind(opts.before, limit)
			: db().prepare('SELECT * FROM jokes ORDER BY created_at DESC LIMIT ?1').bind(limit);
	const { results } = await stmt.all<RawRow>();
	return results.map(parse);
}

export async function jokeForConversation(conversationId: string): Promise<JokeRow | null> {
	const r = await db().prepare('SELECT * FROM jokes WHERE conversation_id = ?1 ORDER BY created_at DESC LIMIT 1').bind(conversationId).first<RawRow>();
	return r ? parse(r) : null;
}

export async function latestJokeFor(ticker: string): Promise<JokeRow | null> {
	const r = await db().prepare('SELECT * FROM jokes WHERE ticker = ?1 ORDER BY created_at DESC LIMIT 1').bind(ticker.toUpperCase()).first<RawRow>();
	return r ? parse(r) : null;
}

export interface JokeStats {
	count: number;
	tickers: number;
	/** Jokes per hour for the last 24 hours, oldest first; `hour` is an ISO timestamp truncated to the hour. */
	perHour: { hour: string; count: number }[];
	latestAt: string | null;
}

export async function jokeStats(): Promise<JokeStats> {
	const totals = await db().prepare('SELECT COUNT(*) AS count, COUNT(DISTINCT ticker) AS tickers, MAX(created_at) AS latest FROM jokes').first<{ count: number; tickers: number; latest: string | null }>();
	const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
	const { results } = await db().prepare("SELECT substr(created_at, 1, 13) || ':00:00Z' AS hour, COUNT(*) AS count FROM jokes WHERE created_at > ?1 GROUP BY hour ORDER BY hour ASC").bind(since).all<{ hour: string; count: number }>();
	return {
		count: totals?.count ?? 0,
		tickers: totals?.tickers ?? 0,
		perHour: results,
		latestAt: totals?.latest ?? null,
	};
}

/**
 * Record a PAYMENT-CONTEXT token (by hash) the first time it admits a request.
 * Returns false when the same token was already recorded, i.e. a replay.
 */
export async function claimPaymentToken(tokenHash: string, aud: string | null, conversationId: string | null): Promise<boolean> {
	const res = await db()
		.prepare('INSERT OR IGNORE INTO payment_tokens (token_hash, aud, conversation_id, created_at) VALUES (?1, ?2, ?3, ?4)')
		.bind(tokenHash, aud, conversationId, new Date().toISOString())
		.run();
	return (res.meta?.changes ?? 0) > 0;
}
