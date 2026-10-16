// Step-0 spike: what does AI Gateway /ai/run return under x402, does it take
// tools, does it stream? Also one paid StockTwits + Ceramic call. Spends a few cents.
import { Budget, usdToBaseUnits } from '../src/lib/budget.ts';
import { createPaidFetch, decodePaymentRequired } from '../src/lib/x402.ts';
import { loadDevVars, privateKey, requireEnv } from './_env.ts';

loadDevVars();
const accountId = requireEnv('CLOUDFLARE_ACCOUNT_ID');
const token = requireEnv('CLOUDFLARE_API_TOKEN');
const model = process.argv[2] ?? 'openai/gpt-oss-20b';
const budget = new Budget(usdToBaseUnits('0.10'), usdToBaseUnits('1'));
const paid = createPaidFetch({ privateKey: privateKey(), budget, maxUsdPerPayment: '$0.10' });
const aiRun = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run`;

async function run(label: string, url: string, init?: RequestInit, bodyLimit = 1500) {
	console.log(`\n===== ${label}`);
	try {
		const res = await paid(url, init);
		console.log('status', res.status, '| content-type', res.headers.get('content-type'), '|', paid.describeLast());
		const pr = decodePaymentRequired(res.headers.get('PAYMENT-REQUIRED'));
		if (pr?.error) console.log('PAYMENT-REQUIRED.error:', pr.error);
		if (paid.last().receipt) console.log('receipt:', JSON.stringify(paid.last().receipt));
		const text = await res.text();
		console.log('body:', text.slice(0, bodyLimit));
		return text;
	} catch (err) {
		console.log('threw:', (err as Error).message, '|', paid.describeLast());
	}
}

const headers = { authorization: `Bearer ${token}`, 'payment-method': 'x402', 'content-type': 'application/json' };

await run('A: plain /ai/run', aiRun, {
	method: 'POST',
	headers,
	body: JSON.stringify({ model, input: { messages: [{ role: 'user', content: 'Reply with exactly: pong' }], max_tokens: 30 } }),
});

await run('B: /ai/run with tools', aiRun, {
	method: 'POST',
	headers,
	body: JSON.stringify({
		model,
		input: {
			messages: [{ role: 'user', content: 'What is the weather in Paris? Use the tool.' }],
			tools: [{ type: 'function', function: { name: 'get_weather', description: 'Get current weather for a city', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } } }],
			tool_choice: 'auto',
			max_tokens: 100,
		},
	}),
});

await run('C: /ai/run stream:true', aiRun, {
	method: 'POST',
	headers,
	body: JSON.stringify({ model, input: { messages: [{ role: 'user', content: 'Count from 1 to 5.' }], max_tokens: 40, stream: true } }),
}, 900);

await run('D: StockTwits trending (exact)', 'https://api-staging-mgw.stocktwits.com/api/2/symbols/trending/AAPL.json', undefined, 1200);
await run('E: Ceramic search (exact)', 'https://api.ceramic.ai/search', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: 'Apple AAPL stock news' }) }, 700);

console.log(`\nTotal settled this run: ${budget.spent} base units`);
