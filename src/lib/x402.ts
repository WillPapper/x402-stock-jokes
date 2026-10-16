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

export interface PaidFetchOptions {
	/** The wallet key, or a getter resolved on first use (so secrets are read lazily). */
	privateKey: `0x${string}` | (() => `0x${string}`);
	budget: Budget;
	/** Dollar cap handed to the x402 client as a second line of defence, e.g. "$0.10". */
	maxUsdPerPayment: string;
	onReceipt?: (event: ReceiptEvent) => void;
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
		return (paying = wrapFetchWithPayment(fetch, client) as unknown as typeof paying);
	};

	let last: PaidResult = { authorized: null, receipt: null, settled: false };

	async function paidFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
		pending = null;
		const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
		let res: Response;
		try {
			res = await fetchWithPayment()!(input as string, init);
		} catch (err) {
			if (pending !== null) budget.release(pending);
			last = { authorized: pending, receipt: null, settled: false };
			throw err;
		}
		const receipt = decodeReceipt(res.headers.get('PAYMENT-RESPONSE'));
		const settled = res.ok && receipt?.success === true;
		const authorized = pending;
		if (authorized !== null) {
			if (settled) budget.commit(authorized);
			else budget.release(authorized);
		}
		last = { authorized, receipt, settled };
		options.onReceipt?.({ ...last, url, scheme: receipt ? (receipt.scheme as string | undefined) ?? null : null });
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
