/** Human-readable permalink: one joke as a shareable page with Open Graph tags (GET /j/<id>). */
import { Hono } from 'hono';
import { jokeForConversation } from '../lib/db.ts';
import { runStatus } from '../lib/runs.ts';
import { withSettled } from '../lib/settlement.ts';

export const permalinkRoutes = new Hono();

const escapeHtml = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);

const PAGE_CSS = `:root{--bg:#f6f4ee;--fg:#1d1c1a;--muted:#6b675f;--card:#fff;--line:#e4e0d6;--accent:#0d6b5e;--chip:#eef4f2}@media(prefers-color-scheme:dark){:root{--bg:#141413;--fg:#ecebe7;--muted:#9b978f;--card:#1e1e1c;--line:#2d2d2a;--accent:#5fd3bf;--chip:#242a28}}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}main{max-width:720px;margin:0 auto;padding:36px 16px 64px}a{color:var(--accent);text-underline-offset:2px}.top{font-size:14px;color:var(--muted);margin:0 0 18px}.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:20px 22px}.meta{display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap;color:var(--muted);font-size:13px;margin-bottom:8px}.ticker{font-weight:700;color:var(--fg);font-size:15px}.joke{font-size:24px;line-height:1.35;margin:0 0 14px;white-space:pre-wrap}.based{color:var(--muted);font-size:15px;margin:0 0 14px}.chips{display:flex;flex-wrap:wrap;gap:6px}.chip{display:inline-flex;align-items:center;min-height:30px;font:13px/1 ui-monospace,SFMono-Regular,Menlo,monospace;padding:0 10px;border-radius:999px;background:var(--chip);white-space:nowrap;gap:6px}.chip a{text-decoration:none}.chip.x402{background:var(--accent);color:#fff;font-weight:600}.chip.x402 a{color:inherit;border-left:1px solid rgba(255,255,255,.4);padding-left:8px;margin-left:2px}.chip.x402 a:hover{text-decoration:underline}.links{margin-top:18px;font-size:14px;color:var(--muted)}.cta{display:inline-block;margin-top:22px;padding:12px 18px;border-radius:10px;background:var(--accent);color:#fff;font-weight:600;text-decoration:none}`;

const FAVICON = `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='14' fill='%230d6b5e'/%3E%3Ctext x='32' y='44' font-family='system-ui,sans-serif' font-size='36' font-weight='700' text-anchor='middle' fill='%23fff'%3E%24%3C/text%3E%3C/svg%3E`;

function pageShell(opts: { title: string; description: string; url: string; body: string; extraHead?: string }) {
	const t = escapeHtml(opts.title);
	const d = escapeHtml(opts.description);
	const u = escapeHtml(opts.url);
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${t}</title><meta name="description" content="${d}"><link rel="canonical" href="${u}"><meta property="og:type" content="article"><meta property="og:site_name" content="Stock Jokes"><meta property="og:title" content="${t}"><meta property="og:description" content="${d}"><meta property="og:url" content="${u}"><meta name="twitter:card" content="summary"><meta name="twitter:title" content="${t}"><meta name="twitter:description" content="${d}"><link rel="icon" href="${FAVICON}">${opts.extraHead ?? ''}<style>${PAGE_CSS}</style></head><body><main><p class="top"><a href="/">Stock Jokes</a> · every step is an x402 micro-payment in USDC on Base</p>${opts.body}</main></body></html>`;
}

const SELLER_LABEL: [needle: string, label: string][] = [['StockTwits symbols', 'StockTwits'], ['Ceramic', 'Ceramic'], ['AI Gateway joke', 'AI Gateway joke']];

permalinkRoutes.get('/j/:id', async (c) => {
	const id = c.req.param('id');
	if (!/^[A-Za-z0-9._-]{1,80}$/.test(id)) return c.text('bad id', 400);
	const origin = new URL(c.req.url).origin;
	const url = `${origin}/j/${id}`;
	const row = await jokeForConversation(id);
	if (!row) {
		const st = await runStatus(id);
		if (st.outcome === 'unknown') return c.html(pageShell({ title: 'No such joke · Stock Jokes', description: 'There is no joke with this id.', url, body: `<div class="card"><p class="joke">There is no joke with this id.</p><p class="based">It may have been a run that never finished.</p></div><a class="cta" href="/">Ask for a joke</a>` }), 404);
		if (st.done) return c.html(pageShell({ title: 'Run failed · Stock Jokes', description: 'This run stopped before a joke was written.', url, body: `<div class="card"><p class="joke">This run stopped before a joke was written.</p><p class="based">${escapeHtml(st.error ?? st.outcome)}</p><p class="links"><a href="/joke/${escapeHtml(id)}">Run status (JSON)</a></p></div><a class="cta" href="/">Try another ticker</a>` }), 404);
		return c.html(pageShell({ title: 'Joke in progress · Stock Jokes', description: 'The agent is still working on this joke.', url, extraHead: '<meta http-equiv="refresh" content="5">', body: `<div class="card"><p class="joke">The agent is still working on this joke…</p><p class="based">${st.turns} paid model turn${st.turns === 1 ? '' : 's'} so far. This page reloads every few seconds.</p><p class="links"><a href="/?run=${escapeHtml(id)}">Watch the steps live</a> · <a href="/joke/${escapeHtml(id)}">Run status (JSON)</a></p></div>` }));
	}
	const [j] = await withSettled([row]);
	const turns = row.payments.filter((p) => p.label.includes('orchestrator'));
	const chip = (label: string, p: (typeof row.payments)[number] | undefined) => {
		if (!p) return '';
		const amt = Number(p.authorizedUsdc ?? 0).toFixed(4);
		return p.tx ? `<span class="chip">${escapeHtml(label)} <a href="${escapeHtml(p.tx)}" target="_blank" rel="noopener" title="USDC transfer on Basescan">${amt} ↗</a></span>` : `<span class="chip" title="upto scheme: ceiling authorized, actual cost settled">${escapeHtml(label)} ≤ ${amt}</span>`;
	};
	const chips = [
		row.paidBy === 'x402'
			? j.buyer?.tx
				? `<span class="chip x402" title="The buyer's ${j.buyer.usdc.toFixed(2)} USDC through the Monetization Gateway, from ${escapeHtml(j.buyer.from)}">paid via x402 <a href="${escapeHtml(j.buyer.tx)}" target="_blank" rel="noopener" title="The buyer's USDC transfer on Basescan">${j.buyer.usdc.toFixed(2)} ↗</a></span>`
				: '<span class="chip x402" title="The buyer paid 0.10 USDC through the Monetization Gateway">paid via x402</span>'
			: '',
		...SELLER_LABEL.map(([needle, label]) => chip(label, row.payments.find((p) => p.label.includes(needle)))),
		turns.length ? `<span class="chip">${turns.length} agent turn${turns.length === 1 ? '' : 's'}</span>` : '',
		j.paid ? `<span class="chip" title="Settled USDC transfers for this joke"><b>paid ${j.paid.totalUsdc.toFixed(4)} USDC</b> on-chain</span>` : '',
	].join('');
	const facts = row.facts.slice(0, 3).map((f) => f.trim().replace(/[.;]+$/, ''));
	const when = new Date(row.createdAt);
	const title = `A joke about ${row.ticker}${row.title ? ` (${row.title})` : ''} · Stock Jokes`;
	const body = `<article class="card"><div class="meta"><span><span class="ticker">${escapeHtml(row.ticker)}</span>${row.title ? ' · ' + escapeHtml(row.title) : ''}</span><time datetime="${escapeHtml(row.createdAt)}">${escapeHtml(when.toUTCString().replace(/:\d\d GMT$/, ' UTC'))}</time></div><p class="joke">${escapeHtml(row.joke)}</p>${facts.length ? `<p class="based">Based on: ${facts.map(escapeHtml).join(' · ')}</p>` : ''}<div class="chips">${chips}</div><p class="links">Written by ${escapeHtml(row.jokeModel ?? 'an AI Gateway model')}${row.orchestratorModel ? `, orchestrated by ${escapeHtml(row.orchestratorModel)}` : ''}. <a href="/joke/${escapeHtml(id)}">Run status (JSON)</a> · <a href="/api/events?conversation=${escapeHtml(id)}">x402 gateway events</a></p></article><a class="cta" href="/?ticker=${escapeHtml(row.ticker)}">Get a fresh joke about ${escapeHtml(row.ticker)}</a>`;
	c.header('cache-control', 'public, max-age=60');
	return c.html(pageShell({ title, description: row.joke, url, body }));
});
