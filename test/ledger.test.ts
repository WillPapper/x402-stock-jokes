import { describe, expect, test } from 'bun:test';
import { paymentRecord, totalAuthorizedUsdc } from '../src/lib/ledger.ts';
import type { PaymentEvent } from '../src/lib/x402.ts';

const base: PaymentEvent = {
	label: 'Ceramic search "Nintendo stock news"',
	url: 'https://api.ceramic.ai/search',
	method: 'POST',
	ok: true,
	finalStatus: 200,
	scheme: 'exact',
	authorizedUsdc: '0.001000',
	settled: true,
	receipt: { success: true, transaction: '0x' + 'ab'.repeat(32), network: 'eip155:8453' },
	ray: 'ray-2',
	payer: '0xpayer',
	attempts: [],
	totalMs: 900,
};

describe('paymentRecord', () => {
	test('builds a record from an exact payment, with the Basescan link', () => {
		const p = paymentRecord(base.label, base);
		expect(p).toMatchObject({ label: base.label, url: base.url, scheme: 'exact', authorizedUsdc: '0.001000', settled: true, ok: true, ray: 'ray-2' });
		expect(p?.tx).toBe(`https://basescan.org/tx/0x${'ab'.repeat(32)}`);
	});
	test('keeps an authorized but failed upto turn, unsettled and without a tx', () => {
		const p = paymentRecord('AI Gateway orchestrator turn', { ...base, url: 'https://api.cloudflare.com/client/v4/accounts/0123456789abcdef0123456789abcdef/ai/run', ok: false, finalStatus: 504, scheme: 'upto', authorizedUsdc: '0.131072', settled: false, receipt: null, ray: 'ray-3' });
		expect(p).toMatchObject({ scheme: 'upto', authorizedUsdc: '0.131072', settled: false, ok: false, tx: null, ray: 'ray-3' });
	});
	test('strips the Cloudflare account id from the stored URL', () => {
		const p = paymentRecord('turn', { ...base, url: 'https://api.cloudflare.com/client/v4/accounts/0123456789abcdef0123456789abcdef/ai/run', scheme: null });
		expect(p?.url).toBe('https://api.cloudflare.com/client/v4/accounts/<account>/ai/run');
		expect(p?.scheme).toBe('upto');
	});
	test('skips a free call', () => {
		expect(paymentRecord('free', { ...base, authorizedUsdc: null })).toBeNull();
	});
	test('totals authorized amounts to six decimals', () => {
		const a = paymentRecord('a', base)!;
		const b = paymentRecord('b', { ...base, authorizedUsdc: '0.131072' })!;
		expect(totalAuthorizedUsdc([a, b])).toBe('0.132072');
	});
});
