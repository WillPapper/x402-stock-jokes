// Pays jokes.papper.me 0.10 USDC via x402 (no password) and reads the joke back.
// Usage: bun scripts/pay-for-joke.ts NVDA [https://jokes.papper.me]
import { Budget, usdToBaseUnits } from '../src/lib/budget.ts';
import { createPaidFetch } from '../src/lib/x402.ts';
import { loadDevVars, privateKey } from './_env.ts';

loadDevVars();
const ticker = (process.argv[2] ?? 'NVDA').toUpperCase();
const origin = process.argv[3] ?? 'https://jokes.papper.me';
const id = `paid-${Date.now().toString(36)}`;
const url = `${origin}/agents/joke/${id}`;
// BUYER_PRIVATE_KEY lets you pay from a wallet other than the app's own (the facilitator rejects paying yourself).
const buyerKey = (process.env.BUYER_PRIVATE_KEY as `0x${string}` | undefined) ?? privateKey();
const paid = createPaidFetch({ privateKey: buyerKey, budget: new Budget(usdToBaseUnits('0.25'), usdToBaseUnits('1')), maxUsdPerPayment: '$0.25' });

const res = await paid(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'user', body: `Tell me a joke about ${ticker}.` }) });
console.log(`POST ${res.status} | ${paid.describeLast()}`);
if (!res.ok) {
	console.log((await res.text()).slice(0, 400));
	process.exit(1);
}
for (let i = 0; i < 48; i++) {
	await new Promise((r) => setTimeout(r, 5000));
	const snap = (await (await fetch(url)).json()) as { messages?: { role: string; parts: { type: string; text?: string; toolName?: string; state?: string }[] }[]; settlements?: { outcome: string }[] };
	const tools = (snap.messages ?? []).flatMap((m) => m.parts.filter((p) => p.type === 'dynamic-tool').map((p) => `${p.toolName}:${p.state}`));
	process.stdout.write(`\r  ${tools.join(' ') || 'thinking…'}        `);
	if (snap.settlements?.length) {
		console.log(`\nsettled: ${snap.settlements[0]!.outcome}`);
		const text = (snap.messages ?? []).filter((m) => m.role === 'assistant').flatMap((m) => m.parts.filter((p) => p.type === 'text').map((p) => p.text ?? '')).at(-1);
		console.log(text?.trim().split('\n')[0]);
		break;
	}
}
const latest = (await (await fetch(`${origin}/api/jokes?limit=1`)).json()) as { jokes: { ticker: string; paidBy: string | null; conversationId: string }[] };
console.log('feed newest:', latest.jokes[0]?.ticker, latest.jokes[0]?.paidBy, latest.jokes[0]?.conversationId === id ? '(this run)' : '(another run)');
