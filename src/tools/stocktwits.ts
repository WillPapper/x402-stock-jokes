/**
 * Step 1: StockTwits through the Cloudflare Monetization Gateway preview.
 *
 * Paid (x402 exact, 0.001 USDC): GET /api/2/symbols/show/{SYM}.json — the only
 * origin route the preview serves (trending and friends 404 after payment,
 * verified 2026-10-16). It returns symbol metadata.
 *
 * Free on the same gateway host: GET /api/2/streams/symbol/{SYM}.json — the 30
 * latest messages with per-message Bullish/Bearish labels and the price at
 * post time. That is where the "price movements and sentiment" come from.
 */
import { defineTool } from '@flue/runtime';
import * as v from 'valibot';
import { asJson } from '../lib/json.ts';
import { paidDataFetch } from '../lib/env.ts';
import { handoff } from '../lib/drafts.ts';
import { ledger, type PaymentRecord } from '../lib/ledger.ts';
import { decodePaymentRequired } from '../lib/x402.ts';

export const STOCKTWITS_GATEWAY = 'https://api-staging-mgw.stocktwits.com';

interface ShowResponse {
	symbol?: { symbol?: string; title?: string; exchange?: string; instrument_class?: string; watchlist_count?: number; has_pricing?: boolean; trade_status?: string; live_event?: boolean };
	response?: { status?: number };
}
interface StreamMessage {
	body?: string;
	created_at?: string;
	entities?: { sentiment?: { basic?: string } | null };
	prices?: { symbol?: string; price?: string }[];
	symbols?: { symbol?: string; sentiment_change?: number; volume_change?: number }[];
}
interface StreamResponse {
	messages?: StreamMessage[];
}

export interface StocktwitsSignals {
	symbol: string;
	title: string | null;
	exchange: string | null;
	instrumentClass: string | null;
	watchlistCount: number | null;
	liveEvent: boolean;
	latestPrice: string | null;
	priceLow: string | null;
	priceHigh: string | null;
	messagesSampled: number;
	bullish: number;
	bearish: number;
	neutral: number;
	sentimentChange: number | null;
	volumeChange: number | null;
	sampleMessages: string[];
	payments: PaymentRecord[];
}

function stripHtml(s: string): string {
	return s
		.replace(/<[^>]+>/g, ' ')
		.replace(/&#39;/g, "'")
		.replace(/&quot;/g, '"')
		.replace(/&amp;/g, '&')
		.replace(/\s+/g, ' ')
		.trim();
}

async function describeFailure(res: Response): Promise<string> {
	const pr = decodePaymentRequired(res.headers.get('PAYMENT-REQUIRED'));
	if (res.status === 402) return `payment rejected: ${pr?.error ?? 'unknown reason'}`;
	if (res.status === 403) return `forbidden (the gateway only serves supported countries, or the method is not GET)`;
	if (res.status === 429) return 'rate limited by StockTwits, try again shortly';
	return `HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`;
}

export async function fetchStocktwitsSignalsFor(symbol: string): Promise<StocktwitsSignals> {
	const sym = symbol.toUpperCase().replace(/[^A-Z0-9.]/g, '');
	const mark = ledger.mark();
	const paid = paidDataFetch(`StockTwits symbols/show/${sym}`);

	const showRes = await paid(`${STOCKTWITS_GATEWAY}/api/2/symbols/show/${sym}.json`);
	if (!showRes.ok) throw new Error(`StockTwits symbol lookup for ${sym} failed: ${await describeFailure(showRes)}`);
	const show = (await showRes.json()) as ShowResponse;
	if (show.symbol?.title) handoff.setTitle(sym, show.symbol.title);

	const streamRes = await paid(`${STOCKTWITS_GATEWAY}/api/2/streams/symbol/${sym}.json`);
	const stream: StreamResponse = streamRes.ok ? ((await streamRes.json()) as StreamResponse) : {};
	const messages = stream.messages ?? [];

	let bullish = 0;
	let bearish = 0;
	let neutral = 0;
	const prices: number[] = [];
	let latestPrice: string | null = null;
	let sentimentChange: number | null = null;
	let volumeChange: number | null = null;
	const sampleMessages: string[] = [];
	for (const m of messages) {
		const label = m.entities?.sentiment?.basic;
		if (label === 'Bullish') bullish++;
		else if (label === 'Bearish') bearish++;
		else neutral++;
		const p = m.prices?.find((x) => x.symbol === sym)?.price;
		if (p && !Number.isNaN(Number(p))) {
			if (latestPrice === null) latestPrice = p;
			prices.push(Number(p));
		}
		const s = m.symbols?.find((x) => x.symbol === sym);
		if (s && sentimentChange === null && typeof s.sentiment_change === 'number') sentimentChange = s.sentiment_change;
		if (s && volumeChange === null && typeof s.volume_change === 'number') volumeChange = s.volume_change;
		if (sampleMessages.length < 3 && m.body) {
			const text = stripHtml(m.body);
			if (text.length > 20) sampleMessages.push(text.slice(0, 200));
		}
	}

	return {
		symbol: sym,
		title: show.symbol?.title ?? null,
		exchange: show.symbol?.exchange ?? null,
		instrumentClass: show.symbol?.instrument_class ?? null,
		watchlistCount: show.symbol?.watchlist_count ?? null,
		liveEvent: show.symbol?.live_event === true,
		latestPrice,
		priceLow: prices.length ? String(Math.min(...prices)) : null,
		priceHigh: prices.length ? String(Math.max(...prices)) : null,
		messagesSampled: messages.length,
		bullish,
		bearish,
		neutral,
		sentimentChange,
		volumeChange,
		sampleMessages,
		payments: ledger.since(mark),
	};
}

export const fetchStocktwitsSignals = defineTool({
	name: 'fetch_stocktwits_signals',
	description:
		'Step 1. Pay StockTwits (x402, USDC on Base) for details on a ticker and read its latest trader chatter: price at recent posts, bullish vs bearish counts, sentiment and volume change, sample messages. Always call this first.',
	input: v.object({ symbol: v.pipe(v.string(), v.minLength(1), v.maxLength(12)) }),
	durable: true,
	async run({ data, step, log }) {
		const signals = await step.do(`stocktwits:${data.symbol.toUpperCase()}`, () => fetchStocktwitsSignalsFor(data.symbol));
		log.info(`StockTwits ${signals.symbol}: ${signals.bullish} bullish / ${signals.bearish} bearish, latest ${signals.latestPrice ?? 'n/a'}; ${signals.payments.length} payment(s)`);
		return { output: asJson(signals) };
	},
});
