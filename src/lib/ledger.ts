/**
 * In-isolate record of every x402 payment this Worker instance made, so the
 * agent can attach receipts to its reply and the page can show them. This is
 * our code, not a Flue feature: Flue knows nothing about payments.
 *
 * A "mark" is just the ledger's length at some moment (`mark()`), and
 * `since(mark)` returns the records appended after it. The agent takes two:
 * one at agent start (kept in `handoff`, src/lib/drafts.ts) to total the whole
 * conversation for the D1 row, and one per response (carried in the reply's
 * metadata through Flue's `useResponseStart` → `useResponseFinish`) to attach
 * that response's receipts to the reply. The ledger itself is a module-level
 * array, so both marks assume the Durable Object keeps one isolate alive for
 * the whole run, and that no other conversation pays from the same isolate.
 *
 * The array is not durable: a deploy mid-run restarts the isolate, which
 * empties it and the marks map, so `since(0)` in the resumed run only sees
 * payments made after the restart (a Nintendo row kept 4 of 11 payments that
 * way, 2026-10-17). The D1 row's `payments` therefore come from
 * `archivedPayments()` (src/lib/archive.ts): the conversation's `x402.payment`
 * events, which are durable, merged with whatever this array still has
 * (`mergePayments` below), since the event write is best effort and async.
 * The ledger is never a source of truth for money.
 */
import type { ReceiptEvent } from './x402.ts';
import { formatUsdc } from './budget.ts';
import { basescanTxUrl } from './tx.ts';

export interface PaymentRecord {
	at: string;
	label: string;
	url: string;
	scheme: 'exact' | 'upto' | 'unknown';
	/** USDC authorized, as a decimal string. For `upto` this is a ceiling, not the settled cost. */
	authorizedUsdc: string;
	settled: boolean;
	tx: string | null;
	/** cf-ray of the final attempt; matches the `x402.payment` event for the same call. */
	ray?: string | null;
}

const records: PaymentRecord[] = [];

/**
 * Rebuild a ledger record from an `x402.payment` event row (its `ts` and `data`,
 * see PaymentEvent in x402.ts). Null when nothing was authorized (a free call).
 */
export function paymentFromEvent(ts: string, data: Record<string, unknown>): PaymentRecord | null {
	if (typeof data.authorizedUsdc !== 'string') return null;
	const attempts = Array.isArray(data.attempts) ? (data.attempts as Array<Record<string, unknown>>) : [];
	const last = attempts.at(-1);
	const response = last?.paymentResponse as { transaction?: string } | null | undefined;
	const url = typeof data.url === 'string' ? data.url : '';
	return {
		at: ts,
		label: typeof data.label === 'string' ? data.label : url,
		url,
		scheme: data.scheme === 'exact' || data.scheme === 'upto' ? data.scheme : 'unknown',
		authorizedUsdc: data.authorizedUsdc,
		settled: data.settled === true,
		tx: basescanTxUrl(response?.transaction),
		ray: typeof (last?.ids as Record<string, string> | undefined)?.['cf-ray'] === 'string' ? (last!.ids as Record<string, string>)['cf-ray'] : null,
	};
}

/**
 * Durable records first, then in-memory ones the events do not have yet (the
 * event insert is async and best effort, so the closing turn's payment may not
 * be in D1 when the finish hook reads). Two records are the same payment when
 * their cf-ray matches, or, lacking one, when url and amount match within 5 s.
 */
export function mergePayments(durable: PaymentRecord[], memory: PaymentRecord[]): PaymentRecord[] {
	const same = (a: PaymentRecord, b: PaymentRecord) => (a.ray && b.ray ? a.ray === b.ray : a.url === b.url && a.authorizedUsdc === b.authorizedUsdc && Math.abs(Date.parse(a.at) - Date.parse(b.at)) <= 5_000);
	const out = [...durable];
	for (const m of memory) if (!out.some((d) => same(d, m))) out.push(m);
	return out.sort((a, b) => a.at.localeCompare(b.at));
}

export function totalAuthorizedUsdc(payments: PaymentRecord[]): string {
	return payments.reduce((sum, p) => sum + Number(p.authorizedUsdc), 0).toFixed(6);
}

export const ledger = {
	record(label: string, event: ReceiptEvent): PaymentRecord | null {
		if (event.authorized === null) return null;
		const rec: PaymentRecord = {
			at: new Date().toISOString(),
			label,
			url: event.url,
			scheme: event.url.includes('/ai/run') ? 'upto' : event.receipt ? 'exact' : 'unknown',
			authorizedUsdc: formatUsdc(event.authorized),
			settled: event.settled,
			tx: basescanTxUrl(event.receipt?.transaction),
			ray: event.ray ?? null,
		};
		records.push(rec);
		if (records.length > 500) records.splice(0, records.length - 500);
		return rec;
	},
	mark(): number {
		return records.length;
	},
	since(mark: number): PaymentRecord[] {
		return records.slice(mark);
	},
	all(): readonly PaymentRecord[] {
		return records;
	},
};
