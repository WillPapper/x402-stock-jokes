/**
 * "Under the hood" panels: a human summary of what a paid step returned, then
 * the raw JSON behind a disclosure. One panel is open per container (the steps
 * list, a feed card, the paywall) at a time; Escape closes them all.
 */
import { esc, money } from './dom.ts';
import type { HoodKey } from './types.ts';

/* Tool outputs are loosely shaped (they come straight from the sellers), so the summaries read them untyped. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = any;

const HOOD: Record<HoodKey, { title: string; what: string }> = {
	stocktwits: { title: 'Step 1 · StockTwits', what: "GET /api/2/symbols/show/<TICKER>.json through Cloudflare's Monetization Gateway (0.001 USDC, x402 exact scheme, settled on Base), plus the free symbol stream for recent posts." },
	ceramic: { title: 'Step 2 · Ceramic search', what: 'Three keyword searches on POST https://api.ceramic.ai/search through the Monetization Gateway (0.001 USDC each, x402 exact). Ceramic is lexical with no date filter and its index trails the news by months, so the app merges the results, drops listicles, quote pages, undated and older pieces, ranks what is left newest first, and tells both models how old the newest item is.' },
	joke: { title: 'Step 3 · AI Gateway', what: 'POST /ai/run on Cloudflare AI Gateway with Payment-Method: x402 (upto scheme: a ceiling is authorized, the real token cost is settled).' },
	turns: { title: 'Agent turns · AI Gateway', what: 'The orchestrator model itself runs through AI Gateway machine payments: every turn is an x402 authorization.' },
};

const dl = (rows: [string, string | null | undefined][]) => `<dl>${rows.filter(([, v]) => v != null && v !== '').map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join('')}</dl>`;

function hoodSummary(key: HoodKey, data: Loose): string {
	// Note-only objects are placeholders; tool outputs may carry a note too.
	if (!data || (data.note && Object.keys(data).length === 1)) return `<p>${esc(data?.note || 'No data for this step.')}</p>`;
	if (key === 'stocktwits') {
		const d = data, st = d.stats || d;
		const quotes: Loose[] = (d.quotes || d.sampleMessages || []).slice(0, 4);
		return dl([
			['Symbol', esc([d.title, d.symbol, d.exchange].filter(Boolean).join(' · '))],
			['Price', d.latestPrice ? esc(`$${d.latestPrice}${d.priceLow && d.priceHigh ? ` (range $${d.priceLow} – $${d.priceHigh})` : ''}`) : null],
			['Mood', d.mood ? esc(d.mood) : null],
			['Sentiment', st.messagesSampled != null ? esc(`${st.bullish} bullish · ${st.bearish} bearish · ${st.neutral} neutral of ${st.messagesSampled} posts`) : null],
			['Change', st.sentimentChange != null ? esc(`sentiment ${st.sentimentChange > 0 ? '+' : ''}${st.sentimentChange} · volume ${st.volumeChange > 0 ? '+' : ''}${st.volumeChange}`) : null],
			['Watchlist', st.watchlistCount != null ? esc(Number(st.watchlistCount).toLocaleString() + ' people') : null],
		]) + (quotes.length ? `<p>Quotable posts:</p><ul>${quotes.map((m) => `<li>${esc(typeof m === 'string' ? m : m.text || m.body || JSON.stringify(m))}${m && m.sentiment ? ` <span class="muted">· ${esc(m.sentiment)}</span>` : ''}</li>`).join('')}</ul>` : '');
	}
	if (key === 'ceramic') {
		const rs: Loose[] = data.results || [];
		const qs: string[] = data.queries || (data.query ? [data.query] : []);
		const dropped = data.dropped ? Object.entries(data.dropped as Record<string, number>).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${k}`).join(', ') : '';
		return dl([
			[qs.length > 1 ? 'Queries' : 'Query', qs.map(esc).join('<br>')],
			['Kept', data.rawCount != null ? esc(`${rs.length} of ${data.rawCount} results${dropped ? ` (dropped: ${dropped})` : ''}`) : null],
			['Newest', data.newestDate ? esc(data.newestDate) : (data.results ? 'no item carries a full date' : null)],
		]) + (rs.length ? `<ul>${rs.map((r) => `<li>${r.url ? `<a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.title)}</a>` : esc(r.title)}${r.source || r.date ? ` <span class="muted">· ${esc([r.source, r.date].filter(Boolean).join(' · '))}</span>` : ''}${r.description ? ` <span class="muted">· ${esc(r.description.slice(0, 140))}${r.description.length > 140 ? '…' : ''}</span>` : ''}</li>`).join('')}</ul>` : '<p>No results.</p>');
	}
	if (key === 'joke') {
		const facts: string[] = data.facts || data.promptFacts || data.input?.facts || [];
		const u = data.usage;
		return dl([
			['Model', esc(data.model || '')],
			['Tokens', u ? esc(`${u.prompt_tokens ?? u.input_tokens ?? '?'} in · ${u.completion_tokens ?? u.output_tokens ?? '?'} out`) : null],
		]) + (facts.length ? `<p>Facts passed in:</p><ul>${facts.map((f) => `<li>${esc(f)}</li>`).join('')}</ul>` : '') + (data.joke ? `<p>The model's answer:</p><blockquote>${esc(data.joke)}</blockquote>` : '');
	}
	if (key === 'turns') {
		const ts: Loose[] = Array.isArray(data) ? data : [];
		const ceiling = ts[0]?.authorizedUsdc;
		return dl([
			['Turns', esc(String(ts.length))],
			['Ceiling', ceiling ? esc(`≤ ${money(ceiling)} USDC authorized per turn; the real token cost (a fraction of a cent) is what settles`) : null],
			['Scheme', ts[0]?.scheme ? esc(ts[0].scheme) : null],
		]) + (ts.length ? `<ul>${ts.map((t, i) => `<li>Turn ${i + 1} · ${esc(new Date(t.at).toLocaleTimeString())}${t.ok === false ? ' · <span class="err">failed</span>' : ''}</li>`).join('')}</ul>` : '');
	}
	return '';
}

/**
 * Rebuild a panel's body in place, so an open panel can follow a running step
 * without closing (the close button and focus stay put). Returns false when
 * nothing changed.
 */
export function fillHood(el: HTMLElement, key: HoodKey, data: unknown, extra?: string): boolean {
	const h = HOOD[key] || { title: key, what: '' };
	const sig = JSON.stringify(data) + '|' + (extra || '');
	if (el.dataset.sig === sig) return false;
	el.dataset.sig = sig;
	const rawOpen = el.querySelector('details')?.open || false;
	el.querySelector('.hood-body')!.innerHTML = `<h4>${esc(h.title)}</h4><p>${esc(h.what)}</p>${hoodSummary(key, data)}<details${rawOpen ? ' open' : ''}><summary>Raw response</summary><pre>${esc(JSON.stringify(data, null, 2) || 'no data')}</pre></details>${extra ? `<div class="links">${extra}</div>` : ''}`;
	return true;
}

function hoodPanel(key: HoodKey, data: unknown, extra?: string): HTMLElement {
	const el = document.createElement('div');
	el.className = 'hood';
	el.innerHTML = '<button type="button" class="close" aria-label="Close">×</button><div class="hood-body"></div>';
	fillHood(el, key, data, extra);
	return el;
}

export function closeHood(container: Element): void {
	container.querySelectorAll('.hood').forEach((h) => h.remove());
	container.querySelectorAll('[aria-expanded="true"]').forEach((b) => b.setAttribute('aria-expanded', 'false'));
}

/** Open the panel for `key` inside `container` (mounted in `mount` when given), or close it if it is the one already open. */
export function toggleHood(container: Element, key: HoodKey, data: unknown, extra: string | undefined, badge: HTMLElement | null, mount?: Element): void {
	const existing = container.querySelector<HTMLElement>('.hood');
	const wasOpen = existing && existing.dataset.k === key;
	closeHood(container);
	if (wasOpen) return;
	const panel = hoodPanel(key, data, extra);
	panel.dataset.k = key;
	panel.querySelector('.close')!.addEventListener('click', (e) => { e.stopPropagation(); closeHood(container); if (badge) badge.focus(); });
	(mount || container).appendChild(panel);
	if (badge) badge.setAttribute('aria-expanded', 'true');
}

// Escape closes every open panel and hands focus back to the badge that opened it.
document.addEventListener('keydown', (e) => {
	if (e.key !== 'Escape') return;
	const panels = [...document.querySelectorAll('.hood')];
	if (!panels.length) return;
	for (const h of panels) {
		const container = h.closest('#steps, .feed .card, #paywall');
		if (!container) { h.remove(); continue; }
		const badge = container.querySelector<HTMLElement>('.badge[aria-expanded="true"], .steptitle[aria-expanded="true"]');
		closeHood(container);
		if (badge) badge.focus();
	}
	e.preventDefault();
});
