import { describe, expect, test } from 'bun:test';
import { matchBuyers } from '../src/lib/buyer.ts';
import type { Transfer } from '../src/lib/transfers.ts';

const t = (hash: string, at: string, usdc = 0.1, direction: 'in' | 'out' = 'in'): Transfer => ({ hash, at, from: '0xbuyer', to: '0xus', usdc, direction, party: direction === 'out' ? 'StockTwits' : '0xbuyer' });

describe('matchBuyers', () => {
	test('picks the 0.10 USDC inflow nearest to the admission time', () => {
		const m = matchBuyers(new Map([['j1', '2026-10-17T05:43:26.495Z']]), [t('0xa', '2026-10-17T05:43:29.000Z'), t('0xb', '2026-10-17T05:19:53.000Z')], 0.1);
		expect(m.get('j1')?.hash).toBe('0xa');
	});

	test('ignores outflows, other amounts and transfers outside the window', () => {
		const m = matchBuyers(new Map([['j1', '2026-10-17T05:43:26.000Z']]), [
			t('0xout', '2026-10-17T05:43:27.000Z', 0.1, 'out'),
			t('0xdeposit', '2026-10-17T05:43:27.000Z', 1),
			t('0xlate', '2026-10-17T05:46:00.000Z'),
			t('0xearly', '2026-10-17T05:42:00.000Z'),
		], 0.1);
		expect(m.size).toBe(0);
	});

	test('allows a transfer timestamped a few seconds before admission', () => {
		const m = matchBuyers(new Map([['j1', '2026-10-17T05:43:26.000Z']]), [t('0xa', '2026-10-17T05:43:20.000Z')], 0.1);
		expect(m.get('j1')?.hash).toBe('0xa');
	});

	test('two jokes in the same minute each get their own transfer, in order', () => {
		const m = matchBuyers(
			new Map([['j2', '2026-10-17T05:43:40.000Z'], ['j1', '2026-10-17T05:43:26.000Z']]),
			[t('0xsecond', '2026-10-17T05:43:43.000Z'), t('0xfirst', '2026-10-17T05:43:29.000Z')],
			0.1,
		);
		expect(m.get('j1')?.hash).toBe('0xfirst');
		expect(m.get('j2')?.hash).toBe('0xsecond');
	});

	test('one transfer is never claimed twice', () => {
		const m = matchBuyers(new Map([['j1', '2026-10-17T05:43:26.000Z'], ['j2', '2026-10-17T05:43:30.000Z']]), [t('0xonly', '2026-10-17T05:43:29.000Z')], 0.1);
		expect(m.get('j1')?.hash).toBe('0xonly');
		expect(m.has('j2')).toBe(false);
	});
});
