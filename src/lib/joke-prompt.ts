/**
 * The joke prompt. Pure (no Worker bindings) so scripts can exercise it.
 *
 * The premise comes from company news; the price is optional seasoning; the
 * StockTwits counts never reach the model, because "14 bullish, 2 bearish out
 * of 30 sampled messages" is a market report, not a joke.
 */
export const SYSTEM = [
	'You are a stand-up comedian doing a tight set about the stock market. Write exactly one joke about the company described below.',
	'How to build it: pick the single most specific, surprising or human detail in the NEWS and make it the premise. One sentence of set-up that states the fact plainly, then a punchline that is a new thought, not a restatement: an exaggeration, a literal reading, or a consequence nobody intended. The punchline must contain one concrete image (a thing, a place, someone doing something), never a category.',
	'If the news is dull (a dividend, a filing, a scheduled call, a fund buying shares), the dullness is the premise: joke about a company whose biggest event is that.',
	'Rules: 2 or 3 sentences, at most 55 words. Mention the company or ticker once. Do not open with the date, with "Back in", or with the company name followed by "is" or "was".',
	'Banned, because every joke was using them: "I guess", "I assume", "Apparently", "It turns out", "Turns out", "At this rate", "I can\'t wait", "At least", "basically", "literally", "I mean". No rhetorical questions, no "it\'s like" similes.',
	'The joke must be about something in the news items. Use the price only if it makes the punchline land, and never use more than one number in total.',
	'Never recite statistics: no sentiment counts, bullish or bearish tallies, watchlist sizes, percentages or volume changes.',
	'A trader quote is one anonymous person\'s opinion about the stock, never a fact. It may appear only if it is funnier than the news; paraphrase it in at most eight quoted words, and never repeat anything it claims about a named or identifiable person: their private life, relationships, sexuality, health, honesty or conduct. If the quote is about a person rather than the stock, ignore it.',
	'Each news item starts with its date and how long ago that was. Anything older than a month is history: write it in the past tense, never as pending, upcoming, happening now or "just" happened, and do not guess what came after it. A months-old headline that says something "may" or "might" happen is old speculation, not news of today: joke about the speculating, in the past tense. An item marked "undated" may be years old: past tense, and nothing about it is happening now.',
	'When the prompt says the ticker is listed on an exchange, the company is public today: any item about a possible IPO, a filing to go public or the company still being private is history that has since resolved, so never frame the listing as pending.',
	'No financial advice, no slurs, nothing about anyone\'s appearance, and nothing about a real person\'s private life, sexuality, health or alleged wrongdoing unless a dated news item reports it; do not invent events, products, names or numbers beyond what you were given.',
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
	/** Exchange the ticker trades on (from StockTwits), so the model knows the company is public. */
	exchange?: string | null;
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
	const today = input.today ?? new Date().toISOString().slice(0, 10);
	if (input.exchange) lines.push(`Listed: ${input.symbol} trades on ${input.exchange} today, so the company is public.`);
	lines.push('', 'NEWS (the premise; pick the funniest angle):', ...(input.news.length ? input.news.map((f) => `- ${withAge(f, today)}`) : ['- (none found)']));
	if (input.chatter?.length) lines.push('', 'Trader chatter (optional colour, only if funnier than the news):', ...input.chatter.map((q) => `- "${q.replace(/^"|"$/g, '')}"`));
	if (input.price) lines.push('', `Price: $${String(input.price).replace(/^\$/, '')} (optional, use only if the punchline needs it)`);
	return lines.join('\n');
}

/** "2026-04-08: Musk may use SPCX" → "2026-04-08 (6 months ago): Musk may use SPCX", so the model cannot miss how old an item is. */
export function withAge(fact: string, today: string): string {
	const m = fact.match(/^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?(\s*:)/);
	if (!m) return fact;
	const [y, mo, d] = [Number(m[1]), m[2] ? Number(m[2]) : 7, m[3] ? Number(m[3]) : 15];
	const days = Math.round((Date.parse(today) - Date.UTC(y, mo - 1, d)) / 86_400_000);
	if (Number.isNaN(days) || days < 0) return fact;
	const ago = days <= 7 ? 'this week' : days <= 45 ? `${days} days ago` : days < 365 ? `${Math.round(days / 30)} months ago` : `${(days / 365).toFixed(1)} years ago`;
	const stamp = fact.slice(0, m[0].length - m[4]!.length);
	return `${stamp} (${ago})${fact.slice(stamp.length)}`;
}

/** OpenAI-style chat messages for the AI Gateway /ai/run call. */
export function jokeMessages(input: JokeInput): { role: 'system' | 'user'; content: string }[] {
	return [
		{ role: 'system', content: SYSTEM },
		{ role: 'user', content: userPrompt(input) },
	];
}
