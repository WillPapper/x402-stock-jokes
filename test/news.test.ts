import { describe, expect, test } from 'bun:test';
import { buildNewsQueries, companyKeyword, detectDate, rankNews } from '../src/lib/news.ts';

const now = new Date('2026-10-16T12:00:00Z');

describe('companyKeyword', () => {
	test('strips corporate suffixes', () => {
		expect(companyKeyword('Advanced Micro Devices Inc', 'AMD')).toBe('Advanced Micro Devices');
		expect(companyKeyword('Walt Disney Co', 'DIS')).toBe('Walt Disney');
		expect(companyKeyword('Snowflake Inc, Class A', 'SNOW')).toBe('Snowflake Inc, Class A');
		expect(companyKeyword(null, 'NVDA')).toBe('NVDA');
	});
});

describe('buildNewsQueries', () => {
	test('three distinct keyword queries, ticker only in the first', () => {
		const q = buildNewsQueries('Cloudflare', 'NET', now);
		expect(q).toHaveLength(3);
		expect(q[0]).toBe('Cloudflare NET stock news');
		expect(q[1]).toBe('Cloudflare stock 2026');
		expect(q[2]).not.toContain('NET');
	});
});

describe('detectDate', () => {
	test('from URL paths', () => {
		expect(detectDate('https://www.fool.com/investing/2025/01/21/wall-street-is-bullish/', '', now)).toBe('2025-01-21');
		expect(detectDate('https://www.benzinga.com/news/24/10/41308141/this-analyst', '', now)).toBe('2024-10');
		expect(detectDate('https://www.defenseworld.net/2026/01/20/microsoft-corporation.html', '', now)).toBe('2026-01-20');
		expect(detectDate('https://santamariatimes.marketminute.com/article/predictstreet-2025-12-6-microsoft', '', now)).toBe('2025-12-06');
	});
	test('from snippets, preferring the latest dateline', () => {
		expect(detectDate('https://x.test/a', 'TipRanks Jan. 22, 2026, 12:54 PM Microsoft (MSFT) stock', now)).toBe('2026-01-22');
		expect(detectDate('https://x.test/a', 'Published at December 5th 2025, 11:07 PM EST', now)).toBe('2025-12-05');
		expect(detectDate('https://x.test/a', 'date: Wed, 22 Apr 2026 17:16:05 GMT', now)).toBe('2026-04-22');
		expect(detectDate('https://x.test/a', 'Founded in 1975. © 2026 Benzinga. Posted April 26, 2023 6:34 AM', now)).toBe('2023-04-26');
		expect(detectDate('https://x.test/a', "Microsoft's Blockbuster October 2025: Stock Soars", now)).toBe('2025-10');
	});
	test('falls back to a bare year in the title', () => {
		expect(detectDate('https://x.test/a', 'D23 Announces 2024 Honorees', now, 'D23 Announces 2024 Honorees')).toBe('2024');
		expect(detectDate('https://x.test/a', '© 2026 Benzinga', now, 'No year here')).toBeNull();
	});
	test('ignores future dates and returns null without one', () => {
		expect(detectDate('https://x.test/a', 'Windows Server 2012 ESUs to October 2027', now)).toBeNull();
		expect(detectDate('https://x.test/a', 'nothing here', now)).toBeNull();
	});
});

describe('rankNews', () => {
	const raw = [
		{ title: 'Advanced Micro Devices Inc. (AMD) Stories, News & Mentions | HackerNoon', url: 'https://hackernoon.com/company/amd/news', description: 'Stories, News & Mentions about AMD' },
		{ title: 'This Analyst With 85% Accuracy Rate Sees Around 20% Upside In AMD - Here Are 5 Stock Picks', url: 'https://www.benzinga.com/news/24/10/41308141/x', description: 'AMD' },
		{ title: '3 Reasons Why Microsoft Stock Belongs in Your Portfolio', url: 'https://www.entrepreneur.com/x/368509', description: 'AMD mention' },
		{ title: 'AMD And 2 Other Stocks Insiders Are Selling', url: 'https://www.benzinga.com/news/22/08/28652473/x', description: 'AMD' },
		{ title: 'AMD and OpenAI Announce Strategic Partnership to Deploy 6 Gigawatts of AMD GPUs', url: 'https://ir.amd.com/news-events/press-releases/detail/1260/x', description: 'SANTA CLARA, Calif., Oct. 06, 2025 (GLOBE NEWSWIRE) -- AMD (NASDAQ: AMD)' },
		{ title: 'AMD Fiscal First Quarter 2026 Financial Results', url: 'https://ir.amd.com/events/x', description: 'Webcast audio' },
		{ title: 'Whats Going On With AMD Stock? - Benzinga', url: 'https://www.benzinga.com/news/24/11/42073896/x', description: '' },
		{ title: 'AMD Radeon RX Vega Release Date & Update: Q2 2017 Launch', url: 'https://x.test/vega', description: 'by Guenee Simmons / May 14, 2017' },
		{ title: 'rentals-sunset.rvtrader.com.cdn.cloudflare.net - urlscan.io', url: 'https://urlscan.io/domain/x', description: 'AMD' },
		{ title: 'Nvidia Beats Estimates', url: 'https://x.test/nvda', description: 'Nvidia reported record revenue.' },
		{ title: 'Top Media Stocks for 2026 and How to Invest | The Motley Fool', url: 'https://www.fool.com/investing/2026/02/10/top-media/', description: 'AMD' },
		{ title: 'How to Buy AMD Stock', url: 'https://www.finder.com/x/buy-amd-stock', description: 'AMD' },
		{ title: 'AMD Falls More Steeply Than Broader Market: What Investors Need to Know', url: 'https://finviz.com/news/x', description: 'AMD' },
		{ title: 'AMD layoffs News - WDW News Today', url: 'https://x.test/tag/amd', description: 'AMD' },
		{ title: 'D23 Announces Line Up of 2024 AMD Legends Award Honorees', url: 'https://x.test/d23', description: 'AMD honorees' },
		{ title: 'AMD and OpenAI Announce Strategic Partnership to Deploy 6 Gigawatts of AMD GPUs', url: 'https://www.ir.amd.com/news-events/press-releases/detail/1260/x/', description: 'dup' },
	];
	const ranked = rankNews(raw, { company: 'Advanced Micro Devices', symbol: 'AMD', now, limit: 6 });

	test('keeps real company news and ranks the dated event first', () => {
		expect(ranked.items[0]!.title).toStartWith('AMD and OpenAI Announce');
		expect(ranked.items[0]!.date).toBe('2025-10-06');
		expect(ranked.items[0]!.source).toBe('ir.amd.com');
		expect(ranked.items.map((i) => i.title)).toContain('AMD Fiscal First Quarter 2026 Financial Results');
	});
	test('drops listicles, index pages, junk, off-topic, stale and duplicates', () => {
		const titles = ranked.items.map((i) => i.title).join('\n');
		expect(titles).not.toMatch(/Stories, News/);
		expect(titles).not.toMatch(/Accuracy Rate|Reasons Why|Insiders Are Selling|Going On With/);
		expect(titles).not.toMatch(/urlscan|Nvidia Beats|Vega/);
		expect(titles).not.toMatch(/Top Media|How to Buy|Need to Know|WDW News/);
		expect(ranked.dropped.listicle).toBeGreaterThanOrEqual(7);
		expect(ranked.dropped.index).toBeGreaterThanOrEqual(2);
		expect(ranked.dropped.junk).toBe(1);
		expect(ranked.dropped['off-topic']).toBe(1);
		expect(ranked.dropped.stale).toBe(1);
		expect(ranked.dropped.duplicate).toBe(1);
	});
});
