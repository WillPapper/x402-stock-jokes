/** Receipt chips: one per seller (the name opens the panel, the amount links to Basescan). */
import { esc, money, plural, runLinks } from './dom.ts';
import { toggleHood } from './hood.ts';
import type { HoodKey, Joke, Payment } from './types.ts';

const NEEDLE: Record<Exclude<HoodKey, 'turns'>, string> = { stocktwits: 'StockTwits symbols', ceramic: 'Ceramic', joke: 'AI Gateway joke' };

export const isTurn = (p: Payment): boolean => p.label.includes('orchestrator');
const findPayment = (pays: Payment[], key: Exclude<HoodKey, 'turns'>) => pays.find((p) => p.label.includes(NEEDLE[key]));

/** A single payment as a chip; `upto` payments show the ceiling instead of a link. */
export function receiptChip(p: Payment | undefined, label?: string): string {
	if (!p) return '';
	const amt = money(p.authorizedUsdc) + ' USDC';
	if (p.tx) return `<span class="chip">${label ? esc(label) + ' ' : ''}<a href="${esc(p.tx)}" target="_blank" rel="noopener" title="USDC transfer on Basescan">${amt} ↗</a></span>`;
	return `<span class="chip" title="upto scheme: ceiling authorized, actual cost settled by AI Gateway">${label ? esc(label) + ' ' : ''}≤ ${amt}</span>`;
}

/** The agent's own turns as a chip, with the settled total once the chain has been consulted. */
export function turnsChip(turns: Payment[], settled?: number | null): string {
	if (!turns.length) return '';
	const ceiling = turns[0].authorizedUsdc;
	return `<span class="chip" title="upto scheme: this ceiling is authorized per turn; the real token cost is settled">${plural(turns.length, 'turn')} · ≤ ${money(ceiling, 2)} USDC each</span>${settled != null ? `<span class="chip" title="Settled on-chain for all AI Gateway calls during this joke (joke + turns)"><b>${money(settled)} USDC</b> settled</span>` : ''}`;
}

/** The chip row of a finished joke; wireBadges() makes the names open panels. */
export function receiptsRow(j: Joke): string {
	const pays = j.payments || [];
	const turns = pays.filter(isTurn);
	const group = (key: HoodKey, name: string, p: Payment | undefined) =>
		`<span class="chipgroup"><button type="button" class="badge" data-k="${key}" aria-expanded="false" title="See what ${esc(name)} returned">${esc(name)}</button>${p ? (p.tx ? `<a href="${esc(p.tx)}" target="_blank" rel="noopener" title="USDC transfer on Basescan">${money(p.authorizedUsdc)} ↗</a>` : `<span class="amt" title="upto scheme: ceiling authorized, actual cost settled by AI Gateway">≤ ${money(p.authorizedUsdc)}</span>`) : ''}</span>`;
	// The buyer's own 0.10 USDC: matched on-chain by the server (the gateway token carries no hash).
	const b = j.buyer;
	const x402 = j.paidBy !== 'x402' ? '' : b?.tx
		? `<span class="chip x402" title="The buyer's ${money(b.usdc, 2)} USDC through the Monetization Gateway, from ${esc(b.from)}">paid via x402 <a href="${esc(b.tx)}" target="_blank" rel="noopener" title="The buyer's USDC transfer on Basescan">${money(b.usdc, 2)} ↗</a></span>`
		: '<span class="chip x402" title="The buyer paid 0.10 USDC through the Monetization Gateway">paid via x402</span>';
	return `${x402}${group('stocktwits', 'StockTwits', findPayment(pays, 'stocktwits'))}${group('ceramic', 'Ceramic', findPayment(pays, 'ceramic'))}${group('joke', 'AI Gateway joke', findPayment(pays, 'joke'))}${group('turns', plural(turns.length, 'agent turn'), undefined)}${j.paid ? `<span class="chip" title="Settled USDC transfers for this joke: StockTwits + Ceramic ${j.paid.exactUsdc.toFixed(4)}, AI Gateway ${j.paid.aiUsdc.toFixed(4)}"><b>paid ${j.paid.totalUsdc.toFixed(4)} USDC</b> on-chain</span>` : ''}`;
}

/** Make the badges inside `el` open that joke's panels. */
export function wireBadges(el: Element, j: Joke): void {
	const pays = j.payments || [];
	const turns = pays.filter(isTurn);
	const steps = j.steps || {};
	el.querySelectorAll<HTMLElement>('.badge').forEach((b) => b.addEventListener('click', (e) => {
		e.stopPropagation();
		const key = b.dataset.k as HoodKey;
		const data = key === 'turns'
			? (turns.length ? turns : { note: 'No per-turn records for this joke.' })
			: (steps[key] || { note: 'The full response for this step was not archived (jokes made before 2026-10-16 20:10 UTC only kept their payments and facts).', facts: j.facts || [], payment: findPayment(pays, key) });
		toggleHood(el, key, data, j.conversationId ? runLinks(j.conversationId) : '', b);
	}));
}
