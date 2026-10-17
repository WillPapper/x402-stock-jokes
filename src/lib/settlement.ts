/**
 * What each joke actually cost on-chain, from the wallet's USDC transfers:
 * exact-scheme payments (StockTwits, Ceramic) matched by transaction hash; AI
 * Gateway settlements (which land within seconds of each call) matched by a
 * time window around the joke, since the gateway returns no receipt; and the
 * buyer's 0.10 USDC matched to the gate's admission time (src/lib/buyer.ts).
 *
 * The result is computed once per joke and stored in `jokes.settled`: a joke
 * younger than SETTLE_AFTER_MS is still computed live (its transfers may not
 * have landed), and a row is only stored when every receipt it recorded was
 * found on the chain, so a short transfer history cannot freeze zeros.
 */
import { PRICE_USDC } from './access.ts';
import { matchBuyers } from './buyer.ts';
import { saveSettled, type JokeRow, type Settled } from './db.ts';
import { config } from './env.ts';
import { x402RunTimes } from './runs.ts';
import { amountsByHash, walletTransfers, type Transfer } from './transfers.ts';
import { basescanTxUrl } from './tx.ts';
import { walletFromKey } from './x402.ts';

const JOKE_WINDOW_BEFORE_MS = 180_000;
const JOKE_WINDOW_AFTER_MS = 30_000;
/** Buyer settlements take up to two minutes; wait a little longer before storing. */
export const SETTLE_AFTER_MS = 3 * 60_000;

/** A joke row with its settlement folded in (`paid`, `buyer`) in place of the stored blob. */
export type SettledJoke = Omit<JokeRow, 'settled'> & Settled;

export async function withSettled(rows: JokeRow[], persist?: (work: Promise<unknown>) => void): Promise<SettledJoke[]> {
	const fold = (r: JokeRow, settled: Settled): SettledJoke => {
		const { settled: _stored, ...rest } = r;
		return { ...rest, ...settled };
	};
	const pending = rows.filter((r) => !r.settled);
	if (!pending.length) return rows.map((r) => fold(r, r.settled as Settled));

	let transfers: Transfer[] = [];
	try {
		transfers = await walletTransfers(walletFromKey(config.privateKey).address);
	} catch (err) {
		console.warn('transfers unavailable', (err as Error).message.slice(0, 120));
	}
	const byHash = amountsByHash(transfers);
	const ai = transfers.filter((t) => t.direction === 'out' && t.party === 'AI Gateway' && t.at).map((t) => ({ ms: Date.parse(t.at), usdc: t.usdc }));
	const paidIds = pending.filter((r) => r.paidBy === 'x402').map((r) => r.conversationId);
	let buyers = new Map<string, Transfer>();
	if (paidIds.length && transfers.length) {
		try {
			buyers = matchBuyers(await x402RunTimes(paidIds), transfers, Number(PRICE_USDC));
		} catch (err) {
			console.warn('buyer match unavailable', (err as Error).message.slice(0, 120));
		}
	}

	return rows.map((r) => {
		if (r.settled) return fold(r, r.settled);
		const b = buyers.get(r.conversationId);
		const buyer: Settled['buyer'] = b ? { usdc: b.usdc, from: b.from, tx: basescanTxUrl(b.hash), at: b.at } : null;
		let exactUsdc = 0;
		let exactCount = 0;
		let receipts = 0;
		for (const p of r.payments) {
			const hash = p.tx?.split('/tx/')[1]?.toLowerCase();
			if (!hash) continue;
			receipts++;
			if (byHash.has(hash)) {
				exactUsdc += byHash.get(hash)!;
				exactCount++;
			}
		}
		const end = Date.parse(r.createdAt);
		const inWindow = ai.filter((t) => t.ms >= end - JOKE_WINDOW_BEFORE_MS && t.ms <= end + JOKE_WINDOW_AFTER_MS);
		const aiUsdc = inWindow.reduce((s, t) => s + t.usdc, 0);
		const settled: Settled = { paid: { exactUsdc: +exactUsdc.toFixed(6), exactCount, aiUsdc: +aiUsdc.toFixed(6), aiCount: inWindow.length, totalUsdc: +(exactUsdc + aiUsdc).toFixed(6) }, buyer };
		const complete = transfers.length > 0 && exactCount === receipts && (r.paidBy !== 'x402' || buyer !== null);
		if (persist && complete && Date.now() - end > SETTLE_AFTER_MS) persist(saveSettled(r.id, settled).catch((err) => console.warn('settled persist failed', (err as Error).message.slice(0, 120))));
		return fold(r, settled);
	});
}
