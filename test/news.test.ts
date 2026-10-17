import { describe, expect, test } from 'bun:test';
import { buildNewsQueries, companyKeyword, detectDate, rankNews } from '../src/lib/news.ts';

const now = new Date('2026-10-16T12:00:00Z');

describe('companyKeyword', () => {
	test('strips corporate suffixes', () => {
		expect(companyKeyword('Advanced Micro Devices Inc', 'AMD')).toBe('Advanced Micro Devices');
		expect(companyKeyword('Walt Disney Co', 'DIS')).toBe('Walt Disney');
		expect(companyKeyword('Snowflake Inc, Class A', 'SNOW')).toBe('Snowflake');
		expect(companyKeyword('Nintendo Co. Ltd - ADR', 'NTDOY')).toBe('Nintendo');
		expect(companyKeyword('SK Hynix Inc - ADR', 'SKHY')).toBe('SK Hynix');
		expect(companyKeyword('Oracle Corp.', 'ORCL')).toBe('Oracle');
		expect(companyKeyword('AT&T Inc', 'T')).toBe('AT&T');
		expect(companyKeyword('Vanguard Total Bond Market ETF', 'BND')).toBe('Vanguard Total Bond Market ETF');
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
		{ title: 'Star Tribune - AMD (NASDAQ:AMD) Stock Quote', url: 'https://markets.financialcontent.com/startribune/quote?Symbol=AMD', description: 'AMD' },
		{ title: 'AMD Stock (AMD) Option Chain - StockScan', url: 'https://stockscan.io/stocks/AMD/options', description: 'AMD' },
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
		expect(titles).not.toMatch(/Top Media|How to Buy|Need to Know|WDW News|Stock Quote|Option Chain/);
		expect(ranked.dropped.listicle).toBeGreaterThanOrEqual(7);
		expect(ranked.dropped.index).toBeGreaterThanOrEqual(4);
		expect(ranked.dropped.junk).toBe(1);
		expect(ranked.dropped['off-topic']).toBe(1);
		expect(ranked.dropped.stale).toBe(2); // 2017 Vega piece and the 2024 D23 awards page (18-month cutoff)
		expect(ranked.dropped.duplicate).toBe(1);
	});
	test('reports the newest full date', () => {
		expect(ranked.newest).toBe('2025-10-06');
	});
});

describe('rankNews recency gate', () => {
	const nike = [
		{ title: 'NIKE, Inc. Announces First Quarter Fiscal 2026 Earnings and Conference Call', url: 'https://www.businesswire.com/news/home/20250828728146/en/x', description: 'BEAVERTON, Ore., Aug. 28, 2025 Nike' },
		{ title: 'Nike Unveils First .Swoosh NFT Digital Sneaker Drop - Decrypt', url: 'https://decrypt.co/137011/nike-unveils-first-swoosh-nft', description: 'Nike digital sneakers' },
		{ title: 'Nike Announces Top 24 Teams for Nike Track Nationals', url: 'https://www.milesplit.com/articles/46879', description: 'Nike track' },
		{ title: 'Nike Stock After Q2 2026 Earnings China Sales Drop', url: 'https://successknocks.com/nike-q2-2026/', description: 'Nike' },
		{ title: 'Nike Sues Lululemon Over At-Home Mirror Gym', url: 'https://www.benzinga.com/news/22/01/24923345/nike-sues-lululemon', description: 'Nike' },
	];
	test('once a dated item is recent enough, undated items and much older ones are dropped', () => {
		const r = rankNews(nike, { company: 'Nike', symbol: 'NKE', now, limit: 6 });
		const titles = r.items.map((i) => i.title).join('\n');
		expect(titles).toContain('First Quarter Fiscal 2026');
		expect(titles).toContain('Q2 2026'); // a bare current year is kept, just ranked low
		expect(titles).not.toMatch(/NFT|Track Nationals|Lululemon/);
		expect(r.dropped.undated).toBe(2);
		expect(r.dropped.stale).toBe(1); // 2022 is past 18 months
		expect(r.newest).toBe('2025-08-28');
	});
	test('with no dated anchor, undated items survive and newest is null', () => {
		const r = rankNews(nike.slice(1, 3), { company: 'Nike', symbol: 'NKE', now, limit: 6 });
		expect(r.items).toHaveLength(2);
		expect(r.dropped.undated).toBe(0);
		expect(r.newest).toBeNull();
	});
	test('round-ups that mention the company only deep in the snippet, and investor guides, are dropped', () => {
		const filler = 'Bitcoin fell below $100,000 as altcoins slid. '.repeat(6);
		const raw = [
			{ title: 'Daily News | BTC Experiences Short-term Sell-off', url: 'https://gate.com/2026/04/21/daily', description: `${filler} Meanwhile SpaceX filed its S-1.` },
			{ title: 'SpaceX IPO: The Ultimate Investors Guide to the Stars', url: 'https://ai-stocks.com/2025/09/28/spacex-ipo-guide/', description: 'SpaceX' },
			{ title: 'SpaceX IPO 2026 Explained: How Indians Can Apply and Invest', url: 'https://newsx.com/spacex-ipo-2026-explained', description: 'SpaceX' },
			{ title: 'Bloomberg analyst: Musk may use SPCX as the SpaceX ticker', url: 'https://x.test/2026/04/08/spcx', description: 'SpaceX IPO ticker' },
			{ title: 'Naoris Protocol token price - NAORIS crypto - NAORIS live chart - NAORIS news', url: 'https://cointeeth.com/2026/04/08/naoris', description: 'SpaceX mention up front' },
		];
		const r = rankNews(raw, { company: 'SpaceX', symbol: 'SPCX', now, limit: 6 });
		expect(r.items.map((i) => i.title)).toEqual(['Bloomberg analyst: Musk may use SPCX as the SpaceX ticker']);
		expect(r.dropped['off-topic']).toBe(1);
		expect(r.dropped.listicle).toBe(2);
		expect(r.dropped.index).toBe(1);
	});
	test('an item far older than the newest is dropped as old', () => {
		const raw = [
			{ title: 'Acme announces layoffs', url: 'https://x.test/2026/09/01/acme-layoffs', description: 'Acme' },
			{ title: 'Acme opens new plant', url: 'https://x.test/2025/09/01/acme-plant', description: 'Acme' },
		];
		const r = rankNews(raw, { company: 'Acme', symbol: 'ACME', now, limit: 6 });
		expect(r.items.map((i) => i.title)).toEqual(['Acme announces layoffs']);
		expect(r.dropped.old).toBe(1);
	});
});
