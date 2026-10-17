import { describe, expect, test } from 'bun:test';
import { SYSTEM, factsFor, userPrompt } from '../src/lib/joke-prompt.ts';

describe('joke prompt', () => {
	test('tells the model today\'s date and keeps news first', () => {
		const p = userPrompt({ symbol: 'SPCX', company: 'SpaceX', news: ['2026-04-17: SpaceX files for its IPO'], price: '145.49', today: '2026-10-17' });
		expect(p.split('\n')[1]).toBe('Today: 2026-10-17');
		expect(p).toContain('- 2026-04-17: SpaceX files for its IPO');
		expect(p.indexOf('NEWS')).toBeLessThan(p.indexOf('Price:'));
	});
	test('forbids current-tense framing of old items and statistics', () => {
		expect(SYSTEM).toMatch(/older than a month is a past event/);
		expect(SYSTEM).toMatch(/pending, upcoming, happening now/);
		expect(SYSTEM).toMatch(/Never recite statistics/);
	});
	test('facts list news, then chatter, then price', () => {
		expect(factsFor({ symbol: 'NKE', news: ['2025-09-30: Nike sets Q1 earnings call'], chatter: ['"puts printing"'], price: '$37.14' })).toEqual([
			'2025-09-30: Nike sets Q1 earnings call',
			'A trader on StockTwits: "puts printing"',
			'NKE last traded at $37.14',
		]);
	});
});
