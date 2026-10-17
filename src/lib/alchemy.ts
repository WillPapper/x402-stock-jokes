/**
 * Alchemy JSON-RPC with a paid fallback, so the app keeps working when the free
 * plan runs out. The API key is tried first. When Alchemy refuses it for
 * capacity (HTTP 429, compute units per second; or 403 "Monthly capacity limit
 * exceeded."), the call goes to Alchemy's x402 gateway instead: signed in as the
 * app wallet (SIWE) and paid from that wallet's prepaid credits, bought in $1
 * top-ups at $0.45 per million CU. The key is skipped for a while after a
 * refusal. See docs/alchemy-x402.md.
 *
 * Runtime-free (no cloudflare:workers import) so bun test can load it; the
 * Worker wiring lives in transfers.ts.
 */
import { createSiweMessage, generateSiweNonce } from 'viem/siwe';

export const ALCHEMY_GATEWAY = 'https://x402.alchemy.com';
/** Payee of the gateway's Base quotes (live 402s, 2026-10-16). Lowercase, to match transfer counterparties. */
export const ALCHEMY_GATEWAY_PAYEE = '0x0573c4da7fc31e944e5ff959fef3b42199c308b2';

/**
 * At most one credit top-up per this window, app-wide (transfers.ts enforces it
 * through D1). Live on 2026-10-17 the gateway took a $1 top-up and then answered
 * 500 / 403 / another 402 for the same wallet; this caps what that can cost.
 */
export const TOPUP_MIN_INTERVAL_MS = 24 * 60 * 60_000;

/** How long to leave the key alone after each kind of refusal. */
export const KEY_PAUSE_MS = { throughput: 60_000, monthly: 15 * 60_000 } as const;
const SIWE_TTL_MS = 60 * 60_000;
/** Sign a fresh token when the cached one has less than this left. */
const SIWE_REFRESH_MS = 5 * 60_000;

export type CapacityLimit = keyof typeof KEY_PAUSE_MS;

/** Alchemy's documented capacity refusals (docs/reference/error-reference), from a key-based response. */
export function capacityLimit(status: number, body: string): CapacityLimit | null {
	if (/capacity limit exceeded/i.test(body)) return 'monthly';
	if (status === 429 || /"code"\s*:\s*429\b/.test(body)) return 'throughput';
	return null;
}

export interface SiweSigner {
	address: `0x${string}`;
	signMessage(args: { message: string }): Promise<`0x${string}`>;
}

/** `Authorization: SIWE <base64(message)>.<signature>` token for the gateway (agentic-gateway skill, authentication.md). */
export async function signGatewaySiwe(signer: SiweSigner, now = Date.now(), ttlMs = SIWE_TTL_MS): Promise<{ token: string; expiresAt: number }> {
	const message = createSiweMessage({
		domain: 'x402.alchemy.com',
		address: signer.address,
		statement: 'Sign in to Alchemy Gateway',
		uri: ALCHEMY_GATEWAY,
		version: '1',
		chainId: 8453,
		nonce: generateSiweNonce(),
		issuedAt: new Date(now),
		expirationTime: new Date(now + ttlMs),
	});
	const signature = await signer.signMessage({ message });
	return { token: `${btoa(message)}.${signature}`, expiresAt: now + ttlMs };
}

export interface AlchemyRpcOptions {
	/** Alchemy network slug, e.g. `base-mainnet`. */
	network: string;
	/** The free-plan key; null sends every call to the gateway. */
	key: () => string | null;
	/** The wallet that signs in to the gateway and owns its credits. */
	signer: () => SiweSigner;
	/** A fetch that pays x402 challenges from that wallet (createPaidFetch). */
	paidFetch: () => (input: string, init?: RequestInit) => Promise<Response>;
	/**
	 * Asked before buying a top-up, i.e. when the gateway answers 402. Return a
	 * reason to refuse (e.g. "bought one 3 h ago"), or null to allow it.
	 */
	refuseTopUp?: () => Promise<string | null>;
	fetch?: (input: string, init?: RequestInit) => Promise<Response>;
	now?: () => number;
	/** Called each time a call goes to the gateway, with why. */
	onFallback?: (reason: CapacityLimit | 'paused' | 'no-key', detail: string) => void;
}

export class AlchemyRpcError extends Error {
	constructor(
		message: string,
		readonly via: 'key' | 'gateway',
		readonly status: number,
	) {
		super(message);
		this.name = 'AlchemyRpcError';
	}
}

export function createAlchemyRpc(o: AlchemyRpcOptions) {
	const plainFetch = o.fetch ?? ((input: string, init?: RequestInit) => fetch(input, init));
	const now = o.now ?? Date.now;
	let keyPausedUntil = 0;
	let pausedFor: CapacityLimit | null = null;
	let siwe: { token: string; expiresAt: number } | null = null;
	// One gateway call at a time: with no credits left, two parallel calls would each buy a $1 top-up.
	let gatewayQueue: Promise<unknown> = Promise.resolve();

	const rpcBody = (method: string, params: unknown[]) => JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });

	function resultOf<T>(text: string, via: 'key' | 'gateway', status: number): T {
		let body: { result?: T; error?: unknown };
		try {
			body = JSON.parse(text);
		} catch {
			throw new AlchemyRpcError(`Alchemy (${via}): HTTP ${status}, not JSON: ${text.slice(0, 200)}`, via, status);
		}
		if (body.error) {
			// JSON-RPC errors are objects; the gateway's unpaid 402 carries a string ("Payment Required").
			const message = typeof body.error === 'string' ? body.error : ((body.error as { message?: string }).message ?? JSON.stringify(body.error));
			throw new AlchemyRpcError(`Alchemy (${via}): HTTP ${status}: ${message}`, via, status);
		}
		if (status < 200 || status >= 300) throw new AlchemyRpcError(`Alchemy (${via}): HTTP ${status}`, via, status);
		return body.result as T;
	}

	async function token(forceNew = false): Promise<string> {
		if (forceNew || !siwe || siwe.expiresAt - now() < SIWE_REFRESH_MS) siwe = await signGatewaySiwe(o.signer(), now());
		return siwe.token;
	}

	async function viaGateway<T>(body: string): Promise<T> {
		const url = `${ALCHEMY_GATEWAY}/${o.network}/v2`;
		const send = async (via: (input: string, init?: RequestInit) => Promise<Response>, auth: string) =>
			via(url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', authorization: `SIWE ${auth}` }, body });
		// Unpaid first: with credits on the wallet this is the whole call. Only a 402 leads to a top-up.
		let res = await send(plainFetch, await token());
		// An expired or rejected sign-in: sign again once.
		if (res.status === 401) res = await send(plainFetch, await token(true));
		if (res.status === 402) {
			const refused = await o.refuseTopUp?.();
			if (refused) throw new AlchemyRpcError(`Alchemy (gateway): needs a credit top-up, refused: ${refused}`, 'gateway', 402);
			res = await send(o.paidFetch(), await token());
		}
		return resultOf<T>(await res.text(), 'gateway', res.status);
	}

	function queuedGateway<T>(body: string): Promise<T> {
		const run = gatewayQueue.then(() => viaGateway<T>(body));
		gatewayQueue = run.catch(() => undefined);
		return run;
	}

	return async function call<T>(method: string, params: unknown[]): Promise<T> {
		const body = rpcBody(method, params);
		const key = o.key();
		if (!key) {
			o.onFallback?.('no-key', method);
			return queuedGateway<T>(body);
		}
		if (now() < keyPausedUntil) {
			o.onFallback?.('paused', `${method}: key paused for ${pausedFor} until ${new Date(keyPausedUntil).toISOString()}`);
			return queuedGateway<T>(body);
		}
		const res = await plainFetch(`https://${o.network}.g.alchemy.com/v2/${key}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
		const text = await res.text();
		const limit = capacityLimit(res.status, text);
		if (!limit) return resultOf<T>(text, 'key', res.status);
		keyPausedUntil = now() + KEY_PAUSE_MS[limit];
		pausedFor = limit;
		o.onFallback?.(limit, `${method}: HTTP ${res.status} ${text.slice(0, 200)}`);
		return queuedGateway<T>(body);
	};
}
