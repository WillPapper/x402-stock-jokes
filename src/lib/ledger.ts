/**
 * In-isolate record of every x402 payment this Worker instance made, so the
 * agent can attach receipts to its reply and the page can show them. Durable
 * Objects keep an isolate warm for a conversation, so "since mark" covers one
 * response's payments reliably; the ledger is not a source of truth for money.
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
