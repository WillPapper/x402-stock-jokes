import { describe, expect, test } from 'bun:test';
import { mergePayments, paymentFromEvent, totalAuthorizedUsdc, type PaymentRecord } from '../src/lib/ledger.ts';

const exactEvent = {
	label: 'Ceramic search "Nintendo stock news"',
	url: 'https://api.ceramic.ai/search',
	ok: true,
	scheme: 'exact',
	authorizedUsdc: '0.001000',
	settled: true,
	attempts: [
		{ status: 402, ids: { 'cf-ray': 'ray-1' }, paymentResponse: null },
		{ status: 200, ids: { 'cf-ray': 'ray-2' }, paymentResponse: { success: true, transaction: '0x' + 'ab'.repeat(32), network: 'eip155:8453' } },
	],
};

const uptoEvent = {
	label: 'AI Gateway orchestrator turn',
	url: 'https://api.cloudflare.com/client/v4/accounts/x/ai/run',
	ok: false,
	scheme: 'upto',
	authorizedUsdc: '0.131072',
	settled: false,
	attempts: [{ status: 504, ids: { 'cf-ray': 'ray-3' }, paymentResponse: null }],
};

describe('paymentFromEvent', () => {
	test('rebuilds a ledger record from an exact payment event', () => {
		const p = paymentFromEvent('2026-10-17T05:20:39.347Z', exactEvent);
		expect(p).toMatchObject({ at: '2026-10-17T05:20:39.347Z', label: exactEvent.label, url: exactEvent.url, scheme: 'exact', authorizedUsdc: '0.001000', settled: true, ray: 'ray-2' });
		expect(p?.tx).toContain('ab'.repeat(32));
	});
	test('keeps an authorized but failed upto turn, unsettled and without a tx', () => {
		const p = paymentFromEvent('2026-10-17T05:25:43.169Z', uptoEvent);
		expect(p).toMatchObject({ scheme: 'upto', authorizedUsdc: '0.131072', settled: false, tx: null, ray: 'ray-3' });
	});
	test('skips a free call', () => {
		expect(paymentFromEvent('2026-10-17T05:20:00.276Z', { ...exactEvent, authorizedUsdc: null })).toBeNull();
	});
});

describe('mergePayments', () => {
	const durable = [paymentFromEvent('2026-10-17T05:20:39.347Z', exactEvent)!, paymentFromEvent('2026-10-17T05:25:43.169Z', uptoEvent)!];
	const mem = (over: Partial<PaymentRecord>): PaymentRecord => ({ at: '2026-10-17T05:28:52.771Z', label: 'AI Gateway orchestrator turn', url: uptoEvent.url, scheme: 'upto', authorizedUsdc: '0.131072', settled: false, tx: null, ray: 'ray-9', ...over });

	test('drops an in-memory record the events already have, by cf-ray', () => {
		const merged = mergePayments(durable, [mem({ at: '2026-10-17T05:25:43.900Z', ray: 'ray-3' })]);
		expect(merged).toHaveLength(2);
	});
	test('matches on url, amount and time when a cf-ray is missing', () => {
		const merged = mergePayments(durable, [mem({ at: '2026-10-17T05:25:45.000Z', ray: null })]);
		expect(merged).toHaveLength(2);
		const later = mergePayments(durable, [mem({ at: '2026-10-17T05:25:50.000Z', ray: null })]);
		expect(later).toHaveLength(3);
	});
	test('adds the closing turn the event write has not landed yet, sorted by time', () => {
		const merged = mergePayments(durable, [mem({})]);
		expect(merged.map((p) => p.at)).toEqual(['2026-10-17T05:20:39.347Z', '2026-10-17T05:25:43.169Z', '2026-10-17T05:28:52.771Z']);
		expect(totalAuthorizedUsdc(merged)).toBe('0.263144');
	});
	test('works with no events at all (D1 unavailable)', () => {
		expect(mergePayments([], [mem({})])).toHaveLength(1);
	});
});
