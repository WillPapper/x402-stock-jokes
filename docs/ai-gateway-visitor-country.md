# Machine Payments and Monetization Gateway: buyer eligibility is checked against the end user's country, not the paying account, for requests made from Workers

**Products:** AI Gateway [Machine Payments (x402)](https://developers.cloudflare.com/ai-gateway/features/machine-payments/) on `POST /accounts/{account_id}/ai/run`; [Monetization Gateway](https://developers.cloudflare.com/monetization-gateway/) sellers paid with x402 from a Worker (same behavior).
**Reporter:** US account `f14cbf01…` with Machine Payments and Monetization Gateway enabled, paying from its own wallet. Observed 2026-10-16.

## Summary

When a Worker or Durable Object pays an x402 challenge, the "US-based buyer" requirement is evaluated against the country of the **end user whose request is in flight** at the time of the subrequest, not against the account that holds the API token and signs the payment. A US account's Worker therefore gets `403 {"error":"forbidden","message":"disallowed visitor country"}` whenever the person using the app is outside the US, even though that person is not the buyer and never sees the gateway.

## Expected vs. actual

The [Machine Payments docs](https://developers.cloudflare.com/ai-gateway/features/machine-payments/) say the account must be US-based with a card on file and that the request carries the account's token in `Authorization`. The buyer is the account (its token, its wallet). Expected: eligibility follows the account. Actual: eligibility follows the visitor of the Worker.

## Reproduction (no application code needed)

1. A US account with Machine Payments enabled, a wallet funded with USDC on Base, Permit2 approved for the wallet.
2. Deploy a Worker whose `fetch` handler does an **unpaid** `POST https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/ai/run` with headers `Authorization: Bearer $TOKEN`, `Payment-Method: x402` and a small chat body, and returns the upstream status and body. No wallet needed for this step: the first request is only meant to receive the 402 quote.
3. Call the Worker from a US network: upstream answers `402` with a `PAYMENT-REQUIRED` quote. Call the same Worker through a non-US exit (a VPN set to Canada or Portugal): upstream answers `403 disallowed visitor country`.
4. Same two calls against a Monetization Gateway seller endpoint (any seller, e.g. the StockTwits x402 preview `GET https://api-staging-mgw.stocktwits.com/api/2/symbols/show/AAPL.json`): `402` from the US, `403` from the non-US exit.

The Worker's subrequest does not carry the visitor's IP (a request to `https://www.cloudflare.com/cdn-cgi/trace` from the Worker shows a Cloudflare egress address), but it carries the visitor's country: the same trace shows `loc=CA` for the Canadian caller even when it runs in a US datacenter.

Extending the repro to Durable Objects shows the same identity propagating further than expected:

5. Have the Worker call a Durable Object created in the `us` jurisdiction ([Data location](https://developers.cloudflare.com/durable-objects/reference/data-location/)) that performs steps 2–4. From the non-US client it still gets `403` and `loc=CA`, while running in ORD.
6. Have that object perform the same subrequests from its [alarm handler](https://developers.cloudflare.com/durable-objects/api/alarms/) instead. With no client request in flight it gets `402` and `loc=US`.
7. While the alarm's work is in progress, send any request from the non-US client to the same object (for example a read of its state). The object's next paid subrequest gets `403` again: the object attributes its outbound requests to whichever client request is active at that moment.

## Identifiers from our runs (for correlation)

| Time (UTC) | Client exit | Result | cf-ray |
|---|---|---|---|
| 20:21:43 | Portugal (LIS) | `403 disallowed visitor country`, Durable Object in ORD | `a4b9c5851e9e1401-ORD` |
| 20:26:54 | Canada (YYZ) | same | `a4b9cd1b39b213cb-ORD` |
| 20:29:22 | Canada (YYZ) | same | `a4b9d0b76d66873b-ORD` |
| 19:47 | US laptop | 14 consecutive paid `/ai/run` calls, all `200` | — |
| 20:37–20:39 | Canada, work started from an alarm, no client requests during the run | all payments `200` from ORD | — |

The same check can also fire later in the flow. When the unpaid request receives a `402` quote but the retry carrying `PAYMENT-SIGNATURE` is rejected at facilitator verification, the error is `503 {"error":"service_unavailable","message":"facilitator verify returned 403"}`. We saw this only in runs where a non-US client request was active by the time the retry was verified; it never occurred in US-only runs, and it stopped once no non-US client could reach the paying object. A `503` with no mention of country makes this hard to diagnose.

## Why this matters

- In an agent or server-side integration the buyer is the account. Tying eligibility to the visitor means a US seller's product only works for US users, and for non-US users it fails with an error that looks like a facilitator outage.
- The behavior is undocumented. Neither the [Machine Payments](https://developers.cloudflare.com/ai-gateway/features/machine-payments/) page nor the Monetization Gateway [eligibility](https://developers.cloudflare.com/monetization-gateway/eligibility/) and [x402](https://developers.cloudflare.com/monetization-gateway/x402/) pages mention that the visitor's country is used for Worker-originated payments, nor that it propagates into Durable Objects in any jurisdiction.
- The only working configuration we found is to do all paid work from a Durable Object alarm and to keep client requests away from that object until it is finished. That is a lot to discover from a `403`.

## Requests

1. For `Authorization: Bearer <account token>` + `Payment-Method: x402`, evaluate eligibility on the account and/or the payer wallet.
2. For Monetization Gateway payments originating from Workers or Durable Objects of an eligible account, treat the account as the buyer, or provide a documented way for the Worker to assert it.
3. Until then, document the current behavior on both product pages ([Machine Payments](https://developers.cloudflare.com/ai-gateway/features/machine-payments/), [Monetization Gateway](https://developers.cloudflare.com/monetization-gateway/)), including the alarm pattern, and return a distinct error instead of `503 facilitator verify returned 403` when the country check fails at verify time.

Reference implementation with full per-request logs (cf-ray, cf-aig ids, quote JWT claims, payer, timestamps): https://github.com/WillPapper/x402-stock-jokes, `GET https://jokes.papper.me/api/events?conversation=<id>`.
