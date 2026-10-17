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
import { logEvent } from '../lib/log.ts';
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

export interface TraderQuote {
	text: string;
	sentiment: 'Bullish' | 'Bearish' | null;
}

export interface StocktwitsStats {
	watchlistCount: number | null;
	messagesSampled: number;
	bullish: number;
	bearish: number;
	neutral: number;
	sentimentChange: number | null;
	volumeChange: number | null;
}

/**
 * What the orchestrator sees. The joke-worthy parts come first (price, the
 * room's mood in words, a few colourful quotes); the raw counts sit under
 * `stats` because they are a 30-post sample and make for dull jokes.
 */
export interface StocktwitsSignals {
	symbol: string;
	title: string | null;
	exchange: string | null;
	instrumentClass: string | null;
	liveEvent: boolean;
	latestPrice: string | null;
	priceLow: string | null;
	priceHigh: string | null;
	/** The crowd's mood in plain words, derived from the labelled posts. */
	mood: string;
	/** Up to four of the most quotable recent posts. */
	quotes: TraderQuote[];
	stats: StocktwitsStats;
	note: string;
	payments: PaymentRecord[];
}

/** Picks the posts most likely to be funny: opinionated, labelled, no links, not a wall of cashtags. */
export function pickQuotes(messages: StreamMessage[], sym: string, limit = 4): TraderQuote[] {
	const scored: { q: TraderQuote; score: number }[] = [];
	const seen = new Set<string>();
	for (const m of messages) {
		if (!m.body) continue;
		let text = stripHtml(m.body);
		if (/https?:\/\//i.test(text)) continue;
		if ((text.match(/\$[A-Z]{1,6}/g) ?? []).length > 3) continue;
		text = text.replace(new RegExp(`^(\\$${sym}\\s*)+`, 'i'), '').replace(/^[\s,.:;-]+/, '').trim();
		if (text.length < 25 || text.length > 220) continue;
		const key = text.toLowerCase().slice(0, 60);
		if (seen.has(key)) continue;
		seen.add(key);
		const label = m.entities?.sentiment?.basic;
		const sentiment = label === 'Bullish' || label === 'Bearish' ? label : null;
		let score = 0;
		if (sentiment) score += 1;
		if (/[!?]/.test(text)) score += 1;
		if (/\b(lol|lmao|haha|buddy|folks|boys|clown|moon|rocket|bag|rip|yolo|puts?|calls?|diamond|tendies|pain|crying|screaming|wild|insane|crazy)\b/i.test(text)) score += 1;
		if (text.length >= 50 && text.length <= 180) score += 1;
		if (/^\d[\d.,%\s-]*$/.test(text)) score -= 3;
		scored.push({ q: { text, sentiment }, score });
	}
	return scored.sort((a, b) => b.score - a.score).slice(0, limit).map((s) => s.q);
}

export function describeMood(bullish: number, bearish: number): string {
	const labelled = bullish + bearish;
	if (labelled < 4) return 'quiet, hardly anyone is taking a side';
	const share = bullish / labelled;
	if (share >= 0.85) return 'almost unanimously bullish';
	if (share >= 0.65) return 'mostly bullish';
	if (share > 0.35) return 'split down the middle';
	if (share > 0.15) return 'mostly bearish';
	return 'almost unanimously bearish';
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

/**
 * Free ticker check, run before the agent (and its paid model turns) starts:
 * the free stream endpoint answers 404 "Symbol not found" for a ticker
 * StockTwits does not list, and 200 for one it does. Null means the check
 * could not be made (network, rate limit), and the caller should proceed.
 */
const KNOWN_TTL_MS = 24 * 60 * 60_000;
const UNKNOWN_TTL_MS = 60 * 60_000;
const tickerChecks = new Map<string, { known: boolean; until: number }>();
export async function tickerKnown(symbol: string): Promise<boolean | null> {
	const sym = symbol.toUpperCase().replace(/[^A-Z0-9.]/g, '');
	if (!sym) return false;
	const cached = tickerChecks.get(sym);
	if (cached && cached.until > Date.now()) return cached.known;
	try {
		const res = await fetch(`${STOCKTWITS_GATEWAY}/api/2/streams/symbol/${sym}.json`, { signal: AbortSignal.timeout(5000) });
		if (res.status === 404) {
			tickerChecks.set(sym, { known: false, until: Date.now() + UNKNOWN_TTL_MS });
			return false;
		}
		if (!res.ok) return null;
		await res.body?.cancel();
		tickerChecks.set(sym, { known: true, until: Date.now() + KNOWN_TTL_MS });
		return true;
	} catch {
		return null;
	}
}

export const UNKNOWN_TICKER = 'symbol not found';

async function describeFailure(res: Response): Promise<string> {
	const pr = decodePaymentRequired(res.headers.get('PAYMENT-REQUIRED'));
	if (res.status === 402) return `payment rejected: ${pr?.error ?? 'unknown reason'}`;
	if (res.status === 404) return `${UNKNOWN_TICKER}. StockTwits does not list this ticker; do not retry, tell the user to check the symbol`;
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

	const free = paidDataFetch(`StockTwits streams/symbol/${sym} (free)`);
	const streamRes = await free(`${STOCKTWITS_GATEWAY}/api/2/streams/symbol/${sym}.json`);
	const stream: StreamResponse = streamRes.ok ? ((await streamRes.json()) as StreamResponse) : {};
	const messages = stream.messages ?? [];

	let bullish = 0;
	let bearish = 0;
	let neutral = 0;
	const prices: number[] = [];
	let latestPrice: string | null = null;
	let sentimentChange: number | null = null;
	let volumeChange: number | null = null;
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
	}

	return {
		symbol: sym,
		title: show.symbol?.title ?? null,
		exchange: show.symbol?.exchange ?? null,
		instrumentClass: show.symbol?.instrument_class ?? null,
		liveEvent: show.symbol?.live_event === true,
		latestPrice,
		priceLow: prices.length ? String(Math.min(...prices)) : null,
		priceHigh: prices.length ? String(Math.max(...prices)) : null,
		mood: describeMood(bullish, bearish),
		quotes: pickQuotes(messages, sym),
		stats: { watchlistCount: show.symbol?.watchlist_count ?? null, messagesSampled: messages.length, bullish, bearish, neutral, sentimentChange, volumeChange },
		note: 'stats describe a sample of the 30 latest posts; use the price, mood and quotes for the joke, not the counts.',
		payments: ledger.since(mark),
	};
}

/** What the orchestrator reads: company, price, mood, three quotes. The counts stay in the archive. */
export function signalsForModel(s: StocktwitsSignals) {
	return {
		symbol: s.symbol,
		title: s.title,
		exchange: s.exchange,
		latestPrice: s.latestPrice,
		mood: s.mood,
		quotes: s.quotes.slice(0, 3).map((q) => q.text.slice(0, 160)),
	};
}

/** Created per conversation so the full response can be stored with the joke. */
export const fetchStocktwitsSignals = (conversationId: string) =>
	defineTool({
	name: 'fetch_stocktwits_signals',
	description:
		'Step 1. Pay StockTwits (x402, USDC on Base) for the company behind a ticker and read its latest trader chatter: the price at recent posts, the mood of the room in words, and a few quotable posts. Always call this first; pass its title to search_stock_news.',
	input: v.object({ symbol: v.pipe(v.string(), v.minLength(1), v.maxLength(12)) }),
	durable: true,
	async run({ data, step, log }) {
		logEvent('tool.start', true, { tool: 'fetch_stocktwits_signals', input: data }, { conversationId, label: 'fetch_stocktwits_signals' });
		try {
		const signals = await step.do(`stocktwits:${data.symbol.toUpperCase()}`, () => fetchStocktwitsSignalsFor(data.symbol));
		handoff.setStep(conversationId, 'stocktwits', signals);
		log.info(`StockTwits ${signals.symbol}: ${signals.mood}, latest ${signals.latestPrice ?? 'n/a'}, ${signals.quotes.length} quotes; ${signals.payments.length} payment(s)`);
		logEvent('tool.done', true, { tool: 'fetch_stocktwits_signals', output: signals }, { conversationId, label: 'fetch_stocktwits_signals' });
		return { output: asJson(signalsForModel(signals)) };
		} catch (err) {
			logEvent('tool.error', false, { tool: 'fetch_stocktwits_signals', error: (err as Error).message.slice(0, 400) }, { conversationId, label: 'fetch_stocktwits_signals' });
			throw err;
		}
	},
	});
