/**
 * Turning Ceramic search results into company news worth joking about.
 *
 * Ceramic is a lexical engine (exact keyword matching, no date filter, no
 * intent), so one "<TICKER> stock news" query returns evergreen SEO pages:
 * "5 reasons to buy", quote pages, analyst round-ups from 2023. The docs'
 * advice is several keyword queries and local ranking; this module does
 * exactly that: builds the queries, drops listicles and index pages, detects a
 * publish date from the URL or snippet, and ranks real company events first.
 */

export interface RawNews {
	title?: string;
	url?: string;
	description?: string;
}

export interface NewsItem {
	title: string;
	url: string;
	source: string;
	/** Publish date as YYYY-MM-DD, YYYY-MM or YYYY when one was found in the URL, snippet or title; null otherwise. */
	date: string | null;
	description: string;
}

export type DropReason = 'duplicate' | 'listicle' | 'index' | 'junk' | 'off-topic' | 'stale';

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const CORPORATE_SUFFIX = /[,\s]+(inc|incorporated|corp|corporation|co|company|ltd|limited|plc|llc|holdings?|group|sa|nv|ag|se)\.?$/i;

/** "Advanced Micro Devices Inc" → "Advanced Micro Devices"; "Walt Disney Co" → "Walt Disney". */
export function companyKeyword(title: string | null | undefined, symbol: string): string {
	let name = (title ?? '').trim();
	for (let i = 0; i < 2 && CORPORATE_SUFFIX.test(name); i++) name = name.replace(CORPORATE_SUFFIX, '').trim();
	name = name.replace(/[(),.]+$/g, '').trim();
	return name || symbol;
}

/**
 * Three keyword queries, per Ceramic's best practices (specific entities, no
 * filler, explicit synonyms with OR). The ticker is kept out of two of them
 * because short tickers are poor lexical tokens ("NET" matches .NET and
 * cloudflare.net pages).
 */
export function buildNewsQueries(company: string, symbol: string, now = new Date()): string[] {
	const year = now.getUTCFullYear();
	const q = [
		`${company} ${symbol} stock news`,
		`${company} stock ${year}`,
		`${company} announces OR unveils OR acquires OR partnership OR lawsuit OR layoffs`,
	];
	return [...new Set(q.map((s) => s.replace(/\s+/g, ' ').trim()))];
}

const LISTICLE = [
	/\b(\d+|two|three|four|five|six|seven|eight|nine|ten)\s+(reasons?|stocks?|things|ways|picks|top|best|charts?|numbers)\b/i,
	/\b(top|best)\b.{0,30}\b(stocks?|picks|etfs?|investments?)\b/i,
	/\bhow to (buy|invest|trade)\b/i,
	/\bwhat investors need to know\b|\bneed to know\b.{0,20}\binvestors\b/i,
	/\b(should you|is it time to|time to|when to)\s+(buy|sell)\b/i,
	/\bis\b.{0,50}\b(a buy|a sell|a good (buy|investment)|worth buying|the best)/i,
	/\b(stocks?|shares) (to|you can|worth) (buy|watch|sell|avoid|own|hold)\b/i,
	/\breasons? (to|why|for) (buy|sell|own|avoid|invest)/i,
	/\bwhy\b.{0,50}\b(is|could be|remains?|looks? like) a (buy|strong buy|sell|bargain)/i,
	/\b(price prediction|forecast 20\d{2}|price target|stock forecast|where will it be)\b/i,
	/\b\d+% upside\b|\baccuracy rate\b|\bstock picks?\b|\btrading ideas?\b/i,
	/\bwhat'?s going on with\b|\bwhat is going on with\b/i,
	/\b(insiders|executives) are (selling|buying)\b/i,
	/\bstocks? (moving|showing|whale|unusual)\b.*\bsession\b/i,
	/\banalyst(s)? (forecasts?|offer insights|are bullish|says?|asserts?)\b/i,
	/\bbelongs in your portfolio\b|\bmillionaire\b|\bget rich\b|\bmake you rich\b/i,
	/\bvs\.?\b.{0,40}\bwhich (is|stock)\b/i,
	/\bstocks? (stand out|in the spotlight|on investors'? radar)\b/i,
];
const INDEX_PAGE = [
	/\bstories, news (&|and) mentions\b/i,
	/\b(stock )?(price|quote)s?,? (live chart|history|news|quote|forecast|analysis|market cap|how to buy)\b/i,
	/\bnews (&|and) (articles|analysis|updates|headlines)\b/i,
	/\blatest (stock )?news\b.*\b(updates|articles)\b/i,
	/\b(company|stock) (information|overview|profile)\b/i,
	/\breal-time price\b|\bhistorical performance\b|\bprice chart\b/i,
	/\b(buy|how to buy)\b.{0,20}\bstock\b.*\b(price|quote)\b/i,
	/\b(annual report|10-k|10-q|8-k|form 4|statement of changes|proxy statement)\b/i,
	/\bwikipedia\b|\boptions? etp\b|\bcfd\b/i,
	/\b(news|headlines|updates) - [\w .&'’]+$/i,
];
const JUNK_HOSTS = /(^|\.)(urlscan\.io|wikipedia\.org|defenseworld\.net|marketbeat\.com|simply-invest\.info|spreaker\.com|feedburner\.com)$/i;
const INDEX_PATH = /\/(quote|quotes|symbol|symbols|stocks?|company|companies|news|forecasts?)\/[A-Za-z0-9.\-]+\/?$|\/(news|blog|feed)\/?$/i;

export function hostOf(url: string): string {
	try {
		return new URL(url).hostname.replace(/^www\./, '');
	} catch {
		return '';
	}
}

function monthIndex(name: string): number {
	const m = name.toLowerCase().slice(0, 3);
	return MONTHS.findIndex((x) => x.startsWith(m));
}
const pad = (n: number) => String(n).padStart(2, '0');

/**
 * Finds a publish date in the URL path (/2026/01/20/, Benzinga's /26/01/<id>,
 * 2026-01-20) or in the snippet ("Jan. 22, 2026", "December 5th 2025",
 * "22 April 2026"). Returns YYYY-MM-DD, YYYY-MM, or null. Dates in the future
 * relative to `now` are ignored (they are usually fiscal-year labels).
 */
export function detectDate(url: string, text: string, now = new Date(), title = ''): string | null {
	const candidates: string[] = [];
	const push = (y: number, m: number, d?: number) => {
		if (y < 2000 || m < 1 || m > 12) return;
		if (d !== undefined && (d < 1 || d > 31)) return;
		const iso = d !== undefined ? `${y}-${pad(m)}-${pad(d)}` : `${y}-${pad(m)}`;
		const t = Date.UTC(y, m - 1, d ?? 1);
		if (t > now.getTime() + 2 * 86_400_000) return;
		candidates.push(iso);
	};
	let path = '';
	try {
		path = new URL(url).pathname;
	} catch {
		path = url;
	}
	let m: RegExpExecArray | null;
	if ((m = /\/(20\d{2})[/-](\d{1,2})(?:[/-](\d{1,2}))?(?=[/-]|$)/.exec(path))) push(+m[1]!, +m[2]!, m[3] ? +m[3]! : undefined);
	else if ((m = /\/(2[0-9])\/(\d{2})\/\d{5,}/.exec(path))) push(2000 + +m[1]!, +m[2]!);
	else if ((m = /(20\d{2})-(\d{2})-(\d{2})/.exec(path))) push(+m[1]!, +m[2]!, +m[3]!);
	else if ((m = /-(20\d{2})-(\d{1,2})-(\d{1,2})-/.exec(path))) push(+m[1]!, +m[2]!, +m[3]!);
	if (candidates.length) return candidates[0]!;

	const t = text.replace(/\s+/g, ' ');
	const monthRe = '(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?';
	const re1 = new RegExp(`\\b${monthRe}\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(20\\d{2})\\b`, 'gi'); // Jan. 22, 2026
	const re2 = new RegExp(`\\b(\\d{1,2})\\s+${monthRe}\\s+(20\\d{2})\\b`, 'gi'); // 22 April 2026
	const re3 = new RegExp(`\\b${monthRe}\\s+(20\\d{2})\\b`, 'gi'); // October 2025
	const re4 = /\b(20\d{2})-(\d{2})-(\d{2})\b/g;
	for (const mm of t.matchAll(re1)) push(+mm[3]!, monthIndex(mm[1]!) + 1, +mm[2]!);
	for (const mm of t.matchAll(re2)) push(+mm[3]!, monthIndex(mm[2]!) + 1, +mm[1]!);
	for (const mm of t.matchAll(re4)) push(+mm[1]!, +mm[2]!, +mm[3]!);
	if (!candidates.length) for (const mm of t.matchAll(re3)) push(+mm[2]!, monthIndex(mm[1]!) + 1);
	if (!candidates.length) {
		// Last resort: a bare year in the title ("2024 Disney Legends Award Honorees").
		const y = /\b(20[0-3]\d)\b/.exec(title);
		if (y && +y[1]! <= now.getUTCFullYear()) return y[1]!;
		return null;
	}
	// Snippets often carry several dates (copyright lines, old references); the latest one is usually the dateline.
	return candidates.sort().at(-1)!;
}

function canonical(url: string): string {
	try {
		const u = new URL(url);
		return `${u.hostname.replace(/^www\./, '')}${u.pathname.replace(/\/+$/, '')}`.toLowerCase();
	} catch {
		return url.toLowerCase();
	}
}

function cleanSnippet(s: string, title: string): string {
	let t = s.replace(/\s+/g, ' ').trim();
	if (title && t.toLowerCase().startsWith(title.toLowerCase().slice(0, 30))) t = t.slice(title.length).trim();
	t = t.replace(/^[\s|·\-–—:]+/, '');
	if (/^(benzinga|skip to|home news|search|menu|sign in|log in|subscribe)\b/i.test(t) || /benzinga research my stocks/i.test(t)) return '';
	return t.slice(0, 180);
}

const EVENT_WORDS = /\b(announces?|announced|unveils?|unveiled|launch(es|ed)?|acquires?|acquisition|partnership|partners? with|deal|lawsuit|sued|fined?|probe|investigation|regulators?|outage|recall|layoffs?|cuts? jobs|hires?|departure|resigns?|steps down|names? (new )?ceo|earnings|quarter|revenue|guidance|beats?|misses?|rallies|surges?|jumps?|plunges?|falls?|slides?|tumbles|soars?|record|strike|union|antitrust|ban|approval|fda|delay|shortage|expands?|opens?|closes?|shuts?|invests?|investment|buyback|dividend|split|ipo|merger)\b/i;
const ANALYST_WORDS = /\b(analyst|rating|upgrade[sd]?|downgrade[sd]?|price target|initiated|reiterates?|coverage|overweight|underweight|outperform)\b/i;

export interface RankedNews {
	items: NewsItem[];
	dropped: Record<DropReason, number>;
}

/**
 * Dedupes, filters and ranks raw results. Scoring: a date in the last month
 * beats everything; undated items sit between recent and old ones; concrete
 * company events rank above analyst-rating pieces; items more than three
 * years old are dropped as stale. Items whose title and snippet never mention
 * the company or ticker are dropped as off-topic.
 */
export function rankNews(raw: RawNews[], opts: { company: string; symbol: string; now?: Date; limit?: number }): RankedNews {
	const now = opts.now ?? new Date();
	const limit = opts.limit ?? 6;
	const dropped: Record<DropReason, number> = { duplicate: 0, listicle: 0, index: 0, junk: 0, 'off-topic': 0, stale: 0 };
	const seen = new Set<string>();
	const company = opts.company.toLowerCase();
	const companyFirst = company.split(/\s+/)[0] ?? company;
	const symbolRe = new RegExp(`\\b\\$?${opts.symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
	const scored: { item: NewsItem; score: number }[] = [];

	for (const r of raw) {
		const title = (r.title ?? '').replace(/\s+/g, ' ').trim();
		const url = r.url ?? '';
		const desc = (r.description ?? '').replace(/\s+/g, ' ').trim();
		if (!title || !url) {
			dropped.junk++;
			continue;
		}
		const key = canonical(url);
		const titleKey = title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 80);
		if (seen.has(key) || seen.has(titleKey)) {
			dropped.duplicate++;
			continue;
		}
		seen.add(key);
		seen.add(titleKey);
		const host = hostOf(url);
		let path = '';
		try {
			path = new URL(url).pathname;
		} catch {
			/* keep empty */
		}
		const letters = title.replace(/[^A-Za-z]/g, '');
		const allCaps = letters.length > 12 && letters === letters.toUpperCase(); // decades-old wire copy
		if (allCaps || JUNK_HOSTS.test(host) || /^xml\b/i.test(desc) || /\.(xml|rss)$/i.test(path) || /\/feed\/?$/i.test(path) || !/^https?:/.test(url)) {
			dropped.junk++;
			continue;
		}
		const haystack = `${title} ${desc}`.toLowerCase();
		if (!haystack.includes(company) && !haystack.includes(companyFirst) && !symbolRe.test(`${title} ${desc}`)) {
			dropped['off-topic']++;
			continue;
		}
		if (LISTICLE.some((re) => re.test(title))) {
			dropped.listicle++;
			continue;
		}
		if (INDEX_PAGE.some((re) => re.test(title)) || INDEX_PATH.test(path)) {
			dropped.index++;
			continue;
		}
		const date = detectDate(url, `${title} ${desc}`, now, title);
		let ageDays: number | null = null;
		if (date) {
			const [y, m, d] = date.split('-').map(Number);
			ageDays = (now.getTime() - Date.UTC(y!, (m ?? 7) - 1, d ?? 15)) / 86_400_000;
		}
		if (ageDays !== null && ageDays > 3 * 365) {
			dropped.stale++;
			continue;
		}
		let score = 0;
		const yearOnly = date !== null && date.length === 4;
		if (ageDays === null) score += 40;
		else if (yearOnly) score += ageDays <= 400 ? 45 : 20; // a bare year is weak evidence: just above undated
		else if (ageDays <= 31) score += 100;
		else if (ageDays <= 120) score += 70;
		else if (ageDays <= 400) score += 50;
		else score += 20;
		if (EVENT_WORDS.test(title)) score += 25;
		if (ANALYST_WORDS.test(title)) score -= 20;
		if (title.toLowerCase().includes(companyFirst)) score += 10;
		if (/benzinga|businessinsider|reuters|bloomberg|cnbc|wsj|ft\.com|theverge|techcrunch|apnews|investorplace|fool\.com|marketwatch|barrons|yahoo/i.test(host)) score += 5;
		scored.push({ item: { title: title.slice(0, 160), url, source: host, date, description: cleanSnippet(desc, title) }, score });
	}
	scored.sort((a, b) => b.score - a.score);
	return { items: scored.slice(0, limit).map((s) => s.item), dropped };
}
