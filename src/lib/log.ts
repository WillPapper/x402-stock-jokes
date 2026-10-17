/**
 * Structured logging for everything that touches Cloudflare's gateways, so a
 * misbehaving payment can be reported with the identifiers support needs:
 * cf-ray, cf-aig-* ids, the x402 quote and payload, the PAYMENT-CONTEXT claims,
 * visitor country/colo, timings. Each event goes to Workers Logs as one JSON
 * line and, best effort, to the D1 `events` table (GET /api/events).
 */
import { env } from 'cloudflare:workers';

export type EventKind = 'x402.payment' | 'alchemy.fallback' | 'alchemy.topup' | 'gate' | 'ai.turn' | 'error' | 'tool.start' | 'tool.done' | 'tool.error' | 'agent.done';

export interface LoggedEvent {
	ts: string;
	kind: EventKind;
	conversationId: string | null;
	label: string | null;
	ok: boolean;
	data: Record<string, unknown>;
}

/** Set by the agent when a conversation starts; the isolate usually serves one at a time. */
let currentConversation: string | null = null;
export const conversationScope = {
	set: (id: string | null) => {
		currentConversation = id;
	},
	get: () => currentConversation,
};

export function logEvent(kind: EventKind, ok: boolean, data: Record<string, unknown>, opts: { conversationId?: string | null; label?: string | null } = {}): LoggedEvent {
	return writeEvent(kind, ok, data, opts).event;
}

/** logEvent, but resolves once the D1 row is written: for events that later decisions read back. */
export async function logEventDurably(kind: EventKind, ok: boolean, data: Record<string, unknown>, opts: { conversationId?: string | null; label?: string | null } = {}): Promise<LoggedEvent> {
	const { event, persisted } = writeEvent(kind, ok, data, opts);
	await persisted;
	return event;
}

/** Time of the latest event of `kind` at or after `since` (ISO), or null (also when D1 is unavailable). */
export async function lastEventAt(kind: EventKind, since: string): Promise<string | null> {
	const db = (env as unknown as { DB?: D1Database }).DB;
	if (!db) return null;
	const row = await db.prepare('SELECT ts FROM events WHERE kind = ?1 AND ts >= ?2 ORDER BY ts DESC LIMIT 1').bind(kind, since).first<{ ts: string }>();
	return row?.ts ?? null;
}

function writeEvent(kind: EventKind, ok: boolean, data: Record<string, unknown>, opts: { conversationId?: string | null; label?: string | null }): { event: LoggedEvent; persisted: Promise<void> } {
	const event: LoggedEvent = {
		ts: new Date().toISOString(),
		kind,
		conversationId: opts.conversationId ?? currentConversation,
		label: opts.label ?? null,
		ok,
		data,
	};
	// One JSON line per event: easy to grep in `wrangler tail` and Workers Logs.
	console.log(JSON.stringify({ event: kind, ok, conversation: event.conversationId, label: event.label, ...data }));
	const db = (env as unknown as { DB?: D1Database }).DB;
	const persisted = db
		? db
				.prepare('INSERT INTO events (ts, kind, conversation_id, label, ok, data) VALUES (?1, ?2, ?3, ?4, ?5, ?6)')
				.bind(event.ts, kind, event.conversationId, event.label, ok ? 1 : 0, JSON.stringify(data))
				.run()
				.then(() => undefined)
				.catch((err: unknown) => console.warn('event persist failed', (err as Error).message.slice(0, 120)))
		: Promise.resolve();
	return { event, persisted };
}

export async function listEvents(opts: { limit?: number; conversationId?: string; kind?: string; failuresOnly?: boolean; since?: string; ascending?: boolean } = {}) {
	const db = (env as unknown as { DB?: D1Database }).DB;
	if (!db) return [];
	const where: string[] = [];
	const binds: unknown[] = [];
	if (opts.conversationId) {
		where.push(`conversation_id = ?${binds.length + 1}`);
		binds.push(opts.conversationId);
	}
	if (opts.kind) {
		where.push(`kind = ?${binds.length + 1}`);
		binds.push(opts.kind);
	}
	if (opts.failuresOnly) where.push('ok = 0');
	if (opts.since) {
		where.push(`ts > ?${binds.length + 1}`);
		binds.push(opts.since);
	}
	const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
	const sql = `SELECT id, ts, kind, conversation_id, label, ok, data FROM events ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id ${opts.ascending ? 'ASC' : 'DESC'} LIMIT ${limit}`;
	const { results } = await db.prepare(sql).bind(...binds).all<{ id: number; ts: string; kind: string; conversation_id: string | null; label: string | null; ok: number; data: string }>();
	return results.map((r) => ({ id: r.id, ts: r.ts, kind: r.kind, conversationId: r.conversation_id, label: r.label, ok: r.ok === 1, data: JSON.parse(r.data) as Record<string, unknown> }));
}

/** Pull the Cloudflare identifiers off an upstream response for bug reports. */
export function upstreamIds(res: Response): Record<string, string> {
	const out: Record<string, string> = {};
	for (const h of ['cf-ray', 'cf-aig-request-id', 'cf-aig-event-id', 'cf-aig-trace-id', 'cf-aig-log-id', 'cf-auditlog-id', 'api-version', 'x-request-id']) {
		const v = res.headers.get(h);
		if (v) out[h] = v;
	}
	return out;
}

/** Decode a JWT payload without verifying (for logging only). */
export function jwtPayload(token: string | undefined | null): Record<string, unknown> | null {
	if (!token) return null;
	try {
		const part = token.split('.')[1] ?? '';
		const json = atob(part.replace(/-/g, '+').replace(/_/g, '/').padEnd(part.length + ((4 - (part.length % 4)) % 4), '='));
		return JSON.parse(json) as Record<string, unknown>;
	} catch {
		return null;
	}
}
