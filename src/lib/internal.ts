/**
 * Internal-only routes (/api/events, /api/_trace) and response redaction.
 *
 * The routes sit behind a Cloudflare Access self-hosted application on
 * jokes.papper.me/api/events and /api/_trace (Allow policy for the owner's
 * email, Service Auth policy for a service token). Access authenticates at the
 * edge and forwards a signed JWT in `Cf-Access-Jwt-Assertion`; this module
 * verifies that JWT against the team's public keys, issuer and the
 * application's AUD tag, as Cloudflare's docs require of the origin:
 * https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/
 *
 * Fail closed: without ACCESS_AUD configured, or without a valid token, the
 * route answers 403. Local dev (localhost) is exempt because Access is not in
 * front of it.
 */
import { env } from 'cloudflare:workers';
import type { MiddlewareHandler } from 'hono';
import { createRemoteJWKSet, jwtVerify } from 'jose';

interface AccessVars {
	ACCESS_TEAM_DOMAIN?: string;
	ACCESS_AUD?: string;
}

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
let jwksFor: string | null = null;

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export const requireInternal: MiddlewareHandler = async (c, next) => {
	const url = new URL(c.req.url);
	if (LOCAL_HOSTS.has(url.hostname)) return next();
	const vars = env as unknown as AccessVars;
	const teamDomain = vars.ACCESS_TEAM_DOMAIN?.replace(/\/$/, '');
	const aud = vars.ACCESS_AUD;
	if (!teamDomain || !aud) {
		return c.json({ error: 'forbidden', message: 'internal endpoint: Cloudflare Access is not configured (ACCESS_TEAM_DOMAIN / ACCESS_AUD)' }, 403);
	}
	const token = c.req.header('cf-access-jwt-assertion');
	if (!token) return c.json({ error: 'forbidden', message: 'internal endpoint: missing Cf-Access-Jwt-Assertion (go through Cloudflare Access)' }, 403);
	try {
		if (!jwks || jwksFor !== teamDomain) {
			jwks = createRemoteJWKSet(new URL(`${teamDomain}/cdn-cgi/access/certs`));
			jwksFor = teamDomain;
		}
		await jwtVerify(token, jwks, { issuer: teamDomain, audience: aud });
	} catch (err) {
		return c.json({ error: 'forbidden', message: `internal endpoint: Access token rejected: ${(err as Error).message}` }, 403);
	}
	return next();
};

/** Cloudflare account ids as they appear in API URLs (/accounts/<32 hex>/). */
const ACCOUNT_ID_IN_URL = /\/accounts\/[0-9a-f]{32}\//g;

/**
 * Replace the Cloudflare account id in any URL inside a JSON-serialisable
 * value. The id is not a credential, but there is no reason to hand it to
 * every visitor; D1 and Workers Logs keep the full URL.
 */
export function redactAccountIds<T>(value: T): T {
	const text = JSON.stringify(value);
	if (text === undefined || !ACCOUNT_ID_IN_URL.test(text)) return value;
	ACCOUNT_ID_IN_URL.lastIndex = 0;
	return JSON.parse(text.replace(ACCOUNT_ID_IN_URL, '/accounts/<account>/')) as T;
}
