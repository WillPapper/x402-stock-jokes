/** Small DOM and formatting helpers shared by the page's scripts. */

/** querySelector that throws when the element is missing: the markup is ours, so a miss is a bug. */
export function $<T extends Element = HTMLElement>(selector: string, root: ParentNode = document): T {
	const el = root.querySelector<T>(selector);
	if (!el) throw new Error(`missing element ${selector}`);
	return el;
}

export const show = (el: Element, on: boolean): void => { el.classList.toggle('hidden', !on); };

export const esc = (s: unknown): string => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);

export const money = (x: unknown, digits = 4): string => Number(x || 0).toFixed(digits);

export const cleanFact = (f: unknown): string => String(f ?? '').trim().replace(/[.;]+$/, '');

export const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

export const scrollMode: ScrollBehavior = matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';

/** The public origin, used where the page quotes a URL to paste elsewhere. */
export const PUBLIC = 'https://jokes.papper.me';

/** StockTwits habit: people type $NVDA. Keep letters, digits and dots. */
export const normTicker = (v: unknown): string => String(v || '').trim().toUpperCase().replace(/^\$/, '').replace(/[^A-Z0-9.]/g, '');

/** The run id or ticker from the URL (?run=<id> resumes a run, ?ticker=AMD prefills the form). */
export const params = new URLSearchParams(location.search);
export const RUN_ID = /^[A-Za-z0-9._-]{1,80}$/;

/** Links to a run's machine-readable views, for the panels and notes. */
export const runLinks = (id: string): string =>
	`<a href="/joke/${encodeURIComponent(id)}" target="_blank" rel="noopener">run status JSON</a> · <a href="/api/events?conversation=${encodeURIComponent(id)}" target="_blank" rel="noopener">x402 gateway events</a>`;
