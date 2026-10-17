/** Step 2: Ceramic web search, paid per request (x402 exact, 0.001 USDC per query). */
import { defineTool } from '@flue/runtime';
import * as v from 'valibot';
import { asJson } from '../lib/json.ts';
import { paidDataFetch } from '../lib/env.ts';
import { ledger, type PaymentRecord } from '../lib/ledger.ts';
import { logEvent } from '../lib/log.ts';
import { setStep, stepOutput } from '../lib/runs.ts';
import { buildNewsQueries, companyKeyword, rankNews, type DropReason, type NewsItem, type RawNews } from '../lib/news.ts';
import { decodePaymentRequired } from '../lib/x402.ts';

export const CERAMIC_SEARCH_URL = 'https://api.ceramic.ai/search';

export interface NewsSearch {
	symbol: string;
	company: string;
	/** All queries joined, kept for older readers of this shape. */
	query: string;
	queries: string[];
	results: NewsItem[];
	/** How many raw results each filter removed, so the ranking can be audited. */
	dropped: Record<DropReason, number>;
	rawCount: number;
	/** Newest full publish date among the kept items; Ceramic's index trails the news, so this is often months old. */
	newestDate: string | null;
	/** Hint for the orchestrator about what the search found. */
	note: string;
	payments: PaymentRecord[];
}

/** One paid Ceramic query, 20 results, short snippets. */
export async function ceramicQuery(query: string, maxResults = 20, conversationId?: string): Promise<RawNews[]> {
	const paid = paidDataFetch(`Ceramic search "${query.slice(0, 40)}"`, conversationId);
	const res = await paid(CERAMIC_SEARCH_URL, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ query, maxResults, maxDescriptionLength: 1000 }),
	});
	if (!res.ok) {
		const pr = decodePaymentRequired(res.headers.get('PAYMENT-REQUIRED'));
		throw new Error(`Ceramic search failed: HTTP ${res.status} ${pr?.error ?? (await res.text()).slice(0, 200)} [cf-ray ${res.headers.get('cf-ray') ?? '-'}]`);
	}
	const body = (await res.json()) as { result?: { results?: RawNews[] }; results?: RawNews[] };
	return body.result?.results ?? body.results ?? [];
}

/**
 * Ceramic is lexical: one query returns evergreen "reasons to buy" pages, so
 * we run three keyword queries (see src/lib/news.ts), merge them, drop
 * listicles and quote pages, and rank dated company events first. Queries run
 * one after another because the paid fetch tracks one pending payment at a time.
 */
export async function searchNewsFor(symbol: string, companyTitle?: string | null, limit = 6, conversationId?: string): Promise<NewsSearch> {
	const mark = ledger.mark();
	const sym = symbol.toUpperCase();
	// When the orchestrator leaves the company out, take it from the StockTwits step of this run.
	const title = companyTitle ?? (conversationId ? (await stepOutput<{ title?: string | null }>(conversationId, 'stocktwits'))?.title : null);
	const company = companyKeyword(title, sym);
	const queries = buildNewsQueries(company, sym);
	const raw: RawNews[] = [];
	const failures: string[] = [];
	for (const q of queries) {
		try {
			raw.push(...(await ceramicQuery(q, 20, conversationId)));
		} catch (err) {
			failures.push(`${q}: ${(err as Error).message}`);
		}
	}
	if (!raw.length && failures.length) throw new Error(failures.join(' | '));
	const now = new Date();
	const ranked = rankNews(raw, { company, symbol: sym, now, limit });
	const note = ranked.items.length
		? `${ranked.items.length} company news items, newest first. ${describeAge(ranked.newest, now)} Listicles, quote pages, undated and older pieces were removed.`
		: 'No usable company news found; write the joke from the StockTwits chatter instead.';
	return { symbol: sym, company, query: queries.join(' | '), queries, results: ranked.items, dropped: ranked.dropped, rawCount: raw.length, newestDate: ranked.newest, note, payments: ledger.since(mark) };
}

/** "The newest item is from 2026-04-17, about 6 months ago; …" so neither model treats it as today's news. */
export function describeAge(newest: string | null, now = new Date()): string {
	if (!newest) return 'None of these items carries a publish date, so they may be old; treat them as past events, not current news.';
	const days = Math.round((now.getTime() - Date.parse(newest)) / 86_400_000);
	const ago = days <= 1 ? 'today' : days < 45 ? `${days} days ago` : days < 365 ? `about ${Math.round(days / 30)} months ago` : `about ${(days / 365).toFixed(1)} years ago`;
	const warn = days > 45 ? ' Nothing newer is in the search index (it trails the news by months), so treat these as past events, not current news.' : '';
	return `The newest item is from ${newest}, ${ago}.${warn}`;
}

/**
 * What the orchestrator reads. Every extra token here is re-sent on each later
 * turn and lengthens Qwen's thinking, so: five items, short snippets, no audit
 * fields. The full NewsSearch goes to the archive and the events log.
 */
export function newsForModel(news: NewsSearch) {
	return {
		company: news.company,
		items: news.results.slice(0, 5).map((r) => ({ date: r.date ?? 'undated', title: r.title.slice(0, 120), source: r.source, snippet: r.description.slice(0, 120) || undefined })),
		today: new Date().toISOString().slice(0, 10),
		note: news.results.length ? `${describeAge(news.newestDate)} Pick the 2 or 3 most concrete company events and keep their dates.` : news.note,
	};
}

/** Created per conversation so the full response can be stored with the joke. */
export const searchStockNews = (conversationId: string) =>
	defineTool({
	name: 'search_stock_news',
	description:
		'Step 2. Pay Ceramic (x402, USDC on Base) for three keyword web searches and get real company news: product launches, deals, lawsuits, earnings, executive changes, each with its source and publish date when known. Call this after fetch_stocktwits_signals with the ticker and the company title it returned. Listicles and "reasons to buy" pages are already filtered out.',
	input: v.object({
		symbol: v.pipe(v.string(), v.minLength(1), v.maxLength(12)),
		company: v.optional(v.pipe(v.string(), v.maxLength(80))),
	}),
	durable: true,
	async run({ data, step, log }) {
		logEvent('tool.start', true, { tool: 'search_stock_news', input: data }, { conversationId, label: 'search_stock_news' });
		await setStep(conversationId, 'search_stock_news', 'running');
		try {
			const news = await step.do(`ceramic:${data.symbol.toUpperCase()}`, () => searchNewsFor(data.symbol, data.company, 6, conversationId));
			await setStep(conversationId, 'search_stock_news', 'done', { output: news });
			log.info(`Ceramic: ${news.results.length} of ${news.rawCount} results kept for ${news.company} (${news.queries.length} queries, ${news.payments.length} payment(s))`);
			logEvent('tool.done', true, { tool: 'search_stock_news', company: news.company, kept: news.results.length, rawCount: news.rawCount, newestDate: news.newestDate, payments: news.payments.length }, { conversationId, label: 'search_stock_news' });
			return { output: asJson(newsForModel(news)) };
		} catch (err) {
			const error = (err as Error).message.slice(0, 400);
			logEvent('tool.error', false, { tool: 'search_stock_news', error }, { conversationId, label: 'search_stock_news' });
			await setStep(conversationId, 'search_stock_news', 'error', { error });
			throw err;
		}
	},
	});
