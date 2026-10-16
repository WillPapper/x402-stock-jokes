/**
 * The wallet's USDC history on Base, from Alchemy's Transfers API. Every x402
 * payment this app makes or receives is a USDC transfer, so this is the source
 * of truth for "USDC paid" and "USDC earned". Cached per isolate for 30 s.
 */
import { env } from 'cloudflare:workers';
import { USDC_BASE } from './x402.ts';

export const SELLERS: Record<string, string> = {
	'0x4d0da2c0343c4e7d54281a42485dedd068f5ffec': 'StockTwits',
	'0x4525f3c9b54697f6016635149c131bc9d219701a': 'Ceramic',
	'0x803f2c6673773c00f53ff2b6bddce24ea55c118a': 'AI Gateway',
};

export interface Transfer {
	hash: string;
	at: string;
	from: string;
	to: string;
	usdc: number;
	direction: 'out' | 'in';
	/** Known seller name for outflows, 'other' for anything else (e.g. test wallets). */
	party: string;
}

interface AlchemyTransfer {
	hash: string;
	from: string;
	to: string | null;
	value: number | null;
	metadata?: { blockTimestamp?: string };
}

let cache: { at: number; transfers: Transfer[] } | null = null;
let inflight: Promise<Transfer[]> | null = null;

function rpcUrl(): string | null {
	const key = (env as unknown as { ALCHEMY_API_KEY?: string }).ALCHEMY_API_KEY;
	return key ? `https://base-mainnet.g.alchemy.com/v2/${key}` : null;
}

async function fetchDirection(url: string, wallet: string, direction: 'out' | 'in'): Promise<Transfer[]> {
	const out: Transfer[] = [];
	let pageKey: string | undefined;
	for (let page = 0; page < 10; page++) {
		const params: Record<string, unknown> = {
			fromBlock: '0x0',
			toBlock: 'latest',
			[direction === 'out' ? 'fromAddress' : 'toAddress']: wallet,
			contractAddresses: [USDC_BASE],
			category: ['erc20'],
			withMetadata: true,
			order: 'desc',
			maxCount: '0x3e8',
			...(pageKey ? { pageKey } : {}),
		};
		const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'alchemy_getAssetTransfers', params: [params] }) });
		const body = (await res.json()) as { result?: { transfers: AlchemyTransfer[]; pageKey?: string }; error?: { message: string } };
		if (body.error) throw new Error(`Alchemy: ${body.error.message}`);
		for (const t of body.result?.transfers ?? []) {
			const counterparty = (direction === 'out' ? t.to : t.from)?.toLowerCase() ?? '';
			out.push({
				hash: t.hash,
				at: t.metadata?.blockTimestamp ?? '',
				from: t.from.toLowerCase(),
				to: (t.to ?? '').toLowerCase(),
				usdc: Number(t.value ?? 0),
				direction,
				party: direction === 'out' ? (SELLERS[counterparty] ?? 'other') : counterparty,
			});
		}
		pageKey = body.result?.pageKey;
		if (!pageKey) break;
	}
	return out;
}

export async function walletTransfers(wallet: string): Promise<Transfer[]> {
	if (cache && Date.now() - cache.at < 30_000) return cache.transfers;
	if (inflight) return inflight;
	const url = rpcUrl();
	if (!url) throw new Error('ALCHEMY_API_KEY is not set');
	inflight = (async () => {
		try {
			const [outs, ins] = await Promise.all([fetchDirection(url, wallet, 'out'), fetchDirection(url, wallet, 'in')]);
			const transfers = [...outs, ...ins].sort((a, b) => (a.at < b.at ? 1 : -1));
			cache = { at: Date.now(), transfers };
			return transfers;
		} finally {
			inflight = null;
		}
	})();
	return inflight;
}

export interface SpendSummary {
	/** USDC sent to known sellers (StockTwits, Ceramic, AI Gateway) — what the jokes actually cost. */
	paidUsdc: number;
	paidBySeller: Record<string, number>;
	paidCount: number;
	/** USDC sent elsewhere (e.g. funding a test wallet). */
	otherOutUsdc: number;
	/** USDC received, excluding deposits of 1 USDC or more (those are the owner funding the wallet). */
	earnedUsdc: number;
	earnedCount: number;
	latestAt: string | null;
}

export function summarize(transfers: Transfer[]): SpendSummary {
	const s: SpendSummary = { paidUsdc: 0, paidBySeller: {}, paidCount: 0, otherOutUsdc: 0, earnedUsdc: 0, earnedCount: 0, latestAt: transfers[0]?.at ?? null };
	for (const t of transfers) {
		if (t.direction === 'out') {
			if (t.party === 'other') s.otherOutUsdc += t.usdc;
			else {
				s.paidUsdc += t.usdc;
				s.paidCount++;
				s.paidBySeller[t.party] = (s.paidBySeller[t.party] ?? 0) + t.usdc;
			}
		} else if (t.usdc < 1) {
			s.earnedUsdc += t.usdc;
			s.earnedCount++;
		}
	}
	return s;
}

/** Real settled amounts for the exact-scheme receipts a joke recorded, by transaction hash. */
export function amountsByHash(transfers: Transfer[]): Map<string, number> {
	const m = new Map<string, number>();
	for (const t of transfers) if (t.direction === 'out') m.set(t.hash.toLowerCase(), (m.get(t.hash.toLowerCase()) ?? 0) + t.usdc);
	return m;
}
