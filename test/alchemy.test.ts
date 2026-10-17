import { describe, expect, test } from 'bun:test';
import { verifyMessage } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { ALCHEMY_GATEWAY, KEY_PAUSE_MS, capacityLimit, createAlchemyRpc, signGatewaySiwe } from '../src/lib/alchemy.ts';

const MONTHLY = JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32600, message: 'Monthly capacity limit exceeded.' } });
const THROUGHPUT = JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: 429, message: 'Your app has exceeded its compute units per second capacity.' } });
const ok = (result: unknown) => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), { status: 200 });

describe('capacityLimit', () => {
	test('recognizes the two documented refusals', () => {
		expect(capacityLimit(403, MONTHLY)).toBe('monthly');
		expect(capacityLimit(429, THROUGHPUT)).toBe('throughput');
		expect(capacityLimit(429, 'Too Many Requests')).toBe('throughput');
		expect(capacityLimit(200, THROUGHPUT)).toBe('throughput');
	});
	test('leaves other errors alone', () => {
		expect(capacityLimit(401, JSON.stringify({ error: { code: -32600, message: 'Invalid access key' } }))).toBeNull();
		expect(capacityLimit(403, JSON.stringify({ error: { code: -32600, message: 'Origin not on whitelist.' } }))).toBeNull();
		expect(capacityLimit(200, JSON.stringify({ result: '0x1' }))).toBeNull();
	});
});

describe('signGatewaySiwe', () => {
	test('signs the message the gateway expects, verifiable for the wallet', async () => {
		const account = privateKeyToAccount(generatePrivateKey());
		const now = Date.parse('2026-10-16T12:00:00Z');
		const { token, expiresAt } = await signGatewaySiwe(account, now);
		const [b64, signature] = token.split('.');
		const message = atob(b64!);
		expect(message).toStartWith(`x402.alchemy.com wants you to sign in with your Ethereum account:\n${account.address}`);
		expect(message).toContain('Sign in to Alchemy Gateway');
		expect(message).toContain('URI: https://x402.alchemy.com');
		expect(message).toContain('Chain ID: 8453');
		expect(message).toContain('Expiration Time: 2026-10-16T13:00:00.000Z');
		expect(expiresAt).toBe(now + 3_600_000);
		expect(await verifyMessage({ address: account.address, message, signature: signature as `0x${string}` })).toBe(true);
	});
});

const PAYMENT_REQUIRED = () => new Response(JSON.stringify({ x402Version: 2, error: 'Payment Required', accepts: [] }), { status: 402 });

/**
 * A fake Alchemy: the key endpoint answers from `keyResponses`; the gateway
 * answers 402 until the wallet has paid once (`credits` false), then 200,
 * unless `gatewayResponses` scripts its unpaid answers.
 */
function harness(opts: { key?: string | null; keyResponses?: (() => Response)[]; gatewayResponses?: (() => Response)[]; credits?: boolean; paidResponse?: () => Response; refuseTopUp?: () => Promise<string | null> } = {}) {
	const account = privateKeyToAccount(generatePrivateKey());
	let clock = Date.parse('2026-10-16T12:00:00Z');
	let credits = opts.credits ?? true;
	const keyCalls: string[] = [];
	const gatewayCalls: { paid: boolean; auth: string | null; body: string }[] = [];
	const fallbacks: string[] = [];
	const keyResponses = [...(opts.keyResponses ?? [])];
	const gatewayResponses = [...(opts.gatewayResponses ?? [])];
	const rpc = createAlchemyRpc({
		network: 'base-mainnet',
		key: () => (opts.key === undefined ? 'free-key' : opts.key),
		signer: () => account,
		fetch: async (url, init) => {
			if (url.startsWith(ALCHEMY_GATEWAY)) {
				await new Promise((r) => setTimeout(r, 2));
				gatewayCalls.push({ paid: false, auth: new Headers(init?.headers).get('authorization'), body: String(init?.body) });
				return (gatewayResponses.shift() ?? (() => (credits ? ok('0xgateway') : PAYMENT_REQUIRED())))();
			}
			keyCalls.push(url);
			return (keyResponses.shift() ?? (() => ok('0xkey')))();
		},
		paidFetch: () => async (_url, init) => {
			await new Promise((r) => setTimeout(r, 2));
			gatewayCalls.push({ paid: true, auth: new Headers(init?.headers).get('authorization'), body: String(init?.body) });
			credits = true;
			return (opts.paidResponse ?? (() => ok('0xpaid')))();
		},
		refuseTopUp: opts.refuseTopUp,
		now: () => clock,
		onFallback: (reason) => fallbacks.push(reason),
	});
	return { rpc, keyCalls, gatewayCalls, fallbacks, advance: (ms: number) => (clock += ms) };
}

describe('createAlchemyRpc', () => {
	test('uses the free key while it works', async () => {
		const h = harness();
		expect(await h.rpc('eth_blockNumber', [])).toBe('0xkey');
		expect(h.keyCalls).toEqual(['https://base-mainnet.g.alchemy.com/v2/free-key']);
		expect(h.gatewayCalls).toHaveLength(0);
	});

	test('falls back to the gateway on the monthly limit, then leaves the key alone for a while', async () => {
		const h = harness({ keyResponses: [() => new Response(MONTHLY, { status: 403 })] });
		expect(await h.rpc('alchemy_getAssetTransfers', [{ fromAddress: '0xabc' }])).toBe('0xgateway');
		expect(h.gatewayCalls[0]!.auth).toStartWith('SIWE ');
		expect(JSON.parse(h.gatewayCalls[0]!.body)).toMatchObject({ method: 'alchemy_getAssetTransfers', params: [{ fromAddress: '0xabc' }] });

		// Inside the pause: straight to the gateway, the key isn't tried.
		h.advance(KEY_PAUSE_MS.monthly - 1);
		expect(await h.rpc('eth_blockNumber', [])).toBe('0xgateway');
		expect(h.keyCalls).toHaveLength(1);

		// After it: the key gets another chance.
		h.advance(1);
		expect(await h.rpc('eth_blockNumber', [])).toBe('0xkey');
		expect(h.keyCalls).toHaveLength(2);
		expect(h.fallbacks).toEqual(['monthly', 'paused']);
	});

	test('falls back on a throughput 429 with a shorter pause', async () => {
		const h = harness({ keyResponses: [() => new Response(THROUGHPUT, { status: 429 })] });
		expect(await h.rpc('eth_blockNumber', [])).toBe('0xgateway');
		h.advance(KEY_PAUSE_MS.throughput);
		expect(await h.rpc('eth_blockNumber', [])).toBe('0xkey');
	});

	test('does not fall back for errors that are not about capacity', async () => {
		const h = harness({ keyResponses: [() => new Response(JSON.stringify({ error: { code: -32600, message: 'Invalid access key' } }), { status: 401 })] });
		await expect(h.rpc('eth_blockNumber', [])).rejects.toThrow('Invalid access key');
		expect(h.gatewayCalls).toHaveLength(0);
	});

	test('with no key, every call goes to the gateway', async () => {
		const h = harness({ key: null });
		expect(await h.rpc('eth_blockNumber', [])).toBe('0xgateway');
		expect(h.keyCalls).toHaveLength(0);
		expect(h.fallbacks).toEqual(['no-key']);
	});

	test('pays only when the gateway asks: credits on the wallet mean no payment', async () => {
		const h = harness({ key: null });
		await h.rpc('eth_blockNumber', []);
		expect(h.gatewayCalls.map((c) => c.paid)).toEqual([false]);
	});

	test('buys a top-up on a 402 and retries paid', async () => {
		const h = harness({ key: null, credits: false });
		expect(await h.rpc('eth_blockNumber', [])).toBe('0xpaid');
		expect(h.gatewayCalls.map((c) => c.paid)).toEqual([false, true]);
	});

	test('reuses the sign-in token, and signs again after a 401', async () => {
		const h = harness({ key: null, gatewayResponses: [() => ok('0x1'), () => new Response('{"error":"Unauthorized"}', { status: 401 }), () => ok('0x2')] });
		await h.rpc('eth_blockNumber', []);
		await h.rpc('eth_blockNumber', []);
		const [first, rejected, retried] = h.gatewayCalls.map((c) => c.auth);
		expect(rejected).toBe(first!);
		expect(retried).not.toBe(first!);
	});

	test('runs gateway calls one at a time, so an empty wallet buys one top-up, not three', async () => {
		const h = harness({ key: null, credits: false });
		await Promise.all([h.rpc('eth_blockNumber', []), h.rpc('eth_blockNumber', []), h.rpc('eth_blockNumber', [])]);
		expect(h.gatewayCalls.filter((c) => c.paid)).toHaveLength(1);
	});

	test('a refused top-up fails the call without paying', async () => {
		const h = harness({ key: null, credits: false, refuseTopUp: async () => 'bought one 3 h ago' });
		await expect(h.rpc('eth_blockNumber', [])).rejects.toThrow('needs a credit top-up, refused: bought one 3 h ago');
		expect(h.gatewayCalls.filter((c) => c.paid)).toHaveLength(0);
	});

	test('a failure after paying surfaces as an error (seen live: 500 right after a settled top-up)', async () => {
		const h = harness({ key: null, credits: false, paidResponse: () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32002, message: 'Internal error' } }), { status: 500 }) });
		await expect(h.rpc('eth_blockNumber', [])).rejects.toThrow('Alchemy (gateway): HTTP 500: Internal error');
	});

	test('an unpaid answer after the payment step surfaces as an error', async () => {
		const h = harness({ key: null, credits: false, paidResponse: PAYMENT_REQUIRED });
		await expect(h.rpc('eth_blockNumber', [])).rejects.toThrow('Alchemy (gateway): HTTP 402: Payment Required');
	});
});
