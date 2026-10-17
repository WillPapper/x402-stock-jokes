/**
 * Which incoming USDC transfer was the buyer's payment for a joke.
 *
 * The Monetization Gateway's PAYMENT-CONTEXT token carries no transaction hash
 * and no payer address (only aud, scheme, amount and the time claims), so the
 * buyer's transfer is found on the chain instead: the 0.10 USDC that reached
 * our wallet closest to the moment the gate admitted the request. Observed lag
 * is a few seconds. Jokes are matched in admission order and each transfer is
 * claimed once, so two paid jokes in the same minute cannot share a link.
 */
import type { Transfer } from './transfers.ts';

/** Block timestamps are whole seconds and clocks drift, so allow a little before. */
export const BUYER_WINDOW_BEFORE_MS = 15_000;
/** A settlement that takes longer than this is not ours to claim. */
export const BUYER_WINDOW_AFTER_MS = 120_000;

export function matchBuyers(accessAt: Map<string, string>, transfers: Transfer[], priceUsdc: number): Map<string, Transfer> {
	const candidates = transfers
		.filter((t) => t.direction === 'in' && t.at && Math.abs(t.usdc - priceUsdc) < 1e-6)
		.map((t) => ({ t, ms: Date.parse(t.at) }))
		.filter((c) => Number.isFinite(c.ms));
	const claimed = new Set<string>();
	const out = new Map<string, Transfer>();
	const admissions = [...accessAt.entries()].map(([id, at]) => ({ id, ms: Date.parse(at) })).filter((a) => Number.isFinite(a.ms)).sort((a, b) => a.ms - b.ms);
	for (const a of admissions) {
		let best: { t: Transfer; ms: number } | null = null;
		for (const c of candidates) {
			if (claimed.has(c.t.hash)) continue;
			if (c.ms < a.ms - BUYER_WINDOW_BEFORE_MS || c.ms > a.ms + BUYER_WINDOW_AFTER_MS) continue;
			if (!best || Math.abs(c.ms - a.ms) < Math.abs(best.ms - a.ms)) best = c;
		}
		if (best) {
			claimed.add(best.t.hash);
			out.set(a.id, best.t);
		}
	}
	return out;
}
