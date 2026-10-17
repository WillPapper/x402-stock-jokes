/**
 * One x402 client for every paid upstream in this app.
 *
 * - StockTwits and Ceramic quote the `exact` scheme (USDC EIP-3009, no approval).
 * - Cloudflare AI Gateway quotes the `upto` scheme (Permit2 ceiling, actual cost
 *   settled; needs a one-time USDC.approve(Permit2) from the wallet).
 *
 * The wallet signer is wrapped so a `Budget` is consulted before anything is
 * signed. Receipts (`PAYMENT-RESPONSE`) are decoded and reported through
 * `onReceipt`, so callers can show Basescan links.
 */
import { x402Client } from '@x402/core/client';
import { ExactEvmScheme } from '@x402/evm/exact/client';
import { UptoEvmScheme } from '@x402/evm/upto/client';
import { wrapFetchWithPayment } from '@x402/fetch';
import { privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { Budget, BudgetExceededError, formatUsdc } from './budget.ts';

export const BASE_MAINNET = 'eip155:8453';
export const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as const;
export const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3' as const;

export interface PaymentQuote {
	scheme: string;
	network: string;
	amount: string;
	asset: string;
	payTo: string;
	maxTimeoutSeconds: number;
	extra?: Record<string, unknown>;
}

export interface PaymentRequired {
	x402Version: number;
	error?: string;
	resource?: { url?: string };
	accepts: PaymentQuote[];
	extensions?: Record<string, unknown>;
}

export interface Receipt {
	success: boolean;
	network?: string;
	payer?: string;
	transaction?: string;
	errorReason?: string;
	[key: string]: unknown;
}

export interface PaidResult {
	/** What was authorized (and, for `exact`, charged), in USDC base units. Null if nothing was signed. */
	authorized: bigint | null;
	receipt: Receipt | null;
	settled: boolean;
}

export interface ReceiptEvent extends PaidResult {
	url: string;
	scheme: string | null;
}

/** One HTTP round trip inside a paid call, as seen on the wire. */
export interface PaymentAttempt {
	status: number;
	durationMs: number;
	/** Cloudflare identifiers from the response (cf-ray, cf-aig-*, …). */
	ids: Record<string, string>;
	/** Decoded PAYMENT-REQUIRED on a 402 (the quote, or the rejection reason). */
	paymentRequired?: { error?: string; accepts?: PaymentQuote[]; quote?: Record<string, unknown> | null } | null;
	/** Summary of the PAYMENT-SIGNATURE we sent on this attempt, if any. */
	signature?: Record<string, unknown> | null;
	/** Decoded PAYMENT-RESPONSE, if any. */
	paymentResponse?: Receipt | null;
	bodySnippet?: string;
}

export interface PaymentEvent {
	label: string;
	url: string;
	method: string;
	ok: boolean;
	finalStatus: number;
	scheme: string | null;
	authorizedUsdc: string | null;
	settled: boolean;
	payer: string;
	attempts: PaymentAttempt[];
	totalMs: number;
	error?: string;
}

export interface PaidFetchOptions {
	/** The wallet key, or a getter resolved on first use (so secrets are read lazily). */
	privateKey: `0x${string}` | (() => `0x${string}`);
	budget: Budget;
	/** Dollar cap handed to the x402 client as a second line of defence, e.g. "$0.10". */
	maxUsdPerPayment: string;
	onReceipt?: (event: ReceiptEvent) => void;
	/** Detailed per-call record for logs and bug reports. */
	onEvent?: (event: PaymentEvent) => void;
	label?: string;
}

function decodeBase64Json<T>(header: string | null): T | null {
	if (!header) return null;
	try {
		const bytes = Uint8Array.from(atob(header), (c) => c.charCodeAt(0));
		return JSON.parse(new TextDecoder().decode(bytes)) as T;
	} catch {
		return null;
	}
}

export function decodeReceipt(header: string | null): Receipt | null {
	return decodeBase64Json<Receipt>(header);
}

export function decodePaymentRequired(header: string | null): PaymentRequired | null {
	return decodeBase64Json<PaymentRequired>(header);
}

export function basescanTx(receipt: Receipt | null): string | null {
	return receipt?.transaction ? `https://basescan.org/tx/${receipt.transaction}` : null;
}

/** The amount in the typed data the x402 client asks the wallet to sign. */
function amountFromTypedData(message: Record<string, unknown> | undefined): bigint | null {
	const permitted = message?.permitted as { amount?: unknown } | undefined;
	const raw = message?.value ?? permitted?.amount ?? message?.amount;
	if (raw === undefined || raw === null) return null;
	try {
		return BigInt(String(raw));
	} catch {
		return null;
	}
}

export function walletFromKey(privateKey: `0x${string}`): PrivateKeyAccount {
	return privateKeyToAccount(privateKey);
}

/**
 * Returns `fetch` that pays x402 challenges, plus a `last()` accessor for the
 * payment made by the most recent call on this instance. Callers that need
 * per-request results should create one paid fetch per logical request
 * (cheap: no network work happens at construction).
 */
export function createPaidFetch(options: PaidFetchOptions) {
	let cached: PrivateKeyAccount | null = null;
	const account = () => (cached ??= walletFromKey(typeof options.privateKey === 'function' ? options.privateKey() : options.privateKey));
	const { budget } = options;
	let pending: bigint | null = null;

	const guardedSigner = {
		get address() {
			return account().address;
		},
		async signTypedData(args: Parameters<PrivateKeyAccount['signTypedData']>[0]) {
			const amount = amountFromTypedData(args.message as Record<string, unknown> | undefined);
			if (amount === null) {
				throw new BudgetExceededError("refusing to sign: couldn't find the payment amount in the typed data");
			}
			budget.reserve(amount);
			pending = amount;
			return account().signTypedData(args);
		},
	};

	// The scheme clients read the signer's address at construction, so build the
	// x402 client on first use: secrets are read when a request is made, not at
	// module load (Workers validate modules before secrets exist).
	let paying: ((input: string, init?: RequestInit) => Promise<Response>) | null = null;
	const fetchWithPayment = () => {
		if (paying) return paying;
		const client = x402Client.fromConfig({
			schemes: [
				{ network: BASE_MAINNET, client: new ExactEvmScheme(guardedSigner as never) },
				{ network: BASE_MAINNET, client: new UptoEvmScheme(guardedSigner as never) },
			],
			spendControls: { maxAmountPerPayment: options.maxUsdPerPayment },
		});
		return (paying = wrapFetchWithPayment(observedFetch as typeof fetch, client) as unknown as typeof paying);
	};

	let attempts: PaymentAttempt[] = [];
	const observedFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const started = Date.now();
		const res = await fetch(input as string, init);
		const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
		const sig = headers.get('PAYMENT-SIGNATURE');
		const pr = res.status === 402 ? decodePaymentRequired(res.headers.get('PAYMENT-REQUIRED')) : null;
		const quoteToken = (pr?.extensions as { 'cloudflare-quote'?: { info?: { quoteToken?: string } } } | undefined)?.['cloudflare-quote']?.info?.quoteToken;
		const attempt: PaymentAttempt = {
			status: res.status,
			durationMs: Date.now() - started,
			ids: upstreamIdsOf(res),
			paymentRequired: pr ? { error: pr.error, accepts: pr.accepts, quote: quoteToken ? jwtPayloadOf(quoteToken) : null } : null,
			signature: sig ? summarizeSignature(sig) : null,
			paymentResponse: decodeReceipt(res.headers.get('PAYMENT-RESPONSE')),
		};
		if (!res.ok && res.status !== 402) attempt.bodySnippet = (await res.clone().text()).slice(0, 300);
		attempts.push(attempt);
		return res;
	};

	let last: PaidResult = { authorized: null, receipt: null, settled: false };

	async function paidFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
		pending = null;
		attempts = [];
		const started = Date.now();
		const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
		const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
		const emit = (ok: boolean, finalStatus: number, error?: string) =>
			options.onEvent?.({
				label: options.label ?? url,
				url,
				method,
				ok,
				finalStatus,
				scheme: attempts.find((a) => a.paymentRequired?.accepts?.[0])?.paymentRequired?.accepts?.[0]?.scheme ?? null,
				authorizedUsdc: pending === null ? null : formatUsdc(pending),
				settled: last.settled,
				payer: account().address,
				attempts,
				totalMs: Date.now() - started,
				...(error ? { error } : {}),
			});
		let res: Response;
		try {
			res = await fetchWithPayment()!(input as string, init);
		} catch (err) {
			if (pending !== null) budget.release(pending);
			last = { authorized: pending, receipt: null, settled: false };
			emit(false, attempts.at(-1)?.status ?? 0, (err as Error).message);
			throw err;
		}
		const receipt = decodeReceipt(res.headers.get('PAYMENT-RESPONSE'));
		// A successful receipt means the money moved, even if the seller then failed the
		// request (Alchemy's gateway settled a top-up and answered 500): count it.
		const settled = receipt?.success === true;
		const authorized = pending;
		if (authorized !== null) {
			if (settled) budget.commit(authorized);
			else budget.release(authorized);
		}
		last = { authorized, receipt, settled };
		options.onReceipt?.({ ...last, url, scheme: receipt ? (receipt.scheme as string | undefined) ?? null : null });
		emit(res.ok, res.status, res.ok ? undefined : `HTTP ${res.status}${attempts.at(-1)?.paymentRequired?.error ? ': ' + attempts.at(-1)!.paymentRequired!.error : ''}`);
		return res;
	}

	// A method, not a getter: Object.assign would invoke a getter at module load.
	return Object.assign(paidFetch, {
		walletAddress: () => account().address,
		last: () => last,
		describeLast: () =>
			last.authorized === null
				? 'no payment'
				: `${last.settled ? 'paid' : 'authorized (not settled)'} ${formatUsdc(last.authorized)} USDC${basescanTx(last.receipt) ? ' ' + basescanTx(last.receipt) : ''}`,
	});
}

function upstreamIdsOf(res: Response): Record<string, string> {
	const out: Record<string, string> = {};
	for (const h of ['cf-ray', 'cf-aig-request-id', 'cf-aig-event-id', 'cf-aig-trace-id', 'cf-aig-log-id', 'cf-auditlog-id', 'api-version', 'x-request-id', 'date']) {
		const v = res.headers.get(h);
		if (v) out[h] = v;
	}
	return out;
}

function jwtPayloadOf(token: string): Record<string, unknown> | null {
	try {
		const part = token.split('.')[1] ?? '';
		return JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/').padEnd(part.length + ((4 - (part.length % 4)) % 4), '='))) as Record<string, unknown>;
	} catch {
		return null;
	}
}

/** The PAYMENT-SIGNATURE we sent, minus the signature bytes: enough to trace a payment on the seller side. */
function summarizeSignature(header: string): Record<string, unknown> | null {
	const p = decodeBase64Json<{ x402Version?: number; accepted?: PaymentQuote; payload?: { authorization?: Record<string, unknown>; permit2Authorization?: Record<string, unknown>; signature?: string } }>(header);
	if (!p) return null;
	const auth = p.payload?.authorization ?? p.payload?.permit2Authorization ?? null;
	return {
		x402Version: p.x402Version,
		scheme: p.accepted?.scheme,
		network: p.accepted?.network,
		amount: p.accepted?.amount,
		payTo: p.accepted?.payTo,
		authorization: auth,
		signatureLength: p.payload?.signature?.length ?? 0,
	};
}
