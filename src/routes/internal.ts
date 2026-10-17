/**
 * Internal diagnostics, behind Cloudflare Access (see src/lib/internal.ts).
 * They expose visitor IPs, countries and the raw gateway exchanges, so never public.
 */
import { Hono } from 'hono';
import { config } from '../lib/env.ts';
import { requireInternal } from '../lib/internal.ts';
import { listEvents, logEvent } from '../lib/log.ts';

export const internalRoutes = new Hono();

internalRoutes.use('/api/events', requireInternal);
internalRoutes.use('/api/_trace', requireInternal);

// Structured gateway events for bug reports: ?conversation=…&kind=x402.payment|gate|ai.turn&failures=1&since=<iso>&limit=100
internalRoutes.get('/api/events', async (c) =>
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

// Diagnostic: how do Cloudflare-fronted endpoints see a subrequest made from this
// Worker while handling YOUR request? Compares your visitor identity with what
// cdn-cgi/trace and AI Gateway's unpaid 402/403 see from inside the Worker.
internalRoutes.get('/api/_trace', async (c) => {
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
