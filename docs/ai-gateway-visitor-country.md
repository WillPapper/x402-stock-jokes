# Bug report: Monetization Gateway / AI Gateway machine payments (x402) apply the *visitor's* country to payments made by a Worker, so a US seller's app fails for non-US visitors

**Product:** AI Gateway Machine Payments (x402) on `POST /accounts/{id}/ai/run`, and Monetization Gateway sellers (StockTwits, Ceramic) paid with x402 from a Worker. Same behavior on both.
**Observed:** 2026-10-16, account `f14cbf01…` (US, Monetization Gateway active), Worker `x402-stock-jokes` at https://jokes.papper.me
**Reporter context:** the payer is the app's own US-based account and wallet; the end user never pays AI Gateway and never sees it.

## Summary

A Cloudflare Worker (and its Durable Objects) pays StockTwits, Ceramic and AI Gateway with x402 from the account owner's US wallet. The buyer-eligibility check ("US-based") is evaluated against the **country of the end user whose HTTP request is in flight when the Worker makes the paid subrequest**, not against the account, the wallet, or even the datacenter running the code. Cloudflare propagates the visitor's identity down the whole synchronous request chain (Worker → Durable Object → Durable Object, across regions), and a Durable Object attributes its outbound requests to whichever incoming request is active at that moment. So:

- a non-US visitor who *submits* a joke makes every payment fail with `403 {"error":"forbidden","message":"disallowed visitor country"}` (and `503 … facilitator verify returned 403` when it hits at verify time), even when the Durable Object runs in ORD inside the `us` jurisdiction;
- a non-US visitor who merely *polls the status* of someone else's run, if that read reaches the agent's Durable Object, makes that run's payments fail from that moment on.

The app owner cannot see this at deploy time, and the only fix is to re-architect so that no eyeball request ever touches the object that pays (details below). The buyer in these flows is the account and its wallet; the visitor never pays anything.

## Evidence (all 2026-10-16 UTC, account `f14cbf01…`, Worker `x402-stock-jokes` on jokes.papper.me; every run has full event logs at `GET https://jokes.papper.me/api/events?conversation=<id>`)

1. **Identical runs, different outcomes by visitor.** From US visitors: dozens of successful runs. From a visitor in Portugal (`web-fe0c59f3`, 20:21Z, Worker colo LIS) and Canada (`web-b7184322`, 20:26Z, colo YYZ): first paid StockTwits call `403 disallowed visitor country`, next AI Gateway call `403`, run dead.
2. **Location pinning does not help.** The conversation was started from a Durable Object in the `us` jurisdiction (`JokeRunner`, ORD) via a direct RPC from the Worker. The runner's own `cdn-cgi/trace` subrequest, executed in ORD, reported `loc=PT` / `loc=CA` for those runs: the visitor's identity rides along the request chain into the US object. Payments failed with rays `a4b9c5851e9e1401-ORD`, `a4b9cd1b39b213cb-ORD`.
3. **An alarm breaks the chain for the start, but reads re-attach it.** Starting the agent from the runner's *alarm* (no originating request) made the runner report `loc=US`. A Canadian-visitor run with **no reads at all** during execution (`nopoll-2`, 20:37Z) then succeeded end to end (StockTwits, Ceramic, AI Gateway all 200 from ORD). The same setup **with** the visitor polling the conversation (`j-crm-mvbfgj9z-b78p`, 20:36Z: first AI Gateway turn 200, then StockTwits 403, then AI Gateway 403 at the moment of the next poll) failed.
4. **Serving status from D1 instead of the Durable Object fixes it.** With reads never reaching the agent object, a Canadian visitor polling every 2 s completed a full run (`j-snow-mvbfqw28-1icf`, 20:41Z: 4 model turns, 7 payments, all 200).
5. **The 503 is the same check.** `503 {"error":"service_unavailable","message":"facilitator verify returned 403"}` appeared only in runs touched by a non-US visitor (e.g. `nopoll-1` first turn, `web-9a5d6965`); a burst of 14 paid calls from a US laptop returned 14×200.

## The workaround we had to build

1. The public Worker only authenticates and **queues** the message into a Durable Object in the `us` jurisdiction (`JokeRunner.submit` → storage + `setAlarm(now + 3 s)`).
2. The runner's `alarm()` dispatches the agent. The alarm has no originating request, so the agent's Durable Object (placed next to the runner, in the US) pays with no visitor identity attached.
3. **No eyeball request ever reaches the agent object while it works:** progress and results are written to D1 (`events`, `jokes` tables) and status is served from D1 (`GET /joke/<id>`). The raw conversation read (`GET /agents/joke/<id>`) is documented as "do not call while a joke is being made".

## Why this is a bug (or at least a gap)

- The buyer in a machine-payment flow from a Worker is the **account** (its token in `Authorization`, its wallet signing the authorization), not the person whose HTTP request happened to be in flight. Keying eligibility on the propagated visitor identity ties a US seller's product to its *users'* geography, and to the geography of anyone who merely reads a status page.
- The propagation is invisible: the subrequest shows a Cloudflare egress IP (`2a06:98c0:3600::103`), `request.cf` in the Durable Object says nothing, and the only hint is `cdn-cgi/trace` reporting the visitor's `loc` from a US datacenter.
- Developers get no signal at deploy time. The failure is intermittent by visitor, looks like a facilitator outage (`503 … verify returned 403`), and the fix requires an alarm-driven Durable Object plus moving all reads off the object, none of which is documented.

## Suggested resolutions

1. For `Authorization: Bearer <account token>` + `Payment-Method: x402` (AI Gateway), evaluate eligibility on the **account** (already required to be US-based with a card on file) and/or the **payer wallet**, not on the propagated visitor identity.
2. For Monetization Gateway sellers paid from a Worker, let the buyer assert itself: treat requests originating from Workers/Durable Objects of an eligible account as that account, or honor a documented header/flag that names the Worker's account as the buyer.
3. At minimum, document the propagation behavior and the alarm + "no reads on the paying object" workaround on the Machine Payments and Monetization Gateway pages, and return a distinct error (not `503 facilitator verify returned 403`) when the geo check fails during verify.

## Minimal reproduction

1. A US account with Machine Payments enabled, a funded wallet with Permit2 approved.
2. Deploy a Worker whose `fetch` handler does an unpaid `POST …/ai/run` with `Payment-Method: x402` and returns the status together with the `loc` from a subrequest to `https://www.cloudflare.com/cdn-cgi/trace`.
3. Call it from a US network: `402` and `loc=US`. Call it through a non-US exit (VPN): `403 disallowed visitor country` and `loc=<that country>`, even though the subrequest IP is Cloudflare's.
4. To show the Durable Object part: have the Worker call a `us`-jurisdiction Durable Object that makes the same two subrequests. From the non-US exit it still reports the visitor's `loc` and gets `403`; from the object's `alarm()` it reports `US` and gets `402`; have the non-US client poll the object during the alarm's work and the next paid call fails again.

Reference implementation and logs: https://github.com/WillPapper/x402-stock-jokes (`src/cloudflare.ts` JokeRunner, `src/lib/log.ts`, `GET /api/events`).
