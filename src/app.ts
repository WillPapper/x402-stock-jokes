import { setProvider } from '@flue/runtime';
import { createAgentRouter } from '@flue/runtime/routing';
import { Hono } from 'hono';
import { createPublicClient, erc20Abi, fallback, formatUnits, http } from 'viem';
import { base } from 'viem/chains';
import { Joke } from './agents/joke.ts';
import { PRICE_USDC, checkAccess, paymentRequiredBody } from './lib/access.ts';
import { jokeConversationId } from './lib/ids.ts';
import { createX402AiGatewayProvider } from './lib/ai-gateway-provider.ts';
import { jokeForConversation, jokeStats, latestJokeFor, listJokes, recordAccess, type JokeRow } from './lib/db.ts';
import { amountsByHash, summarize, walletTransfers, type Transfer } from './lib/transfers.ts';
import { config, paidInferenceFetch } from './lib/env.ts';
import { ledger } from './lib/ledger.ts';
import { listEvents, logEvent } from './lib/log.ts';
import { requireInternal } from './lib/internal.ts';
import { redactAccountIds } from './lib/redact.ts';
import { PERMIT2, USDC_BASE, walletFromKey } from './lib/x402.ts';
import { tickerKnown } from './tools/stocktwits.ts';

// The agent's own model turns go through AI Gateway machine payments: every
// chat-completions call pi-ai makes is rewritten to /ai/run and paid with x402.
setProvider(
	createX402AiGatewayProvider({
		accountId: () => config.accountId,
		apiToken: () => config.apiToken,
		paidFetch: paidInferenceFetch('AI Gateway orchestrator turn'),
		onTurn: (t) => logEvent('ai.turn', t.ok, { model: t.model, status: t.status, usage: t.usage ?? null, ids: t.ids, durationMs: t.durationMs, finishReason: t.finishReason ?? null, payment: t.description, ...(t.error ? { error: t.error } : {}) }, { label: 'orchestrator turn' }),
	}),
);

const app = new Hono();

// Submitting a message costs money (every step pays with x402), so a POST needs
// either the password or a Monetization Gateway payment. Reads stay free.
// Reads are public but must never reach the agent's Durable Object while it is
// paying: a read lends the reader's visitor identity to in-flight payments (see
// docs/ai-gateway-visitor-country.md). While a run is in progress, the
// conversation URL (and its stream/attachment subpaths) answer with the D1-built
// status; once done they serve the real conversation. Abort is internal-only.
app.post('/agents/joke/:id/abort', (c) => c.json({ error: 'not_public', message: 'abort is internal' }, 403));
app.use('/agents/joke/:id/:rest{.+}', async (c, next) => {
	const st = await statusFromDb(c.req.param('id'));
	return st.done ? next() : c.json({ ...st, note: 'The joke is still generating. The full conversation will be served here once complete.' });
});
app.use('/agents/joke/:id', async (c, next) => {
	const id = c.req.param('id');
	if (c.req.method !== 'POST') {
		const st = await statusFromDb(id);
		return st.done ? next() : c.json({ ...st, note: 'The joke is still generating. The full conversation will be served here once complete.' });
	}
	const access = await checkAccess(c.req.raw, id);
	if (!access.ok) {
		if (access.status === 402) {
			const ticker = await tickerFromBody(c.req.raw);
			const cached = ticker ? await latestJokeFor(ticker).catch(() => null) : null;
			return c.json({ ...paymentRequiredBody(c.req.url), cached }, 402);
		}
		return c.json({ error: 'unauthorized', message: access.reason }, 401);
	}
	// Bounce tickers StockTwits does not list before the agent starts: the check
	// is free, and every model turn after this point is paid.
	const ticker = c.req.header('x-joke-ticker')?.toUpperCase() ?? (await tickerFromBody(c.req.raw));
	if (ticker && (await tickerKnown(ticker)) === false) {
		logEvent('gate', false, { probe: 'ticker', ticker }, { conversationId: id, label: 'unknown ticker' });
		return c.json({ error: 'unknown_ticker', ticker, message: `StockTwits does not list the ticker ${ticker}. Check the symbol (for example NVDA, AAPL or BRK.B) and try again.` }, 400);
	}
	// The agent runs in a Durable Object (another isolate), so hand this over through D1.
	await recordAccess(id, access.by, access.amount).catch((err) => console.warn('recordAccess failed', (err as Error).message));

	// Start the conversation from the US-pinned runner, not from this request's colo:
	// AI Gateway machine payments geolocate the Worker's egress and are US-only.
	let message: { kind?: string; body?: string };
	try {
		message = (await c.req.json()) as typeof message;
	} catch {
		return c.json({ error: 'bad_request', message: 'JSON body {"kind":"user","body":"…"} required' }, 400);
	}
	if (typeof message.body !== 'string' || !message.body.trim()) return c.json({ error: 'bad_request', message: 'body must be a non-empty string' }, 400);
	// `us` jurisdiction is a hard constraint (execution + storage in the US); the hint only picks the coast.
	const us = config.runner.jurisdiction('us');
	const runner = us.get(us.idFromName('us-runner'), { locationHint: config.runnerLocationHint });
	const queued = await (runner as unknown as { submit(req: { id: string; body: string; by: 'password' | 'x402' }): Promise<{ queued: true; jurisdiction: string | undefined }> }).submit({ id, body: message.body, by: access.by });
	return c.json({ statusUrl: new URL(c.req.url).origin + `/joke/${id}`, queued: queued.queued, runner: { jurisdiction: queued.jurisdiction, startsFrom: 'alarm' } }, 202);
});

// Talk to Joke with one POST per message, then GET the same URL to read:
//
//   curl -X POST https://jokes.papper.me/agents/joke/test-demo-1 \
//     -H 'content-type: application/json' -H 'x-joke-password: …' \
//     -d '{"kind":"user","body":"Tell me a joke about NVDA."}'
//   curl https://jokes.papper.me/agents/joke/test-demo-1
app.route('/agents/joke', createAgentRouter(Joke));

app.get('/api/health', (c) => c.json({ ok: true, price: `${PRICE_USDC} USDC` }));

// ---- Simple API for agents: ticker in, joke out. Same gate (coupon header or x402). ----
const TICKER = /^[A-Z0-9.]{1,12}$/;
app.post('/joke/:ticker', async (c) => {
	const ticker = c.req.param('ticker').toUpperCase();
	if (!TICKER.test(ticker)) return c.json({ error: 'bad_ticker', message: 'ticker must be 1-12 letters, digits or dots' }, 400);
	const id = jokeConversationId(ticker);
	// Forward internally through the gated agent route so password/payment checks apply once.
	const headers = new Headers({ 'content-type': 'application/json', 'x-joke-ticker': ticker });
	for (const h of ['x-joke-password', 'payment-context']) {
		const v = c.req.header(h);
		if (v) headers.set(h, v);
	}
	const res = await app.fetch(new Request(new URL(`/agents/joke/${id}`, c.req.url), { method: 'POST', headers, body: JSON.stringify({ kind: 'user', body: `Tell me a joke about ${ticker}.` }) }), c.env, c.executionCtx);
	if (!res.ok) return res;
	const origin = new URL(c.req.url).origin;
	return c.json({ id, ticker, status: 'accepted', poll: `${origin}/joke/${id}`, note: 'Poll the `poll` URL every few seconds (free) until `done` is true.' }, 202);
});
// Status is served from D1, never from the agent's Durable Object: a read that
// reaches the object while it is paying lends the reader's visitor identity to
// those payments (measured; see docs/ai-gateway-visitor-country.md).
app.get('/joke/:id', async (c) => {
	const id = c.req.param('id');
	if (!/^[A-Za-z0-9._-]{1,80}$/.test(id)) return c.json({ error: 'bad_id' }, 400);
	return c.json(await statusFromDb(id));
});

const TOOL_ORDER = ['fetch_stocktwits_signals', 'search_stock_news', 'write_joke'] as const;
async function statusFromDb(id: string) {
	const [events, row] = await Promise.all([listEvents({ conversationId: id, limit: 300, ascending: true }), jokeForConversation(id)]);
	const steps: Record<string, { state: 'pending' | 'running' | 'done' | 'error'; detail?: string; receipts?: unknown; output?: unknown }> = {};
	for (const t of TOOL_ORDER) steps[t] = { state: 'pending' };
	const payments: { label: string; authorizedUsdc: string | null; scheme: string | null; tx: string | null; ok: boolean; at: string }[] = [];
	let turns = 0;
	let lastFailure: { at: string; error: string } | null = null;
	let lastToolError: { tool: string; error: string } | null = null;
	let agentDone: { ok: boolean; reason?: string } | null = null;
	let started = false;
	for (const e of events) {
		const d = e.data;
		if (e.kind === 'gate' && d.probe === 'runner') started = true;
		if (e.kind === 'tool.start' && typeof d.tool === 'string' && steps[d.tool]) steps[d.tool] = { state: 'running' };
		if (e.kind === 'tool.done' && typeof d.tool === 'string' && steps[d.tool]) {
			const output = d.output as { payments?: unknown } | undefined;
			steps[d.tool] = { state: 'done', output, receipts: output?.payments };
		}
		if (e.kind === 'tool.error' && typeof d.tool === 'string' && steps[d.tool]) {
			steps[d.tool] = { state: 'error', detail: String(d.error ?? 'failed') };
			lastToolError = { tool: d.tool, error: String(d.error ?? 'failed').slice(0, 300) };
		}
		if (e.kind === 'x402.payment') {
			const attempts = (d.attempts as { paymentResponse?: { transaction?: string } }[] | undefined) ?? [];
			const tx = attempts.map((a) => a.paymentResponse?.transaction).find(Boolean) ?? null;
			if (d.authorizedUsdc || !e.ok) payments.push({ label: e.label ?? String(d.label ?? ''), authorizedUsdc: (d.authorizedUsdc as string | null) ?? null, scheme: (d.scheme as string | null) ?? null, tx: tx ? `https://basescan.org/tx/${tx}` : null, ok: e.ok, at: e.ts });
		}
		if (e.kind === 'ai.turn' && e.ok) turns++;
		if (!e.ok && (e.kind === 'ai.turn' || e.kind === 'tool.error' || e.kind === 'error')) lastFailure = { at: e.ts, error: String(d.error ?? d.reason ?? e.label ?? 'failed').slice(0, 300) };
		if (e.kind === 'agent.done') agentDone = { ok: e.ok, reason: typeof d.reason === 'string' ? d.reason : undefined };
	}
	const lastAt = events.at(-1)?.ts ?? null;
	const idleMs = lastAt ? Date.now() - Date.parse(lastAt) : 0;
	let done = false;
	let outcome: 'working' | 'completed' | 'failed' | 'unknown' = events.length ? 'working' : 'unknown';
	let error: string | null = null;
	if (row) {
		done = true;
		outcome = 'completed';
	} else if (agentDone && !agentDone.ok) {
		done = true;
		outcome = 'failed';
		// The step's own message ("symbol not found", "rate limited") beats "tool failures: <name>".
		error = lastToolError?.error ?? agentDone.reason ?? 'the agent finished without a joke';
	} else if (lastFailure && lastFailure.at === lastAt && idleMs > 45_000) {
		done = true;
		outcome = 'failed';
		error = lastFailure.error;
	} else if (started && idleMs > 10 * 60_000) {
		done = true;
		outcome = 'failed';
		error = 'no progress for 10 minutes';
	}
	return {
		id,
		done,
		outcome,
		error,
		failedStep: done && outcome === 'failed' ? (lastToolError?.tool ?? null) : null,
		joke: row?.joke ?? null,
		basedOn: row ? row.facts.slice(0, 3).join('; ') : null,
		facts: row?.facts ?? null,
		ticker: row?.ticker ?? null,
		steps,
		payments,
		turns,
		lastEventAt: lastAt,
		jokeId: row?.id ?? null,
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
	const before = c.req.query('before') || undefined;
	const limit = Number(c.req.query('limit') ?? 30);
	return c.json(redactAccountIds({ jokes: await withSettled(await listJokes({ after, before, limit })), serverTime: new Date().toISOString() }));
});
app.get('/api/jokes/latest', async (c) => {
	const ticker = (c.req.query('ticker') ?? '').toUpperCase().replace(/[^A-Z0-9.]/g, '');
	if (!ticker) return c.json({ error: 'ticker query parameter required' }, 400);
	const joke = await latestJokeFor(ticker);
	return joke ? c.json(redactAccountIds({ joke: (await withSettled([joke]))[0] })) : c.json({ joke: null }, 404);
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

app.get('/api/ledger', (c) => c.json(redactAccountIds({ payments: ledger.all() })));

// Internal diagnostics: behind Cloudflare Access (see src/lib/internal.ts). They
// expose visitor IPs, countries and the raw gateway exchanges, so never public.
app.use('/api/events', requireInternal);
app.use('/api/_trace', requireInternal);

// Diagnostic: how do Cloudflare-fronted endpoints see a subrequest made from this
// Worker while handling YOUR request? Compares your visitor identity with what
// cdn-cgi/trace and AI Gateway's unpaid 402/403 see from inside the Worker.
app.get('/api/_trace', async (c) => {
	const cf = (c.req.raw as Request & { cf?: { country?: string; colo?: string; asn?: number } }).cf;
	const visitor = { ip: c.req.header('cf-connecting-ip') ?? null, country: cf?.country ?? null, colo: cf?.colo ?? null, asn: cf?.asn ?? null };
	const trace = Object.fromEntries((await (await fetch('https://www.cloudflare.com/cdn-cgi/trace')).text()).trim().split('\n').map((l) => l.split('=') as [string, string]));
	const probe = await fetch(config.aiRunUrl, {
		method: 'POST',
		headers: { authorization: `Bearer ${config.apiToken}`, 'payment-method': 'x402', 'content-type': 'application/json' },
		body: JSON.stringify({ model: config.orchestratorModel, input: { messages: [{ role: 'user', content: 'ping' }], max_tokens: 4 } }),
	});
	const result = {
		visitor,
		subrequestSeenBy: { cloudflareTrace: { ip: trace.ip, loc: trace.loc, colo: trace.colo } },
		aiGatewayUnpaidProbe: { status: probe.status, cfRay: probe.headers.get('cf-ray'), body: probe.status === 402 ? '402 quote (ok)' : (await probe.text()).slice(0, 200) },
		verdict:
			trace.ip && visitor.ip && trace.ip === visitor.ip
				? 'the subrequest carried YOUR IP: Cloudflare-fronted endpoints geolocate the visitor, not the Worker'
				: 'the subrequest carried a Cloudflare egress IP',
	};
	logEvent('gate', probe.status === 402, { probe: 'trace', ...result }, { label: 'trace probe' });
	return c.json(result);
});

// Structured gateway events for bug reports: ?conversation=…&kind=x402.payment|gate|ai.turn&failures=1&since=<iso>&limit=100
app.get('/api/events', async (c) =>
	c.json({
		events: await listEvents({
			limit: Number(c.req.query('limit') ?? 100),
			conversationId: c.req.query('conversation') || undefined,
			kind: c.req.query('kind') || undefined,
			failuresOnly: c.req.query('failures') === '1',
			since: c.req.query('since') || undefined,
		}),
	}),
);

async function tickerFromBody(req: Request): Promise<string | null> {
	try {
		const body = (await req.clone().json()) as { body?: unknown };
		const m = typeof body.body === 'string' ? body.body.toUpperCase().match(/\b[A-Z][A-Z0-9]{0,11}(?:\.[A-Z]{1,2})?\b/g) : null;
		const stop = new Set(['A', 'I', 'ME', 'THE', 'JOKE', 'ABOUT', 'TELL', 'PLEASE', 'STOCK', 'FOR', 'ON', 'OF', 'AN', 'TO', 'AND', 'WRITE', 'MAKE', 'GIVE']);
		return m?.find((t) => !stop.has(t)) ?? null;
	} catch {
		return null;
	}
}

export default app;
