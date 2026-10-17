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
 * Known gaps (seen on a Nintendo run, 2026-10-17): a deploy mid-run restarts
 * the isolate, which empties the array and the marks map, so `since(0)` in the
 * resumed run only sees payments made after the restart and the row's
 * `payments` miss the earlier ones. The `x402.payment` events in D1 are the
 * durable record; the ledger is never a source of truth for money.
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
}

const records: PaymentRecord[] = [];

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
