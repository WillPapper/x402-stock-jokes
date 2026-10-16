import { Budget, usdToBaseUnits } from '../src/lib/budget.ts';
import { createPaidFetch, decodePaymentRequired } from '../src/lib/x402.ts';
import { loadDevVars, privateKey, requireEnv } from './_env.ts';
loadDevVars();
const accountId = requireEnv('CLOUDFLARE_ACCOUNT_ID'); const token = requireEnv('CLOUDFLARE_API_TOKEN');
const budget = new Budget(usdToBaseUnits('0.10'), usdToBaseUnits('1'));
const paid = createPaidFetch({ privateKey: privateKey(), budget, maxUsdPerPayment: '$0.10' });
const aiRun = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run`;
const headers = { authorization: `Bearer ${token}`, 'payment-method': 'x402', 'content-type': 'application/json' };

console.log('===== AI Gateway response headers');
const r = await paid(aiRun, { method: 'POST', headers, body: JSON.stringify({ model: 'openai/gpt-oss-20b', input: { messages: [{ role: 'user', content: 'Say pong.' }], max_tokens: 200 } }) });
for (const [k, v] of r.headers) if (!/^(cf-ray|set-cookie|server|date|alt-svc|nel|report-to|vary)$/.test(k)) console.log(' ', k + ':', v.slice(0, 160));
const pr = r.headers.get('PAYMENT-RESPONSE'); if (pr) console.log('decoded PAYMENT-RESPONSE:', JSON.stringify(paid.last().receipt));
const j: any = await r.json(); console.log('content:', JSON.stringify(j.result?.choices?.[0]?.message?.content), '| usage:', JSON.stringify(j.result?.usage));

const st = 'https://api-staging-mgw.stocktwits.com';
for (const p of ['/api/2/symbols/show/AAPL.json', '/api/2/symbols/trending/AAPL', '/api/2/symbols/AAPL.json', '/api/2/symbols/AAPL/trending.json', '/api/2/symbols/search.json?q=AAPL', '/api/2/symbols/show/NVDA.json']) {
	const res = await paid(st + p);
	const t = await res.text();
	console.log(`\n${res.status} ${p} | ${paid.describeLast()}\n  ${t.slice(0, 500)}`);
}
console.log('\nsettled:', budget.spent);
