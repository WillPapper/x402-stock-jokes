/**
 * Helpers for reading Cloudflare's upstream responses and tokens. Pure (no
 * Worker bindings) so both the paid fetch and the tests can load them.
 */

const ID_HEADERS = ['cf-ray', 'cf-aig-request-id', 'cf-aig-event-id', 'cf-aig-trace-id', 'cf-aig-log-id', 'cf-auditlog-id', 'api-version', 'x-request-id', 'date'] as const;

/** The Cloudflare identifiers on a response, for bug reports (cf-ray, cf-aig-*, …). */
export function upstreamIds(res: Response): Record<string, string> {
	const out: Record<string, string> = {};
	for (const h of ID_HEADERS) {
		const v = res.headers.get(h);
		if (v) out[h] = v;
	}
	return out;
}

/** Decode a JWT payload without verifying it (for logging only). */
export function jwtPayload(token: string | undefined | null): Record<string, unknown> | null {
	if (!token) return null;
	try {
		const part = token.split('.')[1] ?? '';
		const json = atob(part.replace(/-/g, '+').replace(/_/g, '/').padEnd(part.length + ((4 - (part.length % 4)) % 4), '='));
		return JSON.parse(json) as Record<string, unknown>;
	} catch {
		return null;
	}
}
