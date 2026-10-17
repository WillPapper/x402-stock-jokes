import { describe, expect, test } from 'bun:test';
import { SYSTEM, factsFor, userPrompt, withAge } from '../src/lib/joke-prompt.ts';

describe('joke prompt', () => {
	test('tells the model today\'s date and keeps news first', () => {
		const p = userPrompt({ symbol: 'SPCX', company: 'SpaceX', news: ['2026-04-17: SpaceX files for its IPO'], price: '145.49', today: '2026-10-17' });
		expect(p.split('\n')[1]).toBe('Today: 2026-10-17');
		expect(p).toContain('- 2026-04-17 (6 months ago): SpaceX files for its IPO');
		expect(p.indexOf('NEWS')).toBeLessThan(p.indexOf('Price:'));
	});
	test('names the exchange so a listed company is never written up as pre-IPO', () => {
		const p = userPrompt({ symbol: 'SPCX', company: 'SpaceX', news: ['2026-04-08: Musk may use SPCX as the IPO ticker'], exchange: 'NASDAQ', today: '2026-10-17' });
		expect(p.split('\n')[2]).toBe('Listed: SPCX trades on NASDAQ today, so the company is public.');
		expect(userPrompt({ symbol: 'SPCX', news: ['x'], today: '2026-10-17' })).not.toContain('Listed:');
		expect(SYSTEM).toMatch(/never frame the listing as pending/);
	});
	test('forbids current-tense framing of old items and statistics', () => {
		expect(SYSTEM).toMatch(/older than a month is history/);
		expect(SYSTEM).toMatch(/pending, upcoming, happening now/);
		expect(SYSTEM).toMatch(/old speculation, not news of today/);
		expect(SYSTEM).toMatch(/Never recite statistics/);
	});
	test('withAge stamps dated facts and leaves the rest alone', () => {
		expect(withAge('2026-10-14: Nike raised guidance', '2026-10-17')).toBe('2026-10-14 (this week): Nike raised guidance');
		expect(withAge('2026-03: Nike beat on Q3', '2026-10-17')).toBe('2026-03 (7 months ago): Nike beat on Q3');
		expect(withAge('2024: Nike signed Caitlin Clark', '2026-10-17')).toBe('2024 (2.3 years ago): Nike signed Caitlin Clark');
		expect(withAge('undated: Nike NFT drop', '2026-10-17')).toBe('undated: Nike NFT drop');
		expect(withAge('NKE last traded at $37', '2026-10-17')).toBe('NKE last traded at $37');
	});
	test('facts list news, then chatter, then price', () => {
		expect(factsFor({ symbol: 'NKE', news: ['2025-09-30: Nike sets Q1 earnings call'], chatter: ['"puts printing"'], price: '$37.14' })).toEqual([
			'2025-09-30: Nike sets Q1 earnings call',
			'A trader on StockTwits: "puts printing"',
			'NKE last traded at $37.14',
		]);
	});
});

describe('joke prompt style', () => {
	test('bans the stock openers and the "Back in" template', () => {
		expect(SYSTEM).toMatch(/"I guess"/);
		expect(SYSTEM).toMatch(/"Back in"/);
		expect(SYSTEM).toMatch(/one concrete image/);
		expect(SYSTEM).toMatch(/dullness is the premise/);
		expect(SYSTEM).not.toMatch(/back in April/);
	});
	test('treats trader chatter as opinion and keeps people’s private lives out', () => {
		expect(SYSTEM).toMatch(/never a fact/);
		expect(SYSTEM).toMatch(/private life, relationships, sexuality, health, honesty or conduct/);
		expect(SYSTEM).toMatch(/nothing about a real person's private life/);
	});
});
