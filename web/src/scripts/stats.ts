/** The counters and the jokes-per-hour sparkline (Stats.astro), from /api/stats. */
import { $, plural } from './dom.ts';
import type { Stats } from './types.ts';

const SELLER_ORDER = ['AI Gateway', 'StockTwits', 'Ceramic'];
const count = $('#s-count'), countDetail = $('#s-count-detail'), paid = $('#s-paid'), paidDetail = $('#s-paid-detail'), earned = $('#s-earned'), earnedDetail = $('#s-earned-detail');
const spark = $<SVGSVGElement>('#spark'), sparkPeak = $('#sparkpeak');

function sparkline(perHour: Stats['perHour']): void {
	const W = 240, H = 48;
	const now = Date.now();
	const buckets: { key: string; count: number; at: Date }[] = [];
	for (let i = 23; i >= 0; i--) { const t = new Date(now - i * 3600e3); t.setMinutes(0, 0, 0); buckets.push({ key: t.toISOString().slice(0, 13), count: 0, at: t }); }
	for (const h of perHour || []) { const b = buckets.find((x) => x.key === String(h.hour).slice(0, 13)); if (b) b.count = h.count; }
	const max = Math.max(1, ...buckets.map((b) => b.count)); const bw = W / 24;
	spark.innerHTML = buckets.map((b, i) => `<rect x="${(i * bw + 1).toFixed(1)}" y="${(H - (b.count / max) * (H - 4)).toFixed(1)}" width="${(bw - 2).toFixed(1)}" height="${((b.count / max) * (H - 4)).toFixed(1)}" rx="1.5" fill="${b.count ? 'var(--accent)' : 'var(--line)'}"><title>${b.at.toLocaleString([], { hour: 'numeric' })} — ${b.count}</title></rect>`).join('');
	const peak = buckets.reduce((a, b) => (b.count > a.count ? b : a), buckets[0]);
	const sum = buckets.reduce((s, b) => s + b.count, 0);
	sparkPeak.textContent = sum ? `${sum} in 24h · peak ${peak.count} at ${peak.at.toLocaleTimeString([], { hour: 'numeric' })}` : 'none in the last 24h';
}

/** Fetch and paint the counters; resolves to the joke count, or null when the request failed. */
export async function refreshStats(): Promise<number | null> {
	try {
		const s = (await (await fetch('/api/stats')).json()) as Stats;
		count.textContent = String(s.count);
		countDetail.textContent = s.tickers ? plural(s.tickers, 'ticker') : '';
		if (s.chain) {
			paid.textContent = s.chain.paidUsdc.toFixed(4);
			const by = s.chain.paidBySeller || {};
			const keys = Object.keys(by).sort((a, b) => (SELLER_ORDER.indexOf(a) + 1 || 99) - (SELLER_ORDER.indexOf(b) + 1 || 99));
			paidDetail.textContent = keys.map((k) => `${k} ${by[k].toFixed(3)}`).join(' · ') + ` · ${s.chain.paidCount} transfers`;
		} else { paid.textContent = '–'; paidDetail.textContent = 'chain data unavailable'; }
		earned.textContent = s.chain ? s.chain.earnedUsdc.toFixed(2) : Number(s.earnedFromJokesUsdc).toFixed(2);
		earnedDetail.textContent = s.paidJokes ? `${plural(s.paidJokes, 'paid joke')} · 0.10 each` : '';
		sparkline(s.perHour);
		return s.count;
	} catch { return null; }
}
