/**
 * The joke prompt. Pure (no Worker bindings) so scripts can exercise it.
 *
 * The premise comes from company news; the price is optional seasoning; the
 * StockTwits counts never reach the model, because "14 bullish, 2 bearish out
 * of 30 sampled messages" is a market report, not a joke.
 */
export const SYSTEM = [
	'You are a stand-up comedian doing a tight set about the stock market. Write exactly one joke about the company described below.',
	'How to build it: pick the single most specific, surprising or human detail in the NEWS and make it the premise. Set-up, then punchline. The punchline flips or exaggerates what the company did; it does not report it.',
	'Rules: 2 or 3 sentences, at most 55 words. Mention the company or ticker once.',
	'The joke must be about something in the news items. Use the price only if it makes the punchline land, and never use more than one number in total.',
	'Never recite statistics: no sentiment counts, bullish or bearish tallies, watchlist sizes, percentages or volume changes.',
	'A trader quote may appear only if it is funnier than the news; paraphrase it in at most eight quoted words.',
	'Each news item starts with its date and you are told today\'s date. An item older than a month is a past event: joke about what happened then, never say or imply it is pending, upcoming, happening now or "just" happened, and do not guess what came after it.',
	'No financial advice, no slurs, nothing about anyone\'s appearance; do not invent events, products, names or numbers beyond what you were given.',
	'Return only the joke text, no preamble, no quotation marks around it.',
].join(' ');

export interface JokeInput {
	symbol: string;
	company?: string | null;
	/** Company news items, the premise of the joke. */
	news: string[];
	/** Trader quotes, optional colour. */
	chatter?: string[];
	price?: string | null;
	/** Today's date, YYYY-MM-DD, so the model can tell old news from current news. */
	today?: string;
}

/** The facts as stored with the joke and shown under "Based on": news first, then chatter, then the price. */
export function factsFor(input: JokeInput): string[] {
	return [
		...input.news,
		...(input.chatter ?? []).map((q) => `A trader on StockTwits: "${q.replace(/^"|"$/g, '')}"`),
		...(input.price ? [`${input.symbol} last traded at $${String(input.price).replace(/^\$/, '')}`] : []),
	];
}

export function userPrompt(input: JokeInput): string {
	const lines = [`Ticker: ${input.symbol}${input.company ? ` (${input.company})` : ''}`, `Today: ${input.today ?? new Date().toISOString().slice(0, 10)}`];
	lines.push('', 'NEWS (the premise; pick the funniest angle):', ...(input.news.length ? input.news.map((f) => `- ${f}`) : ['- (none found)']));
	if (input.chatter?.length) lines.push('', 'Trader chatter (optional colour, only if funnier than the news):', ...input.chatter.map((q) => `- "${q.replace(/^"|"$/g, '')}"`));
	if (input.price) lines.push('', `Price: $${String(input.price).replace(/^\$/, '')} (optional, use only if the punchline needs it)`);
	return lines.join('\n');
}

/** OpenAI-style chat messages for the AI Gateway /ai/run call. */
export function jokeMessages(input: JokeInput): { role: 'system' | 'user'; content: string }[] {
	return [
		{ role: 'system', content: SYSTEM },
		{ role: 'user', content: userPrompt(input) },
	];
}
