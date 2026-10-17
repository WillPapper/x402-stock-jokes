/** The public JSON API: the feed, per-ticker cache, stats, wallet and chain summaries. */
import { type Context, Hono } from 'hono';
import { createPublicClient, erc20Abi, fallback, formatUnits, http } from 'viem';
import { base } from 'viem/chains';
import { PRICE_USDC } from '../lib/access.ts';
import { jokeStats, latestJokeFor, listJokes } from '../lib/db.ts';
import { config } from '../lib/env.ts';
import { ledger } from '../lib/ledger.ts';
import { paidRunTotals } from '../lib/runs.ts';
import { withSettled } from '../lib/settlement.ts';
import { summarize, walletTransfers } from '../lib/transfers.ts';
import { PERMIT2, USDC_BASE, walletFromKey } from '../lib/x402.ts';

export const publicRoutes = new Hono();

/** Finish a background write after the response is sent (no-op where there is no execution context). */
function afterResponse(c: Context) {
	return (work: Promise<unknown>) => {
		try {
			c.executionCtx.waitUntil(work);
		} catch {
			void work;
		}
	};
}

publicRoutes.get('/api/health', (c) => c.json({ ok: true, price: `${PRICE_USDC} USDC` }));

publicRoutes.get('/api/jokes', async (c) => {
	const after = c.req.query('after') || undefined;
	const before = c.req.query('before') || undefined;
	const limit = Number(c.req.query('limit') ?? 30);
	return c.json({ jokes: await withSettled(await listJokes({ after, before, limit }), afterResponse(c)), serverTime: new Date().toISOString() });
});

publicRoutes.get('/api/jokes/latest', async (c) => {
	const ticker = (c.req.query('ticker') ?? '').toUpperCase().replace(/[^A-Z0-9.]/g, '');
	if (!ticker) return c.json({ error: 'ticker query parameter required' }, 400);
	const joke = await latestJokeFor(ticker);
	return joke ? c.json({ joke: (await withSettled([joke], afterResponse(c)))[0] }) : c.json({ joke: null }, 404);
});

publicRoutes.get('/api/stats', async (c) => {
	const [stats, paid] = await Promise.all([jokeStats(), paidRunTotals()]);
	let chain: ReturnType<typeof summarize> | null = null;
	try {
		chain = summarize(await walletTransfers(walletFromKey(config.privateKey).address));
	} catch (err) {
		console.warn('transfers unavailable', (err as Error).message.slice(0, 120));
	}
	// earnedFromJokesUsdc: what buyers paid through the gateway, from the PAYMENT-CONTEXT tokens.
	return c.json({ ...stats, earnedFromJokesUsdc: paid.earnedUsdc.toFixed(6), paidJokes: paid.paidJokes, chain });
});

publicRoutes.get('/api/transfers', async (c) => {
	const transfers = await walletTransfers(walletFromKey(config.privateKey).address);
	return c.json({ wallet: walletFromKey(config.privateKey).address, summary: summarize(transfers), transfers: transfers.slice(0, Number(c.req.query('limit') ?? 100)) });
});

// Public Base RPCs rate-limit Cloudflare's edge; try several and degrade to
// "address only" rather than failing the page.
const BASE_RPCS = () => [...(config.alchemyKey ? [`https://base-mainnet.g.alchemy.com/v2/${config.alchemyKey}`] : []), 'https://base-rpc.publicnode.com', 'https://base.llamarpc.com', 'https://1rpc.io/base', 'https://mainnet.base.org'];
publicRoutes.get('/api/wallet', async (c) => {
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

/** This isolate's recent payments (in memory; the durable record is each run's `run_payments`). */
publicRoutes.get('/api/ledger', (c) => c.json({ payments: ledger.all() }));
