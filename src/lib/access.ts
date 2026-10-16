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

export const PASSWORD_HEADER = 'x-joke-password';
export const PAYMENT_CONTEXT_HEADER = 'payment-context';
export const JWKS_URL = 'https://payments.cloudflare.com/certs';
export const PUBLIC_HOST = 'jokes.papper.me';
export const PRICE_USDC = '0.10';

export type Access = { ok: true; by: 'password' | 'x402'; amount?: string } | { ok: false; status: 401 | 402; reason: string };

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

function timingSafeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

export async function checkAccess(request: Request): Promise<Access> {
	const expected = (env as unknown as { JOKE_PASSWORD?: string }).JOKE_PASSWORD;
	const url = new URL(request.url);
	const given = request.headers.get(PASSWORD_HEADER) ?? url.searchParams.get('password');
	if (given !== null) {
		if (expected && timingSafeEqual(given, expected)) return { ok: true, by: 'password' };
		return { ok: false, status: 401, reason: 'wrong coupon code; drop the X-Joke-Password header to pay 0.10 USDC with x402 instead' };
	}

	const token = request.headers.get(PAYMENT_CONTEXT_HEADER);
	if (token) {
		try {
			jwks ??= createRemoteJWKSet(new URL(JWKS_URL));
			const { payload } = await jwtVerify(token, jwks, { algorithms: ['EdDSA'] });
			const aud = Array.isArray(payload.aud) ? payload.aud[0] : payload.aud;
			if (aud && !aud.includes(url.host) && !aud.includes(PUBLIC_HOST)) {
				return { ok: false, status: 401, reason: `payment context is for another resource (${aud})` };
			}
			return { ok: true, by: 'x402', amount: typeof payload.amount === 'string' ? payload.amount : undefined };
		} catch (err) {
			return { ok: false, status: 401, reason: `payment context rejected: ${(err as Error).message}` };
		}
	}

	return { ok: false, status: 402, reason: 'x402 payment (0.10 USDC) or coupon code required' };
}

export function paymentRequiredBody(conversationUrl: string) {
	return {
		error: 'payment_required',
		message: `A joke costs ${PRICE_USDC} USDC on Base via x402. Or send a coupon code in the X-Joke-Password header for a free one.`,
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
