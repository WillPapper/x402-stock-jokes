/**
 * Conversation IDs. One shape for every run the app starts itself:
 *
 *   j-<ticker>-<ms since epoch, base 36>-<4 random base-36 chars>
 *   j-dis-mvbohnzt-2wsz
 *
 * The ticker makes logs readable, the timestamp makes IDs sort by creation,
 * the suffix keeps two requests in the same millisecond apart. The ID is only
 * a name: nothing parses it, and clients may POST /agents/joke/<any id>, so a
 * prefix proves nothing about who paid. Paid vs coupon is always the gate's
 * verdict in `access.paid_by`, never the ID. By convention hand-run tests use
 * a `test-` prefix so they are easy to spot in the feed and to purge.
 */
export const JOKE_ID = /^j-[a-z0-9.]{1,12}-[0-9a-z]{6,10}-[0-9a-z]{4}$/;

export function jokeConversationId(ticker: string, now = Date.now(), rand = Math.random()): string {
	const sym = ticker.toLowerCase().replace(/[^a-z0-9.]/g, '').slice(0, 12) || 'x';
	return `j-${sym}-${now.toString(36)}-${rand.toString(36).slice(2, 6).padEnd(4, '0')}`;
}
