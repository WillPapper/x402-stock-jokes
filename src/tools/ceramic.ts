/** Step 2: Ceramic web search, paid per request (x402 exact, 0.001 USDC). */
import { defineTool } from '@flue/runtime';
import * as v from 'valibot';
import { asJson } from '../lib/json.ts';
import { paidDataFetch } from '../lib/env.ts';
import { ledger, type PaymentRecord } from '../lib/ledger.ts';
import { decodePaymentRequired } from '../lib/x402.ts';

export const CERAMIC_SEARCH_URL = 'https://api.ceramic.ai/search';

export interface NewsResult {
	title: string;
	url: string;
	description: string;
}
export interface NewsSearch {
	query: string;
	results: NewsResult[];
	payments: PaymentRecord[];
}

export async function searchNewsFor(query: string, limit = 5): Promise<NewsSearch> {
	const mark = ledger.mark();
	const paid = paidDataFetch(`Ceramic search "${query.slice(0, 40)}"`);
	const res = await paid(CERAMIC_SEARCH_URL, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ query }),
	});
	if (!res.ok) {
		const pr = decodePaymentRequired(res.headers.get('PAYMENT-REQUIRED'));
		throw new Error(`Ceramic search failed: HTTP ${res.status} ${pr?.error ?? (await res.text()).slice(0, 200)}`);
	}
	const body = (await res.json()) as { result?: { results?: Partial<NewsResult>[] }; results?: Partial<NewsResult>[] };
	const raw = body.result?.results ?? body.results ?? [];
	return {
		query,
		results: raw.slice(0, limit).map((r) => ({ title: r.title ?? '(untitled)', url: r.url ?? '', description: (r.description ?? '').replace(/\s+/g, ' ').slice(0, 300) })),
		payments: ledger.since(mark),
	};
}

export const searchStockNews = defineTool({
	name: 'search_stock_news',
	description:
		'Step 2. Pay Ceramic (x402, USDC on Base) for a web search and get recent news headlines about the company. Call this after fetch_stocktwits_signals, with a query like "<company name> <TICKER> stock news".',
	input: v.object({ query: v.pipe(v.string(), v.minLength(3), v.maxLength(200)) }),
	durable: true,
	async run({ data, step, log }) {
		const news = await step.do(`ceramic:${data.query}`, () => searchNewsFor(data.query));
		log.info(`Ceramic: ${news.results.length} results for "${data.query}"; ${news.payments.length} payment(s)`);
		return { output: asJson(news) };
	},
});
