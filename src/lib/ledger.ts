/**
 * Payment records: what one x402 payment looks like once stored with a run or
 * shown on the page. The durable copy lives in D1 (`run_payments`, see
 * src/lib/runs.ts); this module also keeps a short in-memory list of this
 * isolate's recent payments for GET /api/ledger and for the receipts attached
 * to each reply (`useResponseStart`/`useResponseFinish` in the agent, which
 * must be synchronous). Neither in-memory use is a source of truth for money.
 */
import { formatUsdc } from './budget.ts';
import { redactAccountIds } from './redact.ts';
import { basescanTxUrl } from './tx.ts';
import type { PaymentEvent } from './x402.ts';

export interface PaymentRecord {
	at: string;
	label: string;
	/** Seller URL with the Cloudflare account id already stripped. */
	url: string;
	scheme: 'exact' | 'upto' | 'unknown';
	/** USDC authorized, as a decimal string. For `upto` this is a ceiling, not the settled cost. */
	authorizedUsdc: string;
	settled: boolean;
	/** False when the paid call itself failed after the payment was authorized. */
	ok: boolean;
	tx: string | null;
	/** cf-ray of the final attempt; matches the `x402.payment` event for the same call. */
	ray?: string | null;
}

/** The record for a completed paid call, or null when nothing was signed (a free call). */
export function paymentRecord(label: string, event: PaymentEvent): PaymentRecord | null {
	if (event.authorizedUsdc === null) return null;
	return {
		at: new Date().toISOString(),
		label,
		url: redactAccountIds(event.url),
		scheme: event.scheme === 'exact' || event.scheme === 'upto' ? event.scheme : event.url.includes('/ai/run') ? 'upto' : event.receipt ? 'exact' : 'unknown',
		authorizedUsdc: event.authorizedUsdc,
		settled: event.settled,
		ok: event.ok,
		tx: basescanTxUrl(event.receipt?.transaction),
		ray: event.ray ?? null,
	};
}

export function totalAuthorizedUsdc(payments: PaymentRecord[]): string {
	return payments.reduce((sum, p) => sum + Number(p.authorizedUsdc), 0).toFixed(6);
}

const records: PaymentRecord[] = [];

export const ledger = {
	record(rec: PaymentRecord): void {
		records.push(rec);
		if (records.length > 500) records.splice(0, records.length - 500);
	},
	/** The ledger's length now; `since(mark)` lists what this isolate paid after it. */
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

export { formatUsdc };
