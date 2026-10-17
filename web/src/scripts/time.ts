/** Relative times that keep ticking, and a minutes:seconds formatter for run durations. */
import { esc } from './dom.ts';

export const relTime = (iso: string): string => {
	const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
	if (s < 45) return 'just now';
	if (s < 3600) return `${Math.round(s / 60)} min ago`;
	if (s < 86400) return `${Math.round(s / 3600)} h ago`;
	return `${Math.round(s / 86400)} d ago`;
};

/** A <time> element that tickTimes() keeps current. */
export const timeEl = (iso: string): string => `<time datetime="${esc(iso)}" title="${esc(new Date(iso).toLocaleString())}" data-ts="${esc(iso)}">${relTime(iso)}</time>`;

export const tickTimes = (): void => document.querySelectorAll<HTMLElement>('time[data-ts]').forEach((t) => { t.textContent = relTime(t.dataset.ts!); });

export const mmss = (ms: number): string => { const s = Math.floor(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
