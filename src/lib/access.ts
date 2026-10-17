/**
 * Who may submit a joke: callers with the password, or callers whose request
 * was paid through Cloudflare's Monetization Gateway (which forwards a signed
 * PAYMENT-CONTEXT JWT). Everyone else gets 402 with instructions.
 *
 * On jokes.papper.me the gateway answers the 402 itself (with a real x402
 * PAYMENT-REQUIRED quote) before the Worker is reached; this module is the
 * origin-side check the docs require, and the whole gate for workers.dev.
 */
import { env } from 'cloudflare:workers';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { claimPaymentToken } from './db.ts';
import { jwtPayload, logEvent } from './log.ts';

export const PASSWORD_HEADER = 'x-joke-password';
export const PAYMENT_CONTEXT_HEADER = 'payment-context';
export const JWKS_URL = 'https://payments.cloudflare.com/certs';
export const PUBLIC_HOST = 'jokes.papper.me';
export const PRICE_USDC = '0.10';

export type Access = { ok: true; by: 'password' | 'x402'; amount?: string } | { ok: false; status: 401 | 402; reason: string };

/**
 * The URL the buyer actually paid for. `POST /joke/<TICKER>` forwards to the
 * gated agent route in-process; the forwarder records the original request URL
 * here so the PAYMENT-CONTEXT audience can be checked against what was paid
 * for, not against the internal URL. Keyed by the Request object itself, so
 * nothing a client sends can set it.
 */
export const paidResource = new WeakMap<Request, string>();

async function sha256Hex(text: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** The audience is the URL the gateway charged for; it must be this resource on this host. */
function audienceMatches(aud: string, resource: URL): { ok: true } | { ok: false; why: string } {
	let audUrl: URL | null = null;
	try {
		audUrl = new URL(aud);
	} catch {
		audUrl = null;
	}
	if (!audUrl) return aud.includes(resource.host) || aud.includes(PUBLIC_HOST) ? { ok: true } : { ok: false, why: `payment context is for another resource (${aud})` };
	if (audUrl.host !== resource.host && audUrl.host !== PUBLIC_HOST) return { ok: false, why: `payment context is for another host (${audUrl.host})` };
	if (audUrl.pathname !== resource.pathname) return { ok: false, why: `payment context paid for ${audUrl.pathname}, not ${resource.pathname}` };
	return { ok: true };
}

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

function timingSafeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

export async function checkAccess(request: Request, conversationId?: string): Promise<Access> {
	const expected = (env as unknown as { JOKE_PASSWORD?: string }).JOKE_PASSWORD;
	const url = new URL(request.url);
	const cf = (request as Request & { cf?: { country?: string; colo?: string; asn?: number } }).cf;
	const base = { path: url.pathname, host: url.host, visitorCountry: cf?.country ?? null, colo: cf?.colo ?? null, asn: cf?.asn ?? null, userAgent: request.headers.get('user-agent')?.slice(0, 120) ?? null };
	const done = (access: Access, extra: Record<string, unknown> = {}) => {
		logEvent('gate', access.ok, { ...base, ...extra, ...(access.ok ? { by: access.by, amount: access.amount ?? null } : { status: access.status, reason: access.reason }) }, { conversationId: conversationId ?? null, label: access.ok ? `admitted:${access.by}` : `denied:${access.status}` });
		return access;
	};
	// Header only: a coupon in the query string would land in request logs and browser history.
	const given = request.headers.get(PASSWORD_HEADER);
	if (given !== null) {
		// Case-insensitive: phones auto-capitalize the first letter, desktops don't.
		if (expected && timingSafeEqual(given.trim().toLowerCase(), expected.trim().toLowerCase())) return done({ ok: true, by: 'password' });
		return done({ ok: false, status: 401, reason: 'Invalid coupon code. Send a valid code in the X-Joke-Password header for a free joke, or omit the header to pay 0.10 USDC with x402.' });
	}

	const token = request.headers.get(PAYMENT_CONTEXT_HEADER);
	if (token) {
		const claims = jwtPayload(token);
		try {
			jwks ??= createRemoteJWKSet(new URL(JWKS_URL));
			const { payload, protectedHeader } = await jwtVerify(token, jwks, { algorithms: ['EdDSA'] });
			const aud = Array.isArray(payload.aud) ? payload.aud[0] : payload.aud;
			const resource = new URL(paidResource.get(request) ?? request.url);
			if (aud) {
				const match = audienceMatches(aud, resource);
				if (!match.ok) return done({ ok: false, status: 401, reason: match.why }, { claims, kid: protectedHeader.kid ?? null, resource: resource.pathname });
			}
			// One payment, one joke: a token that already admitted a request is refused.
			// The token never reaches the buyer (gateway to origin only), so this guards
			// against an origin-side leak. D1 trouble admits the paid request and logs it.
			const claimed = await claimPaymentToken(await sha256Hex(token), aud ?? null, conversationId ?? null).catch((err) => {
				console.warn('payment token claim failed', (err as Error).message.slice(0, 120));
				return true;
			});
			if (!claimed) return done({ ok: false, status: 401, reason: 'payment context already used for a joke' }, { claims, kid: protectedHeader.kid ?? null, replay: true });
			return done({ ok: true, by: 'x402', amount: typeof payload.amount === 'string' ? payload.amount : undefined }, { claims, kid: protectedHeader.kid ?? null });
		} catch (err) {
			return done({ ok: false, status: 401, reason: `payment context rejected: ${(err as Error).message}` }, { claims });
		}
	}

	return done({ ok: false, status: 402, reason: 'x402 payment (0.10 USDC) or coupon code required' });
}

export function paymentRequiredBody(conversationUrl: string) {
	return {
		error: 'payment_required',
		message: `A joke costs ${PRICE_USDC} USDC on Base via x402 (pay the 402 and retry). If you have a coupon code, send it in the X-Joke-Password header instead and the joke is free.`,
		pay: {
			url: conversationUrl.replace(/^https?:\/\/[^/]+/, `https://${PUBLIC_HOST}`),
			simplest: `POST https://${PUBLIC_HOST}/joke/<TICKER> then GET the returned poll URL`,
			method: 'POST',
			price: `${PRICE_USDC} USDC`,
			network: 'eip155:8453',
			protocol: 'x402 v2, exact scheme, via Cloudflare Monetization Gateway',
			howTo: 'Use an x402 client (e.g. @x402/fetch with @x402/evm) against the url above; it handles the 402, signs a USDC authorization, and retries. Then GET the same url to read the joke.',
			instructions: `https://${PUBLIC_HOST}/agent.md`,
		},
	};
}
