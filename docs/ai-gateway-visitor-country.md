# Bug report: AI Gateway machine payments (x402) geolocate the Worker's colo, so a US seller's app fails for non-US visitors

**Product:** AI Gateway, Machine Payments (x402), `POST /accounts/{id}/ai/run` with `Payment-Method: x402` (and the Monetization Gateway facilitator behind it)
**Observed:** 2026-10-16, account `f14cbf01…` (US, Monetization Gateway active), Worker `x402-stock-jokes` at https://jokes.papper.me
**Reporter context:** the payer is the app's own US-based account and wallet; the end user never pays AI Gateway and never sees it.

## Summary

A Cloudflare Worker (and its Durable Objects) calls AI Gateway `/ai/run` with `Payment-Method: x402`, paying from the account owner's wallet. The eligibility check ("buyers must be US-based") is evaluated against the **country of the Cloudflare datacenter the Worker happens to execute in**, which is chosen by where the *end user's* request landed. Result: the same app, same account, same wallet, same request works when a US visitor triggers it and fails with `403 {"error":"forbidden","message":"disallowed visitor country"}` when a visitor whose traffic reaches a non-US colo triggers it. The app owner cannot control this without extra infrastructure.

## Evidence

1. **Identical requests, different outcomes by submitter.** From a US browser/curl (colos SJC, PDX, LAX): every run succeeded (dozens, 2026-10-16 17:40–19:57 UTC). From the account owner's own browser, landing on a non-US colo: conversations `j-orcl-mvbdltge-g26r` (19:44:03Z) and `j-orcl-mvbdo1qn-k5qd` (19:45:47Z) failed on the first `/ai/run` call with
   `403 {"error":"forbidden","message":"disallowed visitor country"}`.
2. **What the subrequest carries.** `GET https://jokes.papper.me/api/_trace` makes a subrequest from inside the Worker to `https://www.cloudflare.com/cdn-cgi/trace` and an unpaid probe to `/ai/run`. From a US visitor:
   ```json
   {"visitor":{"ip":"24.4.x.x","country":"US","colo":"SJC"},
    "subrequestSeenBy":{"cloudflareTrace":{"ip":"2a06:98c0:3600::103","loc":"US","colo":"SJC"}},
    "aiGatewayUnpaidProbe":{"status":402,"cfRay":"a4b99e13d9237ad3-SJC"}}
   ```
   The subrequest does **not** carry the visitor's IP; it carries a Cloudflare egress IP whose `loc` is the executing colo's country. So "visitor country" for a Worker-originated payment = colo country = (in practice) the end user's region.
3. **The same check surfaces at verify time.** Two browser runs at 19:40:28Z/19:40:31Z (`web-9a5d6965`, `web-d4886afd`) passed earlier `/ai/run` calls, then the joke call failed with `503 {"error":"service_unavailable","message":"facilitator verify returned 403"}`. A burst of 14 paid `/ai/run` calls from a US laptop at 19:47Z all returned 200, so this is not a rate limit or balance issue; it is the geo check applied during facilitator verify.
4. **Fix on our side confirms the mechanism.** Starting every agent conversation from a Durable Object in the `us` jurisdiction (so the agent's Durable Object and all its `/ai/run` calls run in a US colo) makes runs succeed regardless of the submitter. Events logged by the app show `runnerColo: "ORD", runnerCountry: "US"` → `agentColo: "ORD"` → all payments 200 (conversation `jur-test-1`, 20:00Z; `j-nflx-mvbe201i-hlaa`, 19:56Z via LAX).

## Why this is a bug (or at least a gap)

- The buyer in a machine-payment flow from a Worker is the **account** (its token in `Authorization`, its wallet signing the authorization), not the person whose HTTP request happened to trigger the Worker. Keying eligibility on the executing colo's country ties a US seller's product to its *users'* geography.
- Durable Objects make it worse: an agent's object is placed where its first request arrived and then runs there for its lifetime, so one non-US visitor can create an object that fails forever for everyone.
- Developers get no signal at deploy time. The failure is intermittent by visitor, looks like a facilitator outage (`503 … verify returned 403`), and the only fix is to re-architect around a `us`-jurisdiction Durable Object (which also has to be documented somewhere).

## Suggested resolutions

1. For `Authorization: Bearer <account token>` + `Payment-Method: x402`, evaluate eligibility on the **account** (already required to be US-based with a card on file) and/or the **payer wallet**, not on the request's geolocation.
2. If request geolocation must stay, treat Cloudflare egress IPs (requests originating from Workers/Durable Objects of an eligible account) as eligible, or honor a documented header/flag asserting the Worker's account as the buyer.
3. At minimum, document the behavior and the `us`-jurisdiction Durable Object workaround on the Machine Payments page, and return a distinct error (not `503 facilitator verify returned 403`) when the geo check fails during verify.

## Minimal reproduction

1. A US account with Machine Payments enabled, a funded wallet with Permit2 approved.
2. Deploy a Worker whose `fetch` handler does an unpaid `POST …/ai/run` with `Payment-Method: x402` and returns the status (402 expected) together with `request.cf.colo`.
3. Call it from a US network: `402`. Call it through a non-US exit (VPN, or a user abroad): `403 disallowed visitor country`, with `request.cf.colo` outside the US.
4. Optional: add `Durable Object` placement to the repro to show the stickiness.

Reference implementation and logs: https://github.com/WillPapper/x402-stock-jokes (`src/cloudflare.ts` JokeRunner, `src/lib/log.ts`, `GET /api/events`).
