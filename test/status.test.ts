import { describe, expect, test } from 'bun:test';
import type { JokeRow } from '../src/lib/db.ts';
import type { PaymentRecord } from '../src/lib/ledger.ts';
import type { RunRow } from '../src/lib/runs.ts';
import { STALE_AFTER_MS, statusOf } from '../src/lib/status.ts';

const NOW = Date.parse('2026-10-17T12:00:00.000Z');
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

function run(over: Partial<RunRow> = {}): RunRow {
	return { id: 'j-nvda-abc-1234', ticker: 'NVDA', state: 'running', paidBy: 'password', amountUsdc: null, stepStates: {}, steps: null, turns: 0, lastError: null, failedStep: null, error: null, createdAt: iso(60_000), updatedAt: iso(10_000), finishedAt: null, ...over };
}
const payment: PaymentRecord = { at: iso(30_000), label: 'StockTwits symbols/show/NVDA', url: 'https://x', scheme: 'exact', authorizedUsdc: '0.001000', settled: true, ok: true, tx: 'https://basescan.org/tx/0xaa', ray: 'r1' };
const joke: JokeRow = { id: 'joke-1', conversationId: 'j-nvda-abc-1234', ticker: 'NVDA', title: 'NVIDIA', joke: 'Ha.', facts: ['a', 'b', 'c', 'd'], payments: [payment], totalAuthorizedUsdc: '0.001000', orchestratorModel: null, jokeModel: 'm', paidBy: 'password', steps: null, settled: null, createdAt: iso(5_000) };

describe('statusOf', () => {
	test('nothing recorded is unknown', () => {
		const st = statusOf('nope', null, null, [], NOW);
		expect(st).toMatchObject({ done: false, outcome: 'unknown', joke: null, turns: 0 });
		expect(Object.values(st.steps).every((s) => s.state === 'pending')).toBe(true);
	});
	test('a running run reports its step states, outputs and payments', () => {
		const r = run({ turns: 2, stepStates: { fetch_stocktwits_signals: { state: 'done' }, search_stock_news: { state: 'running' } }, steps: { stocktwits: { title: 'NVIDIA', payments: [payment] } } });
		const st = statusOf(r.id, r, null, [payment], NOW);
		expect(st).toMatchObject({ done: false, outcome: 'working', retrying: false, turns: 2, ticker: 'NVDA', startedAt: r.createdAt, lastEventAt: r.updatedAt });
		expect(st.steps.fetch_stocktwits_signals).toMatchObject({ state: 'done', output: { title: 'NVIDIA' } });
		expect(st.steps.fetch_stocktwits_signals!.receipts).toEqual([payment]);
		expect(st.steps.search_stock_news).toEqual({ state: 'running' });
		expect(st.steps.write_joke).toEqual({ state: 'pending' });
		expect(st.payments).toEqual([{ label: payment.label, authorizedUsdc: '0.001000', scheme: 'exact', tx: payment.tx, ok: true, at: payment.at }]);
	});
	test('a failed turn marks the run as retrying until something succeeds', () => {
		const st = statusOf('x', run({ lastError: 'AI Gateway 504' }), null, [], NOW);
		expect(st).toMatchObject({ done: false, outcome: 'working', retrying: true, lastError: 'AI Gateway 504' });
	});
	test('a done run carries the joke row', () => {
		const st = statusOf('x', run({ state: 'done', finishedAt: iso(5_000) }), joke, [payment], NOW);
		expect(st).toMatchObject({ done: true, outcome: 'completed', joke: 'Ha.', basedOn: 'a; b; c', jokeId: 'joke-1', retrying: false, lastError: null });
	});
	test('a failed run reports the step that failed and why', () => {
		const r = run({ state: 'failed', error: 'symbol not found', failedStep: 'fetch_stocktwits_signals', stepStates: { fetch_stocktwits_signals: { state: 'error', error: 'symbol not found' } } });
		const st = statusOf('x', r, null, [], NOW);
		expect(st).toMatchObject({ done: true, outcome: 'failed', error: 'symbol not found', failedStep: 'fetch_stocktwits_signals' });
		expect(st.steps.fetch_stocktwits_signals).toEqual({ state: 'error', detail: 'symbol not found' });
	});
	test('a run nobody touched for 20 minutes is reported failed', () => {
		expect(statusOf('x', run({ updatedAt: iso(STALE_AFTER_MS + 1) }), null, [], NOW)).toMatchObject({ done: true, outcome: 'failed', error: 'no progress for 20 minutes' });
		expect(statusOf('x', run({ state: 'queued', updatedAt: iso(STALE_AFTER_MS + 1) }), null, [], NOW)).toMatchObject({ done: true, outcome: 'failed', error: 'the run never started' });
		expect(statusOf('x', run({ updatedAt: iso(STALE_AFTER_MS - 1) }), null, [], NOW)).toMatchObject({ done: false, outcome: 'working' });
	});
	test('a joke row without a runs row (history) is completed with every step done', () => {
		const st = statusOf('x', null, joke, [payment], NOW);
		expect(st).toMatchObject({ done: true, outcome: 'completed', joke: 'Ha.', startedAt: joke.createdAt });
		expect(Object.values(st.steps).every((s) => s.state === 'done')).toBe(true);
	});
});
