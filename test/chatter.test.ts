import { describe, expect, test } from 'bun:test';
import { safeChatter } from '../src/lib/chatter.ts';

describe('safeChatter', () => {
	test('drops claims about a person’s private life, whoever is named', () => {
		const { kept, dropped } = safeChatter([
			'reports are in that Jensen Huang had prior intimate relations with his cousin, who he had previously denied knowing personally.',
			'the CEO is a coke addict and everyone knows it',
			'Lisa Su is cheating on her husband lol',
			'heard the CFO got arrested last night',
			'Musk is gay, change my mind',
		]);
		expect(kept).toEqual([]);
		expect(dropped).toHaveLength(5);
		expect(dropped.every((d) => d.reason === 'personal')).toBe(true);
	});

	test('drops rumours about a person even without the vocabulary', () => {
		const { kept, dropped } = safeChatter(['rumor is Jensen Huang is a fraud and the board knows', 'allegedly he was fired last week and they are hiding it']);
		expect(kept).toEqual([]);
		expect(dropped.map((d) => d.reason)).toEqual(['rumour', 'rumour']);
	});

	test('keeps opinions about the stock, including rude and emotional ones', () => {
		const quotes = [
			'so I was right about the selloff, but why did I sell puts at the top ? FML',
			'this stock is a dumpster fire, bagholders unite',
			'Jensen keeps saying Blackwell is sold out and the chart keeps not caring',
			'management is clueless, earnings call was a snoozefest',
			'the cousin of all rallies is coming, strap in',
		];
		const { kept, dropped } = safeChatter(quotes);
		expect(dropped.map((d) => d.quote)).toEqual(['the cousin of all rallies is coming, strap in']);
		expect(kept).toHaveLength(4);
	});

	test('handles empty input', () => {
		expect(safeChatter(undefined)).toEqual({ kept: [], dropped: [] });
		expect(safeChatter(['', '  '])).toEqual({ kept: [], dropped: [] });
	});
});
