import { setProvider } from '@flue/runtime';
import { createAgentRouter } from '@flue/runtime/routing';
import { Hono } from 'hono';
import { createPublicClient, erc20Abi, fallback, formatUnits, http } from 'viem';
import { base } from 'viem/chains';
import { Joke } from './agents/joke.ts';
import { PRICE_USDC, checkAccess, paymentRequiredBody } from './lib/access.ts';
import { createX402AiGatewayProvider } from './lib/ai-gateway-provider.ts';
import { jokeStats, latestJokeFor, listJokes } from './lib/db.ts';
import { handoff } from './lib/drafts.ts';
import { config, paidInferenceFetch } from './lib/env.ts';
import { ledger } from './lib/ledger.ts';
import { PERMIT2, USDC_BASE, walletFromKey } from './lib/x402.ts';

// The agent's own model turns go through AI Gateway machine payments: every
// chat-completions call pi-ai makes is rewritten to /ai/run and paid with x402.
setProvider(
	createX402AiGatewayProvider({
		accountId: () => config.accountId,
		apiToken: () => config.apiToken,
		paidFetch: paidInferenceFetch('AI Gateway orchestrator turn'),
		onTurn: (t) => console.log(`[x402-ai-gateway] ${t.model} ${t.status} ${t.description}`),
	}),
);

const app = new Hono();

// Submitting a message costs money (every step pays with x402), so a POST needs
// either the password or a Monetization Gateway payment. Reads stay free.
app.use('/agents/joke/:id', async (c, next) => {
	if (c.req.method !== 'POST') return next();
	const access = await checkAccess(c.req.raw);
	if (!access.ok) {
		if (access.status === 402) {
			const ticker = await tickerFromBody(c.req.raw);
			const cached = ticker ? await latestJokeFor(ticker).catch(() => null) : null;
			return c.json({ ...paymentRequiredBody(c.req.url), cached }, 402);
		}
		return c.json({ error: 'unauthorized', message: access.reason }, 401);
	}
	handoff.setAccess(c.req.param('id'), access.by);
	return next();
});

// Talk to Joke with one POST per message, then GET the same URL to read:
//
//   curl -X POST https://jokes.papper.me/agents/joke/demo-1 \
//     -H 'content-type: application/json' -H 'x-joke-password: …' \
//     -d '{"kind":"user","body":"Tell me a joke about NVDA."}'
//   curl https://jokes.papper.me/agents/joke/demo-1
app.route('/agents/joke', createAgentRouter(Joke));

app.get('/api/health', (c) => c.json({ ok: true, price: `${PRICE_USDC} USDC` }));

// Feed, cache and stats from D1.
app.get('/api/jokes', async (c) => {
	const after = c.req.query('after') || undefined;
	const limit = Number(c.req.query('limit') ?? 30);
	return c.json({ jokes: await listJokes({ after, limit }), serverTime: new Date().toISOString() });
});
app.get('/api/jokes/latest', async (c) => {
	const ticker = (c.req.query('ticker') ?? '').toUpperCase().replace(/[^A-Z0-9.]/g, '');
	if (!ticker) return c.json({ error: 'ticker query parameter required' }, 400);
	const joke = await latestJokeFor(ticker);
	return joke ? c.json({ joke }) : c.json({ joke: null }, 404);
});
app.get('/api/stats', async (c) => c.json(await jokeStats()));

// Public Base RPCs rate-limit Cloudflare's edge; try several and degrade to
// "address only" rather than failing the page.
const BASE_RPCS = ['https://base-rpc.publicnode.com', 'https://base.llamarpc.com', 'https://1rpc.io/base', 'https://mainnet.base.org'];
app.get('/api/wallet', async (c) => {
	const address = walletFromKey(config.privateKey).address;
	const base_ = { address, network: 'eip155:8453', basescan: `https://basescan.org/address/${address}` };
	try {
		const client = createPublicClient({ chain: base, transport: fallback(BASE_RPCS.map((u) => http(u, { retryCount: 0, timeout: 4000 }))) });
		const [usdc, allowance] = await Promise.all([
			client.readContract({ address: USDC_BASE, abi: erc20Abi, functionName: 'balanceOf', args: [address] }),
			client.readContract({ address: USDC_BASE, abi: erc20Abi, functionName: 'allowance', args: [address, PERMIT2] }),
		]);
		return c.json({ ...base_, usdc: formatUnits(usdc, 6), permit2Approved: allowance > 0n });
	} catch (err) {
		console.warn('wallet lookup failed', (err as Error).message.slice(0, 200));
		return c.json({ ...base_, usdc: null, permit2Approved: null, error: 'balance lookup unavailable (RPC rate limited)' });
	}
});

app.get('/api/ledger', (c) => c.json({ payments: ledger.all() }));

async function tickerFromBody(req: Request): Promise<string | null> {
	try {
		const body = (await req.clone().json()) as { body?: unknown };
		const m = typeof body.body === 'string' ? body.body.toUpperCase().match(/\b[A-Z]{1,6}(?:\.[A-Z])?\b/g) : null;
		const stop = new Set(['A', 'I', 'ME', 'THE', 'JOKE', 'ABOUT', 'TELL', 'PLEASE', 'STOCK', 'FOR', 'ON', 'OF', 'AN', 'TO', 'AND', 'WRITE', 'MAKE', 'GIVE']);
		return m?.find((t) => !stop.has(t)) ?? null;
	} catch {
		return null;
	}
}

export default app;
