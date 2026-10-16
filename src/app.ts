import { setProvider } from '@flue/runtime';
import { createAgentRouter } from '@flue/runtime/routing';
import { Hono } from 'hono';
import { createPublicClient, erc20Abi, fallback, formatUnits, http } from 'viem';
import { base } from 'viem/chains';
import { Joke } from './agents/joke.ts';
import { PRICE_USDC, checkAccess, paymentRequiredBody } from './lib/access.ts';
import { createX402AiGatewayProvider } from './lib/ai-gateway-provider.ts';
import { jokeStats, latestJokeFor, listJokes, recordAccess, type JokeRow } from './lib/db.ts';
import { amountsByHash, summarize, walletTransfers, type Transfer } from './lib/transfers.ts';
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
	// The agent runs in a Durable Object (another isolate), so hand this over through D1.
	await recordAccess(c.req.param('id'), access.by, access.amount).catch((err) => console.warn('recordAccess failed', (err as Error).message));
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

// ---- Simple API for agents: ticker in, joke out. Same gate (coupon header or x402). ----
const TICKER = /^[A-Z0-9.]{1,12}$/;
app.post('/joke/:ticker', async (c) => {
	const ticker = c.req.param('ticker').toUpperCase();
	if (!TICKER.test(ticker)) return c.json({ error: 'bad_ticker', message: 'ticker must be 1-12 letters, digits or dots' }, 400);
	const id = `j-${ticker.toLowerCase()}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
	// Forward internally through the gated agent route so password/payment checks apply once.
	const headers = new Headers({ 'content-type': 'application/json' });
	for (const h of ['x-joke-password', 'payment-context']) {
		const v = c.req.header(h);
		if (v) headers.set(h, v);
	}
	const res = await app.fetch(new Request(new URL(`/agents/joke/${id}`, c.req.url), { method: 'POST', headers, body: JSON.stringify({ kind: 'user', body: `Tell me a joke about ${ticker}.` }) }), c.env, c.executionCtx);
	if (!res.ok) return res;
	const origin = new URL(c.req.url).origin;
	return c.json({ id, ticker, status: 'accepted', poll: `${origin}/joke/${id}`, note: 'Poll the `poll` URL every few seconds (free) until `done` is true.' }, 202);
});
app.get('/joke/:id', async (c) => {
	const id = c.req.param('id');
	if (!/^j-[a-z0-9.-]+$/.test(id)) return c.json({ error: 'bad_id' }, 400);
	const res = await app.fetch(new Request(new URL(`/agents/joke/${id}`, c.req.url)), c.env, c.executionCtx);
	if (!res.ok) return c.json({ error: 'not_found', message: `no joke with id ${id}` }, res.status === 404 ? 404 : 502);
	return c.json(compact(id, (await res.json()) as Snapshot));
});

interface Snapshot {
	messages?: { role: string; parts: { type: string; text?: string; toolName?: string; state?: string; output?: Record<string, unknown>; errorText?: string }[]; metadata?: Record<string, unknown> }[];
	settlements?: { outcome: string; error?: { message?: string } }[];
}
function compact(id: string, snap: Snapshot) {
	const steps: Record<string, { state: string; detail?: string; receipts?: unknown }> = {};
	let reply = '';
	let payments: unknown[] = [];
	for (const m of snap.messages ?? []) {
		if (Array.isArray(m.metadata?.payments)) payments = m.metadata.payments as unknown[];
		for (const p of m.parts) {
			if (p.type === 'dynamic-tool' && p.toolName) steps[p.toolName] = { state: p.state ?? 'pending', ...(p.errorText ? { detail: p.errorText } : {}), ...(p.output && Array.isArray(p.output.payments) ? { receipts: p.output.payments } : {}) };
			if (p.type === 'text' && m.role === 'assistant' && p.text) reply = p.text;
		}
	}
	const settlement = snap.settlements?.[0];
	const lines = reply.split('\n').map((l) => l.trim()).filter(Boolean);
	const basedIdx = lines.findIndex((l) => /^based( on)?\s*:/i.test(l));
	return {
		id,
		done: !!settlement,
		outcome: settlement?.outcome ?? 'working',
		error: settlement?.error?.message ?? null,
		joke: basedIdx > 0 ? lines.slice(0, basedIdx).join('\n') : lines.filter((l) => !/^(paid|total)\s*:/i.test(l)).join('\n') || null,
		basedOn: basedIdx >= 0 ? lines[basedIdx]!.replace(/^based( on)?\s*:\s*/i, '') : null,
		steps,
		payments,
	};
}

// ---- Feed, cache and stats: D1 for the jokes, the chain (via Alchemy) for the money. ----
/**
 * What each joke actually cost, from the wallet's USDC transfers: exact-scheme
 * payments (StockTwits, Ceramic) matched by transaction hash; AI Gateway
 * settlements (which land within seconds of each call) matched by time window
 * around the joke, since the gateway returns no receipt. Concurrent jokes may
 * overlap in that window, so the AI figure is "during this joke".
 */
const JOKE_WINDOW_BEFORE_MS = 180_000;
const JOKE_WINDOW_AFTER_MS = 30_000;
async function withSettled(rows: JokeRow[]): Promise<(JokeRow & { paid: { exactUsdc: number; exactCount: number; aiUsdc: number; aiCount: number; totalUsdc: number } })[]> {
	let transfers: Transfer[] = [];
	try {
		transfers = await walletTransfers(walletFromKey(config.privateKey).address);
	} catch (err) {
		console.warn('transfers unavailable', (err as Error).message.slice(0, 120));
	}
	const byHash = amountsByHash(transfers);
	const ai = transfers.filter((t) => t.direction === 'out' && t.party === 'AI Gateway' && t.at).map((t) => ({ ms: Date.parse(t.at), usdc: t.usdc }));
	return rows.map((r) => {
		let exactUsdc = 0;
		let exactCount = 0;
		for (const p of r.payments) {
			const hash = p.tx?.split('/tx/')[1]?.toLowerCase();
			if (hash && byHash.has(hash)) {
				exactUsdc += byHash.get(hash)!;
				exactCount++;
			}
		}
		const end = Date.parse(r.createdAt);
		const inWindow = ai.filter((t) => t.ms >= end - JOKE_WINDOW_BEFORE_MS && t.ms <= end + JOKE_WINDOW_AFTER_MS);
		const aiUsdc = inWindow.reduce((s, t) => s + t.usdc, 0);
		return { ...r, paid: { exactUsdc: +exactUsdc.toFixed(6), exactCount, aiUsdc: +aiUsdc.toFixed(6), aiCount: inWindow.length, totalUsdc: +(exactUsdc + aiUsdc).toFixed(6) } };
	});
}
app.get('/api/jokes', async (c) => {
	const after = c.req.query('after') || undefined;
	const limit = Number(c.req.query('limit') ?? 30);
	return c.json({ jokes: await withSettled(await listJokes({ after, limit })), serverTime: new Date().toISOString() });
});
app.get('/api/jokes/latest', async (c) => {
	const ticker = (c.req.query('ticker') ?? '').toUpperCase().replace(/[^A-Z0-9.]/g, '');
	if (!ticker) return c.json({ error: 'ticker query parameter required' }, 400);
	const joke = await latestJokeFor(ticker);
	return joke ? c.json({ joke: (await withSettled([joke]))[0] }) : c.json({ joke: null }, 404);
});
app.get('/api/stats', async (c) => {
	const stats = await jokeStats();
	let chain: ReturnType<typeof summarize> | null = null;
	try {
		chain = summarize(await walletTransfers(walletFromKey(config.privateKey).address));
	} catch (err) {
		console.warn('transfers unavailable', (err as Error).message.slice(0, 120));
	}
	return c.json({ ...stats, chain });
});
app.get('/api/transfers', async (c) => {
	const transfers = await walletTransfers(walletFromKey(config.privateKey).address);
	return c.json({ wallet: walletFromKey(config.privateKey).address, summary: summarize(transfers), transfers: transfers.slice(0, Number(c.req.query('limit') ?? 100)) });
});

// Public Base RPCs rate-limit Cloudflare's edge; try several and degrade to
// "address only" rather than failing the page.
const BASE_RPCS = () => [...(config.alchemyKey ? [`https://base-mainnet.g.alchemy.com/v2/${config.alchemyKey}`] : []), 'https://base-rpc.publicnode.com', 'https://base.llamarpc.com', 'https://1rpc.io/base', 'https://mainnet.base.org'];
app.get('/api/wallet', async (c) => {
	const address = walletFromKey(config.privateKey).address;
	const base_ = { address, network: 'eip155:8453', basescan: `https://basescan.org/address/${address}` };
	try {
		const client = createPublicClient({ chain: base, transport: fallback(BASE_RPCS().map((u) => http(u, { retryCount: 0, timeout: 4000 }))) });
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
