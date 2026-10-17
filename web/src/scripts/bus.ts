/**
 * Typed events on `document`: how the page's components talk to each other
 * without reaching into one another's markup. The form asks for a run, the run
 * card reports where it got to, the result card, paywall and feed react.
 */
import type { Joke, Paid } from './types.ts';

export interface Events {
	/** The form wants a joke (coupon code may be empty). */
	'run:submit': { sym: string; pw: string };
	/** A new run is starting: clear hints, hide the result and the paywall. */
	'run:reset': undefined;
	/** The submit button follows the run. */
	'run:busy': { busy: boolean };
	/** The server bounced the ticker before anything was paid. */
	'run:bad-ticker': { message: string };
	/** 401: the coupon code was rejected, so the form forgets the saved one. */
	'run:bad-coupon': undefined;
	/** The server accepted the request (with this coupon code, possibly empty). */
	'run:accepted': { pw: string };
	/** 402 or 401: show the paywall; `pwError` is the message for a rejected coupon. */
	'run:paywall': { cached: Joke | null | undefined; sym: string; pwError: string | null };
	/** The run settled; `failed` is the human-readable reason, or null for a joke. */
	'run:result': { id: string; sym: string; title: string; when: string; joke: string | null; based: string; failed: string | null };
	/** The joke's on-chain cost came in a few seconds after the run. */
	'run:cost': { paid: Paid };
	/** A run finished (joke or not): the feed should look for the new row. */
	'run:finished': undefined;
	/** "Tell me another": the form clears the ticker and takes focus. */
	'form:clear': undefined;
	/** Scroll the feed to this joke's card (or open its permalink if the card is not loaded). */
	'feed:highlight': { joke: Joke };
	/** Tickers the feed has jokes for, most recent first, for the form's suggestions. */
	'feed:tickers': { tickers: string[] };
}

type Args<K extends keyof Events> = Events[K] extends undefined ? [] : [detail: Events[K]];

export function emit<K extends keyof Events>(type: K, ...args: Args<K>): void {
	document.dispatchEvent(new CustomEvent(type, { detail: args[0] }));
}

export function on<K extends keyof Events>(type: K, handler: (detail: Events[K]) => void): void {
	document.addEventListener(type, (e) => handler((e as CustomEvent<Events[K]>).detail));
}
