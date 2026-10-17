/**
 * Starting and reading joke runs.
 *
 *   POST /joke/<TICKER>          the simple API: ticker in, 202 + poll URL out
 *   GET  /joke/<id>              run status from D1 (free, poll it)
 *   POST /agents/joke/<id>       the raw agent route: {"kind":"user","body":"…"}
 *   GET  /agents/joke/<id>[/…]   the conversation, once the run is done
 *
 * Both POSTs go through `startJoke`: the one gate (coupon header or a
 * Monetization Gateway PAYMENT-CONTEXT token), the free ticker check, the
 * `runs` row, and the hand-off to the US-pinned runner.
 */
import { createAgentRouter } from '@flue/runtime/routing';
import { type Context, Hono, type Next } from 'hono';
import { Joke } from '../agents/joke.ts';
import type { SubmitRequest } from '../cloudflare.ts';
import { checkAccess, paymentRequiredBody } from '../lib/access.ts';
import { latestJokeFor } from '../lib/db.ts';
import { config } from '../lib/env.ts';
import { jokeConversationId } from '../lib/ids.ts';
import { logEvent } from '../lib/log.ts';
import { redactAccountIds } from '../lib/redact.ts';
import { runStatus, startRun } from '../lib/runs.ts';
import { tickerKnown } from '../tools/stocktwits.ts';

export const agentRoutes = new Hono();

const TICKER = /^[A-Z0-9.]{1,12}$/;
const RUN_ID = /^[A-Za-z0-9._-]{1,80}$/;

interface Runner {
	submit(req: SubmitRequest): Promise<{ queued: true; jurisdiction: string | undefined }>;
}

/**
 * Admit, check the ticker, record the run and queue it. Submitting costs money
 * (every step pays with x402), so the request needs the coupon header or a
 * payment token. `paidUrl` is the URL the buyer paid for when the request came
 * in on /joke/<TICKER>; the PAYMENT-CONTEXT audience is checked against it.
 */
export async function startJoke(c: Context, opts: { id: string; ticker: string | null; body: string; paidUrl?: string }): Promise<Response> {
	const { id, ticker } = opts;
	const access = await checkAccess(c.req.raw, id, opts.paidUrl);
	if (!access.ok) {
		if (access.status === 402) {
			const cached = ticker ? await latestJokeFor(ticker).catch(() => null) : null;
			return c.json({ ...paymentRequiredBody(opts.paidUrl ?? c.req.url), cached }, 402);
		}
		return c.json({ error: 'unauthorized', message: access.reason }, 401);
	}
	// Bounce tickers StockTwits does not list before the agent starts: the check
	// is free, and every model turn after this point is paid.
	if (ticker && (await tickerKnown(ticker)) === false) {
		logEvent('gate', false, { probe: 'ticker', ticker }, { conversationId: id, label: 'unknown ticker' });
		return c.json({ error: 'unknown_ticker', ticker, message: `StockTwits does not list the ticker ${ticker}. Check the symbol (for example NVDA, AAPL or BRK.B) and try again.` }, 400);
	}
	await startRun(id, { ticker, paidBy: access.by, amountBaseUnits: access.amount }).catch((err) => console.warn('startRun failed', (err as Error).message.slice(0, 120)));

	// Start the conversation from the US-pinned runner, not from this request's colo:
	// AI Gateway machine payments geolocate the Worker's egress and are US-only.
	// `us` jurisdiction is a hard constraint (execution + storage in the US); the hint only picks the coast.
	const us = config.runner.jurisdiction('us');
	const runner = us.get(us.idFromName('us-runner'), { locationHint: config.runnerLocationHint }) as unknown as Runner;
	const queued = await runner.submit({ id, body: opts.body, by: access.by });
	const poll = `${new URL(c.req.url).origin}/joke/${id}`;
	return c.json(
		{ id, ticker, status: 'accepted', poll, statusUrl: poll, queued: queued.queued, runner: { jurisdiction: queued.jurisdiction, startsFrom: 'alarm' }, note: 'Poll the `poll` URL every few seconds (free) until `done` is true.' },
		202,
	);
}

// ---- Simple API: ticker in, joke out. ----
agentRoutes.post('/joke/:ticker', async (c) => {
	const ticker = c.req.param('ticker').toUpperCase();
	if (!TICKER.test(ticker)) return c.json({ error: 'bad_ticker', message: 'ticker must be 1-12 letters, digits or dots' }, 400);
	return startJoke(c, { id: jokeConversationId(ticker), ticker, body: `Tell me a joke about ${ticker}.`, paidUrl: c.req.url });
});

// Status is served from D1, never from the agent's Durable Object: a read that
// reaches the object while it is paying lends the reader's visitor identity to
// those payments (measured; see docs/ai-gateway-visitor-country.md).
agentRoutes.get('/joke/:id', async (c) => {
	const id = c.req.param('id');
	if (!RUN_ID.test(id)) return c.json({ error: 'bad_id' }, 400);
	return c.json(await runStatus(id));
});

// ---- The raw agent route. ----
agentRoutes.post('/agents/joke/:id', async (c) => {
	const id = c.req.param('id');
	let message: { kind?: string; body?: string };
	try {
		message = (await c.req.raw.clone().json()) as typeof message;
	} catch {
		return c.json({ error: 'bad_request', message: 'JSON body {"kind":"user","body":"…"} required' }, 400);
	}
	if (typeof message.body !== 'string' || !message.body.trim()) return c.json({ error: 'bad_request', message: 'body must be a non-empty string' }, 400);
	return startJoke(c, { id, ticker: tickerFromText(message.body), body: message.body });
});

// Reads are public but must never reach the agent's Durable Object while it is
// running (see above). Until the run is done, the conversation URL and its
// stream/attachment subpaths answer with the D1 status; afterwards they serve
// the real conversation. Abort is internal-only.
async function statusUntilDone(c: Context, next: Next) {
	const st = await runStatus(c.req.param('id') ?? '');
	return st.done ? redactedPassthrough(c, next) : c.json({ ...st, note: 'The joke is still generating. The full conversation will be served here once complete.' });
}
agentRoutes.post('/agents/joke/:id/abort', (c) => c.json({ error: 'not_public', message: 'abort is internal' }, 403));
agentRoutes.use('/agents/joke/:id/:rest{.+}', statusUntilDone);
agentRoutes.on(['GET', 'HEAD'], '/agents/joke/:id', statusUntilDone);
agentRoutes.route('/agents/joke', createAgentRouter(Joke));

/**
 * Conversations finished before 2026-10-17 carry payment records whose AI
 * Gateway URLs name the Cloudflare account; newer records are written clean.
 * Flue's record log cannot be rewritten, so strip the id on the way out.
 */
async function redactedPassthrough(c: Context, next: Next) {
	await next();
	const res = c.res;
	if (!res.headers.get('content-type')?.includes('application/json')) return;
	const body = (await res.json()) as unknown;
	const headers = new Headers(res.headers);
	headers.delete('content-length');
	c.res = new Response(JSON.stringify(redactAccountIds(body)), { status: res.status, statusText: res.statusText, headers });
}

/** The ticker in a free-text request ("Tell me a joke about NVDA"), for the free pre-check and the 402's cached joke. */
export function tickerFromText(text: string): string | null {
	const m = text.toUpperCase().match(/\b[A-Z][A-Z0-9]{0,11}(?:\.[A-Z]{1,2})?\b/g);
	const stop = new Set(['A', 'I', 'ME', 'THE', 'JOKE', 'ABOUT', 'TELL', 'PLEASE', 'STOCK', 'FOR', 'ON', 'OF', 'AN', 'TO', 'AND', 'WRITE', 'MAKE', 'GIVE']);
	return m?.find((t) => !stop.has(t)) ?? null;
}
