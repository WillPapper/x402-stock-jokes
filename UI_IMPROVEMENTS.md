# UI improvements for `public/index.html`

Findings from a hands-on pass over the live page (https://jokes.papper.me, byte-identical to the local `public/index.html`) on 2026-10-16. Tested in Chrome at 1512px wide, in a 390px-wide frame for phone layout, in dark and light mode, with keyboard focus, and across these flows:

- First visit, scroll the feed, open "under the hood" panels on a feed card.
- Submit without a coupon (402 paywall for AAPL, copy instructions, expand "Minimal TypeScript").
- Submit with a wrong coupon (401).
- Submit with the coupon (full MSFT run, about 90 seconds, then the result).

Items are ordered by how much they would change the experience. Each has what was seen, why it matters, and a concrete suggestion. Line numbers refer to `public/index.html`.

---

## High impact

### 1. The joke lands below the fold with nothing announcing it

**Seen:** When the run finishes, the five-row steps card stays fully expanded and the result card appears underneath it. On a laptop the joke's first line is at about y=590 of a 798px viewport, and nothing scrolls, flashes, or changes weight. The joke card has no heading (no ticker, no company, no time), no permalink, and no "another one" affordance. The form keeps `MSFT` + coupon filled and the button simply re-enables.

**Why it matters:** The joke is the whole payoff. Right now the process is louder than the product, and a first-time visitor who did not watch the steps fill in may not notice it finished.

**Suggest:**
- On `done`, collapse the steps card to a one-line summary ("4 steps, 4 model turns, 0.0146 USDC on-chain · show details") and move the result card above it, or at least `scrollIntoView({ block: 'start' })` the result and give it the `pop` animation the feed cards already have.
- Give the result a header row like the feed cards (`MSFT · Microsoft Corp · just now`) and a permalink to `/joke/<id>`.
- Add a secondary action: "Tell me another" that clears the ticker and focuses it.

### 2. A 402 is shown as a failure

**Seen:** Submitting without a coupon paints the "Agent started" dot red with a "!" and the text "Not started: pay 0.10 USDC or use a coupon code." (`setStep('started', 'error', …)` at line 274). The paywall card, which is the real content of this state, is a second card below the steps card and starts at about y=490.

**Why it matters:** For anyone without a coupon this is the normal path, not an error. Red "!" reads as "something broke". The steps card is now an empty 220px block sitting between the form and the explanation.

**Suggest:**
- Add a neutral `.dot.info` (accent outline, "·" or "$") for the 402 state, keep red for real errors.
- Hide the steps card in the 402/401 state and show the paywall card in its place, or scroll the paywall into view.
- Tighten the paywall heading: "A joke about AAPL costs 0.10 USDC" with "paid by your agent with x402" as the subtitle.

### 3. The invalid-coupon error is far from the field and the field is silently cleared

**Seen:** With a wrong coupon, the input is emptied (line 290), focus returns to it, and the red message "That coupon code is not valid…" is rendered inside the paywall card about 500px down, under "Have a coupon code?". From the form you can't see the message; from the message you can't see the form.

**Suggest:**
- Render the 401 message directly under the coupon input (an `#pwhint` element in the form grid, `aria-live="polite"`, `aria-describedby` on the input), and give the input a red border.
- Keep the typed value selected instead of clearing it so a typo can be fixed. Only clear the stored value in localStorage.
- Keep the paywall below as the fallback, but without the duplicate error.

### 4. Phone layout: the stats row breaks

**Seen at 390px:** `.stats` keeps `repeat(3,1fr)` (line 43), so each card is about 95px wide. The middle card's seller breakdown wraps into a 12-line column ("USDC paid / on-chain · / AI Gateway / 0.3357 · / Ceramic / 0.0300 · …") and the row becomes about 260px tall.

**Suggest:**
- `@media (max-width:560px) { .stats { grid-template-columns:1fr 1fr } }` with the paid card spanning two columns, or stack to one column.
- Move the per-seller breakdown out of the stat label into a second muted line under the number, and show it on all sizes as `AI Gateway 0.34 · StockTwits 0.03 · Ceramic 0.03` with two decimals. Four decimals in a label is noise.

### 5. Model-turn receipt chips are repetitive and uninformative

**Seen:** The "Agent finished" row grows one `≤ 0.1311 USDC` chip per turn (line 250). After the MSFT run that is four identical chips in a row; while running they also appear on a row that says "finished". Step 3 shows `≤ 0.0258 USDC`, a ceiling, even after the real on-chain cost (0.0126 USDC for all AI Gateway calls) is known and printed in the result.

**Why it matters:** "≤ 0.1311" four times tells the reader nothing new after the first, and the ceiling is up to 10× the actual cost, so the page looks more expensive than it is.

**Suggest:**
- One chip: `4 turns · ≤ 0.13 USDC each`, with the detail in the turns panel.
- When `showRunCost` returns, replace the ceilings with settled figures (`AI Gateway 0.0126 USDC settled`) or add a "settled" chip next to the ceiling.
- Rename the row to "Agent turns" while running and "Agent finished" only on completion.

### 6. Long silent stretches while the agent thinks

**Seen:** Between step 2 finishing and step 3 starting there were about 40 seconds where the only change was the pulsing dot and "Next: waiting for the agent to call this step…" (line 241). The whole run took about 90 seconds with no elapsed time, no expected duration, and no cancel.

**Suggest:**
- Show an elapsed timer and a typical duration in the "Agent finished" row: `Working… 0:42 · usually 1–2 min`.
- Change the waiting copy to describe what is happening: "The agent is reading the data and deciding what to do next (model turn 2)…" using the `turns` count already in the status JSON.
- A thin indeterminate progress bar at the top of the steps card would carry liveness better than the 22px dot.

---

## Medium impact

### 7. "Paid on-chain" runs into the "Based on" sentence

**Seen:** `showRunCost` appends `"\nPaid on-chain: …"` to `#based` (line 258), but `.based` has no `white-space:pre-wrap` (line 37), so it renders as one paragraph: "…volume fell 11.9%. Paid on-chain: 0.0146 USDC (…)". Facts are joined with "; " while each already ends in ".", giving "$529.28.; StockTwits".

**Suggest:** A separate `<p class="paid">` for the cost line, and strip trailing periods before joining facts (or join with " · " as the feed does).

### 8. Cached-joke receipts in the paywall have no labels

**Seen:** The "Meanwhile, the latest cached joke for AAPL" block shows seven bare chips: `≤ 0.1311 USDC`, `0.0010 USDC ↗`, `≤ 0.1311 USDC`, `0.0010 USDC ↗`, `≤ 0.1311 USDC`, `≤ 0.0258 USDC`, `≤ 0.1311 USDC` (line 270, mapping every payment through `receiptChip`). There is no way to tell which chip is StockTwits, Ceramic, the joke, or a turn, and the joke has no date.

**Suggest:** Reuse the feed's labeled chip row (`StockTwits 0.0010 ↗ · Ceramic 0.0010 ↗ · AI Gateway joke · 4 agent turns · paid 0.0146 USDC`) and show when the cached joke was made.

### 9. Unstyled default-blue links

**Seen:** The footer wallet link ("Paying from 0x…") and the "run status JSON · x402 gateway events" links in every under-the-hood panel (`.hood .links`, line 69) are browser-default blue with the default underline. In dark mode that is the saturated `#0000ee` on near-black.

**Suggest:** `a { color:var(--accent) }` globally, plus `footer a` and `.hood .links a` inherit it. Consider `text-underline-offset:2px` for the mono chips.

### 10. The paid-on-chain breakdown reorders itself every refresh

**Seen:** Across refreshes the label read "AI Gateway 0.3045 · StockTwits 0.0300 · Ceramic 0.0270", then "AI Gateway · Ceramic · StockTwits", then back. `Object.keys(by)` (line 370) has no fixed order, so the text jumps every 15 seconds.

**Suggest:** Sort by a fixed seller order (`['AI Gateway','StockTwits','Ceramic']`) or by amount descending.

### 11. The coupon is a password shown in clear text and auto-filled forever

**Seen:** `<input id="password" type="text">` (line 81) is restored from localStorage on every visit (line 138), so the code sits visibly in the form on every page load and in every screenshot. The server header is literally `X-Joke-Password`.

**Suggest:** `type="password"` with a show/hide toggle, or render the saved state as a chip ("Coupon saved ✓ · remove") instead of echoing the value. Keep `autocomplete="off"`.

### 12. The "Minimal TypeScript" snippet overflows horizontally

**Seen:** The `<pre id="paycurl">` (line 110) has lines of about 110 characters, so it gets a horizontal scrollbar at every width, and on a phone only the first 35 characters are visible.

**Suggest:** `#paycurl { white-space:pre-wrap; word-break:break-word }` and break the long comment onto its own lines.

### 13. Feed timestamps and the "paid via x402" marker

**Seen:** Every card shows `10/16/2026, 1:58:11 PM`. In a feed of jokes from the last few hours that is long and hard to scan; seconds are never useful here. "· paid via x402" is appended to the date string rather than being a visible badge.

**Suggest:** Relative time ("3 min ago", "2 h ago") with the absolute time in `title`, updated by the existing 3-second feed timer. Make "paid via x402" a small accent chip at the start of the receipts row.

### 14. Under-the-hood panels are raw JSON dumps

**Seen:** Each panel is a 340px-tall scrolling `<pre>` of the full tool output. For StockTwits that is 30 sample messages; for turns it is four near-identical payment objects with full account URLs. The thing the reader usually wants (the joke prompt and answer, the news titles, the bullish/bearish split) is buried. The panel closes only by re-clicking the same badge; clicking another badge swaps it with no transition. There is no close control and no `aria-expanded`.

**Suggest:**
- Lead with a short human summary per step (StockTwits: price, range, sentiment split, 3 sample posts; Ceramic: titles as links; Joke: the prompt facts and the model's text; Turns: count, ceiling, settled total) and put the raw JSON inside a nested `<details>`.
- Add a "×" close button and `aria-expanded` / `aria-controls` on the badge.

### 15. Receipt chips are hard to tell apart and small on phones

**Seen:** `StockTwits ▾` (a button) and `0.0010 ↗` (a link) are the same pill style; only the underline distinguishes them. Chips are 12px mono with 6px padding, about 24px tall (line 34), below the 44px touch target guideline, and at 390px they wrap into four rows per card.

**Suggest:** Merge each seller into one chip with two zones (`StockTwits · 0.0010 ↗`) where the name opens the panel and the amount is the Basescan link; `min-height:32px` and 13px type; on phones allow the row to scroll horizontally instead of wrapping.

### 16. The feed stops at 30 with no way to see older jokes

**Seen:** `refreshFeed` loads `limit=30` once (line 382) and then only polls for newer ones. With 19 jokes today that is fine; at 31 the oldest are unreachable from the page.

**Suggest:** A "Show older" button that calls `/api/jokes?limit=30` with a `before` cursor (needs a small API addition), or at least a note with the total count.

---

## Lower impact and accessibility

### 17. Step rows are clickable but not keyboard-reachable

`li.clickable` rows (line 312) have a click handler and a `title` tooltip, but no `tabindex`, `role="button"`, or `aria-expanded`. Keyboard users cannot open them. Wrap the title in a `<button>` instead.

### 18. Step state is conveyed only visually

The `.dot` elements show state by color plus "✓"/"!" glyphs with no text alternative, and nothing on the page is `aria-live`, so a screen reader never hears "StockTwits done". Add `aria-live="polite"` on the steps list and an `.sr-only` state word inside each dot.

### 19. The submit button does not reflect the running state

While a run is in progress the button is only `disabled` at 55% opacity. Change the label to "Working…" (and consider a spinner), then back.

### 20. Empty state is a tall card that says nothing

Before any interaction the steps card ("Waiting for a ticker." plus four blank rows) occupies about 220px between the form and the live feed, which is the most interesting thing for a first-time visitor. Collapse it to a single line until a run starts, or show the feed first and let the steps card appear on submit.

### 21. Helper copy placement

The "The coupon code is optional…" paragraph is positioned with `margin:-10px 0 18px` under the whole form. Put the hint under the coupon field (second grid column) so it is next to what it explains, and shorten it: "Optional. Without one, your agent pays 0.10 USDC via x402."

### 22. Sparkline has no reference points

24 bars, three non-zero, no axis, no "now" marker, and values only via SVG `<title>` on hover. Add a faint "24h ago" / "now" label pair and a y-max label, or print the busiest hour next to the caption.

### 23. No hover or active styles on buttons

`button` has no `:hover` / `:active` state. Add a slight darken on hover and `transform:translateY(1px)` on active for the primary button and the badge chips.

### 24. No favicon

There is no `<link rel="icon">`, so the tab shows the default globe. An inline SVG data-URI favicon (a "$" or a laughing face in the accent color) is one line.

### 25. Possible ordering bug when several jokes arrive in one poll

`refreshFeed` prepends `fresh` in API order (newest first) when `newest` is already set (line 384). If two or more jokes land between two 3-second polls, the older one ends up on top. Not observed today (jokes arrived in separate polls) but the code path is easy to hit when another agent is active. Reverse `fresh` in both branches.

---

## Quick wins (under an hour total)

1. `a { color:var(--accent) }` (item 9).
2. Fixed seller order in the stats label (item 10).
3. `#paycurl { white-space:pre-wrap }` (item 12).
4. Separate `<p>` for the paid-on-chain line and trim trailing periods in facts (item 7).
5. Phone `grid-template-columns` for `.stats` (item 4).
6. Neutral dot style for the 402 state (item 2, partial).
7. Collapse model-turn chips to one (item 5, partial).
8. Favicon (item 24).
