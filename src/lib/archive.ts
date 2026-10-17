/**
 * The step archive stored with each joke ({ stocktwits, ceramic, joke }: the
 * full tool outputs behind the page's "under the hood" panels).
 *
 * The tools record their outputs in the in-memory hand-off, which a Durable
 * Object restart (a deploy, an eviction) mid-run wipes. Flue then resumes the
 * run from its durable records without re-executing the finished tools, so the
 * hand-off never sees them again: a Nintendo joke was archived with only its
 * joke step after a deploy landed between a failed turn and its retry. Every
 * tool also logs its output to the D1 events table, so missing steps are
 * filled in from there.
 */
import { handoff } from './drafts.ts';
import { ledger, mergePayments, paymentFromEvent, type PaymentRecord } from './ledger.ts';
import { listEvents } from './log.ts';

const STEP_OF: Record<string, string> = { fetch_stocktwits_signals: 'stocktwits', search_stock_news: 'ceramic', write_joke: 'joke' };

export async function archivedSteps(conversationId: string, opts: { take?: boolean } = {}): Promise<Record<string, unknown> | null> {
	const merged: Record<string, unknown> = { ...((opts.take ? handoff.takeSteps(conversationId) : handoff.steps(conversationId)) ?? {}) };
	if (Object.values(STEP_OF).every((k) => k in merged)) return merged;
	// Newest first, so the first event per tool is the one that counts.
	const events = await listEvents({ conversationId, kind: 'tool.done', limit: 30 }).catch(() => []);
	for (const e of events) {
		const key = typeof e.data.tool === 'string' ? STEP_OF[e.data.tool] : undefined;
		if (key && !(key in merged) && e.data.output) merged[key] = e.data.output;
	}
	return Object.keys(merged).length ? merged : null;
}

/**
 * Every payment this conversation made, for the D1 row: the durable
 * `x402.payment` events joined with the in-memory ledger since the
 * conversation's mark. Survives a Durable Object restart mid-run, which empties
 * the ledger and resets the mark to 0 (see src/lib/ledger.ts).
 */
export async function archivedPayments(conversationId: string, opts: { take?: boolean } = {}): Promise<PaymentRecord[]> {
	const memory = ledger.since(opts.take ? handoff.takeMark(conversationId) : handoff.mark(conversationId));
	const events = await listEvents({ conversationId, kind: 'x402.payment', limit: 200, ascending: true }).catch(() => []);
	const durable = events.map((e) => paymentFromEvent(e.ts, e.data)).filter((p): p is PaymentRecord => p !== null);
	return mergePayments(durable, memory);
}
