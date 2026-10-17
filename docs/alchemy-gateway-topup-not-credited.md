# Alchemy x402 gateway: a settled $1 credit top-up was not credited to the wallet

**Product:** Alchemy Agentic Gateway, x402 with SIWE (`https://x402.alchemy.com/base-mainnet/v2`), as described in [Wallet auth for Alchemy APIs](https://www.alchemy.com/docs/alchemy-for-agents) and the [`agentic-gateway` skill](https://github.com/alchemyplatform/skills/tree/main/skills/agentic-gateway).
**Wallet (payer and SIWE identity):** `0x539567137621363bC699Aa6C8dfc3BE1466aC8F8` on Base.
**Observed:** 2026-10-17, 05:29–05:34 UTC.

## Summary

Our wallet signed in with SIWE, got the `402` "Purchase $1 of Alchemy API credits", and paid it. The payment settled on-chain: 1 USDC to the gateway's payee. The paid request answered `500 Internal error`. For about two minutes after that, the gateway gave mixed answers for the same wallet, and once it served a request without asking for payment. Since then it has quoted a new $1 top-up on every request, as if the wallet had never paid.

**Requests:** please credit the $1 to this wallet's gateway balance, or refund it. Please also look at `eth_*` methods on `base-mainnet`: they answer `500 Internal error` after payment in both the credits and pay-per-request modes (two more payments of 0.001 USDC charged for failed requests, below).

## The payment

| Field | Value |
|---|---|
| Transaction | [`0xaac905d38ac3313387389e57d47ba2aad879d9c3cbaa1c1313532540689335f4`](https://basescan.org/tx/0xaac905d38ac3313387389e57d47ba2aad879d9c3cbaa1c1313532540689335f4) |
| Block | 52712803, 2026-10-17 05:29:13 UTC, status success |
| Transfer | 1.000000 USDC, `0x5395…C8F8` → `0x0573c4dA7fC31E944e5FF959fEf3b42199C308B2` (the `payTo` of the gateway's quote) |
| Submitted by | `0x59b7ebc67a3d627fabaf06768c818638452ae704` (facilitator) |
| Quote paid | `exact`, `eip155:8453`, amount `1000000`, asset USDC `0x8335…2913`, `extra.name` "USD Coin". Description: "Purchase $1 of Alchemy API credits — includes 2,222,222 Compute Units (~100,000 requests) at $0.45 per million CUs." |

## Timeline (UTC, 2026-10-17)

Every request is a `POST https://x402.alchemy.com/base-mainnet/v2` carrying `Authorization: SIWE <base64(message)>.<signature>` for the wallet above. The SIWE message uses domain `x402.alchemy.com`, chain ID 8453 and statement "Sign in to Alchemy Gateway". Later rows paid nothing: the client could not sign a payment.

| Time | Sign-in | Method | Answer |
|---|---|---|---|
| 05:29:1x | token A | `eth_blockNumber` | `402` $1 quote → paid with `PAYMENT-SIGNATURE` → **`500` `{"code":-32002,"message":"Internal error"}`**, with a `PAYMENT-RESPONSE` receipt for the transaction above |
| 05:29:1x | token A | `eth_blockNumber` | `500` Internal error (no `402`) |
| 05:29:1x | token A | `alchemy_getAssetTransfers` (USDC, `fromAddress` = wallet) | **`200`, 474 transfers, no payment asked** |
| 05:29:1x | token B (new) | `eth_blockNumber` | `500` Internal error |
| ~05:29:30 | token C (new) | `alchemy_getAssetTransfers` | `403` `{"code":-32600,"message":"Monthly capacity limit exceeded. Visit https://dashboard.alchemyapi.io/settings/billing …"}` |
| ~05:29:30 | token C | `eth_blockNumber`, `eth_chainId` | `402` $1 quote |
| ~05:29:30 | token C | `eth_call` (USDC `balanceOf`) | `500` Internal error |
| 05:30:14 | token D (new) | `alchemy_getAssetTransfers`, `eth_blockNumber`, `eth_call` | `402` $1 quote, all three |
| 05:31:00 | token E (new) | same three | `403` Monthly capacity limit exceeded; `500`; `500` |
| 05:31:46 | token F (new) | same three | `402`; `402`; `500` |
| 05:34:10, 05:34:11 | tokens G, H (new) | same three | `402` $1 quote, all three, both rounds |

The responses carried no request-ID header. The only identifiers were `date` and `x-envoy-upstream-service-time`; `server` was `istio-envoy`.

Unpaid check at 05:37:11: still `402` with the $1 quote for all three methods.

## Pay-per-request mode: the same methods fail after payment

At 05:37 UTC we called the gateway without SIWE, paying its "$0.001 per request — no account required" quote each time. All three payments settled; two of the three requests failed anyway.

| Method | Answer | Payment (0.001 USDC to `0x0573…08B2`) |
|---|---|---|
| `eth_blockNumber` | `500` `{"code":-32002,"message":"Internal error"}` | [`0xa220bce4…5790`](https://basescan.org/tx/0xa220bce4b820066015369c86299a5efaf8a1a7beb9925a85ce2b066a15ea5790), block 52713049 |
| `alchemy_getAssetTransfers` | `200`, 475 transfers | [`0x740942e9…ff20`](https://basescan.org/tx/0x740942e965f353ca40b809d9856d172195f00f474174efbf0c6b54d25ec2ff20), block 52713050 |
| `eth_call` (USDC `balanceOf`) | `500` `{"code":-32002,"message":"Internal error"}` | [`0x9658be43…24c2`](https://basescan.org/tx/0x9658be4307f5df6a7e3ada1832d705959e2556b3eb1650dbb3ac565f60ad24c2), block 52713051 |

Across both modes, every standard `eth_*` call on `base-mainnet` that reached the backend answered `500`. Every `alchemy_getAssetTransfers` call that got that far answered `200`. Our $1 top-up was paid on an `eth_blockNumber` request. One possible explanation: the gateway charges first and records the credits only when the request succeeds. If so, a top-up paid on a failing method is lost.

## Expected vs. actual

Alchemy's launch post says the agent pays, "Alchemy processes the request and returns the blockchain data, drawing from the newly funded balance. Subsequent requests work without additional payment until the balance runs out" ([blog](https://alchemy.com/blog/ai-agents-can-now-sign-up-for-alchemy)).

- **Expected:** the paid request returns its result; later requests from the same wallet draw on 2,222,222 CU without a `402`.
- **Actual:** the paid request returned `500`. The wallet's state then switched between "no credits" (`402`), "Monthly capacity limit exceeded" (`403`) and `Internal error` (`500`). It succeeded once, then settled on "no credits" with the $1 paid.

## What we changed on our side

Our client counted the payment as unsettled because the response was a `500`, so its spending cap didn't record the $1. It now counts any payment whose `PAYMENT-RESPONSE` reports success. Our app also buys at most one gateway top-up per 24 h across all its instances, so this failure can't repeat the charge. Details: [alchemy-x402.md](alchemy-x402.md).
