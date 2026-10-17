/**
 * Which trader quotes may reach the joke model. Pure, tested.
 *
 * A StockTwits post is one anonymous person's opinion about a stock. When it
 * makes a claim about a person instead (their private life, relationships,
 * health, honesty or conduct) it is a rumour at best, and a joke that repeats
 * it is a public statement about a real, named human with a trading forum as
 * its only source. One got through on 2026-10-17 (an "intimate relations" claim
 * about a CEO, lifted from a single post), so such quotes are dropped here,
 * before the prompt, whatever the orchestrator decided.
 */

/** Claims about a person's private life, sexuality, health or conduct. */
const PERSONAL = [
	/\b(sex|sexual|sexually|intimate|intimacy|affair|mistress|lover|romantic|romance|dating|hooked up|sleeping with|slept with|incest|cousin|escort|prostitut|porn|nude|naked|onlyfans|grooming|groomed|pedo|paedo|molest|rape|rapist|assault|harass|abuse|abuser|abusive)\b/i,
	/\b(gay|lesbian|trans|transgender|closeted|cross-?dress)\b/i,
	/\b(cancer|diagnos|dying|terminal|rehab|overdose|cocaine|meth|heroin|addict|junkie|alcoholic|drunk|wasted|mental(ly)? (ill|unstable)|psycho|insane|dementia|senile|stroke|heart attack)\b/i,
	/\b(arrest|indict|convict|felon|criminal|jail|prison|fraudster|scammer|con ?man|crook|thief|stole|embezzl|launder|bribe|pedophile|divorc|custody)\w*|\b(cheated on|cheating on|lawsuit against (him|her|them)|sued (him|her))\b/i,
	/\b(nazi|fascist|racist|bigot|terrorist|jihad|zionist|jew|muslim|hindu|christian|catholic|mormon|cult)\b/i,
];

/** Rumour framing: the post itself says it is passing something on. */
const RUMOUR = /\b(reports? (are|is) in|rumou?r|allegedly|alleged|sources say|i heard|heard that|word is|insider (told|says|said)|leaked|exposed|confirmed that .{0,40}\b(he|she|his|her)\b)\b/i;

/** A person is the subject: a pronoun or a capitalised two-word name next to a claim verb. */
const PERSON_CLAIM = /\b(he|she|his|her|him)\b.{0,40}\b(is a|was a|has been|had|did|got|is|was)\b|\b[A-Z][a-z]+ [A-Z][a-z]+\b.{0,30}\b(is a|was a|has|had|did|got caught|caught)\b/;

export type ChatterVerdict = { kept: string[]; dropped: { quote: string; reason: 'personal' | 'rumour' }[] };

/** Keep quotes about the stock, drop quotes about people. */
export function safeChatter(quotes: readonly string[] | undefined): ChatterVerdict {
	const out: ChatterVerdict = { kept: [], dropped: [] };
	for (const quote of quotes ?? []) {
		const q = quote.trim();
		if (!q) continue;
		if (PERSONAL.some((re) => re.test(q))) out.dropped.push({ quote: q, reason: 'personal' });
		else if (RUMOUR.test(q) && PERSON_CLAIM.test(q)) out.dropped.push({ quote: q, reason: 'rumour' });
		else out.kept.push(q);
	}
	return out;
}
