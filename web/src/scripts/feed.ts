/**
 * The live feed (Feed.astro): every joke ever made, newest first, polled from
 * /api/jokes every 3 s with a `before` cursor for paging back. Also drives the
 * stats refresh, since new rows change the counters.
 */
import { emit, on } from './bus.ts';
import { $, cleanFact, esc, plural, scrollMode, show } from './dom.ts';
import { receiptsRow, wireBadges } from './receipts.ts';
import { refreshStats } from './stats.ts';
import { tickTimes, timeEl } from './time.ts';
import type { Joke } from './types.ts';

const feed = $('#feed'), feedEmpty = $('#feedempty'), feedCount = $('#feedcount'), moreWrap = $('#morewrap'), more = $<HTMLButtonElement>('#more');
let newest: string | null = null, oldest: string | null = null, total: number | null = null;
const seen = new Set<string>();

function jokeCard(j: Joke, isNew: boolean): HTMLElement {
	const el = document.createElement('article');
	el.className = 'card' + (isNew ? ' new' : '');
	el.dataset.id = j.id;
	el.innerHTML = `<div class="meta"><span><span class="ticker">${esc(j.ticker)}</span>${j.title ? ' · ' + esc(j.title) : ''}</span>${j.conversationId ? `<a class="plink" href="/j/${encodeURIComponent(j.conversationId)}" title="Permalink to this joke">${timeEl(j.createdAt)}</a>` : `<span>${timeEl(j.createdAt)}</span>`}</div>
		<p class="joke">${esc(j.joke)}</p>
		<div class="step-detail">${esc((j.facts || []).slice(0, 3).map(cleanFact).join(' · '))}</div>
		<div class="receipts">${receiptsRow(j)}</div>`;
	wireBadges(el, j);
	return el;
}

const updateMore = () => show(moreWrap, total != null && seen.size < total && oldest != null);

async function loadStats(): Promise<void> {
	const n = await refreshStats();
	if (n != null) { total = n; feedCount.textContent = total ? plural(total, 'joke') : ''; }
	updateMore();
}

// The ticker field suggests symbols the feed already has jokes for (most recent first).
const tickerSeen = new Map<string, string>();
function noteTickers(jokes: Joke[]): void {
	for (const j of jokes) if (j.ticker && (!tickerSeen.has(j.ticker) || tickerSeen.get(j.ticker)! < j.createdAt)) tickerSeen.set(j.ticker, j.createdAt);
	emit('feed:tickers', { tickers: [...tickerSeen.entries()].sort((a, b) => (a[1] < b[1] ? 1 : -1)).slice(0, 20).map(([t]) => t) });
}

async function refreshFeed(): Promise<void> {
	try {
		const url = newest ? `/api/jokes?after=${encodeURIComponent(newest)}&limit=50` : '/api/jokes?limit=30';
		const { jokes } = (await (await fetch(url)).json()) as { jokes: Joke[] };
		const fresh = jokes.filter((j) => !seen.has(j.id));
		tickTimes();
		if (!seen.size && !fresh.length) feedEmpty.textContent = 'No jokes yet.';
		if (!fresh.length) return;
		feedEmpty.remove();
		noteTickers(fresh);
		// The first page is newest-first; `after` pages are oldest-first. Prepend oldest first so the newest ends on top.
		const ordered = fresh.slice().sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
		for (const j of ordered) { seen.add(j.id); feed.prepend(jokeCard(j, !!newest)); if (!newest || j.createdAt > newest) newest = j.createdAt; if (!oldest || j.createdAt < oldest) oldest = j.createdAt; }
		loadStats();
	} catch {}
}

async function loadOlder(): Promise<void> {
	more.disabled = true; more.textContent = 'Loading…';
	try {
		const { jokes } = (await (await fetch(`/api/jokes?before=${encodeURIComponent(oldest!)}&limit=30`)).json()) as { jokes: Joke[] };
		for (const j of jokes) { if (seen.has(j.id)) continue; seen.add(j.id); feed.appendChild(jokeCard(j, false)); if (!oldest || j.createdAt < oldest) oldest = j.createdAt; }
		noteTickers(jokes);
		if (!jokes.length) total = seen.size;
	} catch {}
	more.disabled = false; more.textContent = 'Show older jokes'; updateMore();
}
more.addEventListener('click', loadOlder);

on('run:finished', refreshFeed);
on('feed:highlight', ({ joke }) => {
	const card = feed.querySelector(`.card[data-id="${CSS.escape(joke.id)}"]`);
	if (!card) { window.open(`/j/${encodeURIComponent(joke.conversationId ?? '')}`, '_blank'); return; }
	card.scrollIntoView({ block: 'center', behavior: scrollMode });
	card.classList.add('target'); setTimeout(() => card.classList.remove('target'), 2500);
});

// Feed and stats polling pauses while the tab is hidden; a run in progress keeps polling.
const whenVisible = (fn: () => void) => () => { if (!document.hidden) fn(); };
refreshFeed(); loadStats();
setInterval(whenVisible(refreshFeed), 3000);
setInterval(whenVisible(loadStats), 15000);
setInterval(whenVisible(tickTimes), 30000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) { tickTimes(); refreshFeed(); loadStats(); } });
