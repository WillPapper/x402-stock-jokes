/**
 * Basescan links for settled payments. The transaction hash comes from the
 * seller's PAYMENT-RESPONSE header, so it is third-party input: only a real
 * 32-byte hex hash becomes a link, anything else becomes no link at all.
 */
const TX_HASH = /^0x[0-9a-fA-F]{64}$/;

export function basescanTxUrl(hash: unknown): string | null {
	return typeof hash === 'string' && TX_HASH.test(hash) ? `https://basescan.org/tx/${hash.toLowerCase()}` : null;
}
