/** Step 2: Ceramic web search, paid per request (x402 exact, 0.001 USDC per query). */
import { defineTool } from '@flue/runtime';
import * as v from 'valibot';
import { asJson } from '../lib/json.ts';
import { paidDataFetch } from '../lib/env.ts';
import { handoff } from '../lib/drafts.ts';
import { ledger, type PaymentRecord } from '../lib/ledger.ts';
import { logEvent } from '../lib/log.ts';
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
	/** Hint for the orchestrator about what the search found. */
	note: string;
	payments: PaymentRecord[];
}

/** One paid Ceramic query, 20 results, short snippets. */
export async function ceramicQuery(query: string, maxResults = 20): Promise<RawNews[]> {
	const paid = paidDataFetch(`Ceramic search "${query.slice(0, 40)}"`);
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
export async function searchNewsFor(symbol: string, companyTitle?: string | null, limit = 6): Promise<NewsSearch> {
	const mark = ledger.mark();
	const sym = symbol.toUpperCase();
	const company = companyKeyword(companyTitle ?? handoff.title(sym), sym);
	const queries = buildNewsQueries(company, sym);
	const raw: RawNews[] = [];
	const failures: string[] = [];
	for (const q of queries) {
		try {
			raw.push(...(await ceramicQuery(q)));
		} catch (err) {
			failures.push(`${q}: ${(err as Error).message}`);
		}
	}
	if (!raw.length && failures.length) throw new Error(failures.join(' | '));
	const ranked = rankNews(raw, { company, symbol: sym, limit });
	const dated = ranked.items.filter((i) => i.date).length;
	const note = ranked.items.length
		? `${ranked.items.length} company news items ranked newest-first (${dated} with a publish date; Ceramic has no date filter, so prefer the dated ones). Listicles, quote pages and "reasons to buy" pieces were removed.`
		: 'No usable company news found; write the joke from the StockTwits chatter instead.';
	return { symbol: sym, company, query: queries.join(' | '), queries, results: ranked.items, dropped: ranked.dropped, rawCount: raw.length, note, payments: ledger.since(mark) };
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
		note: news.results.length ? 'Newest first; undated items may be old. Pick the 2 or 3 most concrete company events.' : news.note,
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
		try {
		const news = await step.do(`ceramic:${data.symbol.toUpperCase()}`, () => searchNewsFor(data.symbol, data.company));
		handoff.setStep(conversationId, 'ceramic', news);
		log.info(`Ceramic: ${news.results.length} of ${news.rawCount} results kept for ${news.company} (${news.queries.length} queries, ${news.payments.length} payment(s))`);
		logEvent('tool.done', true, { tool: 'search_stock_news', output: news }, { conversationId, label: 'search_stock_news' });
		return { output: asJson(newsForModel(news)) };
		} catch (err) {
			logEvent('tool.error', false, { tool: 'search_stock_news', error: (err as Error).message.slice(0, 400) }, { conversationId, label: 'search_stock_news' });
			throw err;
		}
	},
	});
