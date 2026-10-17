// Runs the joke prompt (src/lib/joke-prompt.ts) against AI Gateway for a few
// fixed fact sets, so prompt changes can be judged side by side before they
// ship. Pays AI Gateway with x402 like the Worker does (about 0.003 USDC a joke).
// Usage: bun scripts/joke-probe.ts [jokes per set, default 2] [model]
import { Budget, usdToBaseUnits } from '../src/lib/budget.ts';
import { jokeMessages, type JokeInput } from '../src/lib/joke-prompt.ts';
import { createPaidFetch } from '../src/lib/x402.ts';
import { loadDevVars, privateKey, requireEnv, workerVars } from './_env.ts';

loadDevVars();
const perSet = Number(process.argv[2] ?? 2);
const model = process.argv[3] ?? workerVars().JOKE_MODEL ?? 'google/gemma-4-26b-a4b-it';
const today = new Date().toISOString().slice(0, 10);
const sets: JokeInput[] = [
	{ symbol: 'LYFT', company: 'Lyft', exchange: 'NASDAQ', today, price: '16.70', news: ['2026-02: Lyft stock drops after Q4 earnings, CEO says AV deployments in 2026', '2026-02-10: Lyft quarterly earnings show record profit, but a revenue miss triggers a stock slide'] },
	{ symbol: 'NTDOY', company: 'Nintendo', exchange: 'OTC', today, price: '13.38', news: ['2026-04-03: Nintendo announces new Super Mario Bros. movie and games', '2025-11-14: Nintendo unveils The Super Mario Galaxy Movie trailer'], chatter: ['rise fallen champion. Back to $20 for the holidays.'] },
	{ symbol: 'BRK.B', company: 'Berkshire Hathaway', exchange: 'NYSE', today, news: ['2026-01-01: Investment chief Todd Combs exits Berkshire to join JPMorgan, ending his decade-plus tenure', '2026-03: Buffett\'s Q4 bet on oil pays off as Berkshire\'s position in Chevron climbs'], chatter: ['My "Warrens" increase in value by $1,000.00 every time BRK goes up $1.'] },
	{ symbol: 'T', company: 'AT&T', exchange: 'NYSE', today, price: '23.43', news: ['undated: AT&T announces a $250 billion commitment to advance U.S. connectivity', 'undated: Starbucks and AT&T announce a Wi-Fi partnership'] },
];
const paid = createPaidFetch({ privateKey: privateKey(), budget: new Budget(usdToBaseUnits('0.25'), usdToBaseUnits('0.5')), maxUsdPerPayment: '$0.25' });
const url = `https://api.cloudflare.com/client/v4/accounts/${requireEnv('CLOUDFLARE_ACCOUNT_ID')}/ai/run`;
for (const input of sets) {
	console.log(`\n=== ${input.symbol}: ${input.news.join(' | ')}`);
	for (let i = 0; i < perSet; i++) {
		const body = JSON.stringify({ model, input: { messages: jokeMessages(input), max_tokens: 400, temperature: 1.0, ...(model.startsWith('openai/') ? { reasoning_effort: 'low' } : { chat_template_kwargs: { enable_thinking: false } }) } });
		const res = await paid(url, { method: 'POST', headers: { authorization: `Bearer ${requireEnv('CLOUDFLARE_API_TOKEN')}`, 'payment-method': 'x402', 'content-type': 'application/json' }, body });
		const parsed = (await res.json()) as { success?: boolean; errors?: { message?: string }[]; result?: { choices?: { message?: { content?: string } }[] } };
		if (!res.ok || !parsed.success) {
			console.log(`  ✗ HTTP ${res.status} ${parsed.errors?.map((e) => e.message).join('; ')}`);
			continue;
		}
		console.log(`  ${i + 1}. ${(parsed.result?.choices?.[0]?.message?.content ?? '').trim().replace(/\s+/g, ' ')}`);
	}
}
