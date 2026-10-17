# Alchemy over x402: wallet credits, not credit on our Alchemy account

**Question:** Can this app pay for its Alchemy calls with x402, for example to cover overage on our free-plan account?
**Checked:** 2026-10-16, against Alchemy's docs, blog and agent skills, and against live `402` quotes from `https://x402.alchemy.com`. Every probe stopped at the quote, so nothing was paid.

## Answer

- **We can pay Alchemy with x402, but the payment doesn't apply to our existing account.** The x402 gateway knows a customer only by a wallet, which signs in with SIWE. Our API key plays no part. Alchemy's launch post says a payment tops up an "agentic account" that belongs to the wallet ([blog](https://alchemy.com/blog/ai-agents-can-now-sign-up-for-alchemy)).
- **The model is prepaid credits, as the team said.** After a SIWE login, the `402` sells **$1 of credits: 2,222,222 CU at $0.45 per million CU**, which is the Pay-As-You-Go rate. Later requests draw down that balance, and a new `402` arrives when it runs out.
- **One exception is pay-per-request.** A request without SIWE gets a different quote: $0.001 per request, "no account required". The docs don't mention this mode.
- **`ALCHEMY_API_KEY` is ignored by the gateway.** With the key in the URL we got the same anonymous $0.001 quote. As a `Bearer` token it got `401`, asking for a SIWE header (probes below). No path we found links an x402 payment to the account behind the key.
- **Overage on the existing account comes only from upgrading to Pay-As-You-Go.** That plan charges a card automatically and removes the free 30M CU a month ([PAYG article](https://support.alchemy.com/articles/2300474614-understanding-alchemy-s-pay-as-you-go-billing-model)).
- **A practical "overage via x402":** keep the free key as the main path. When the key hits its limit, fall back to the gateway, paying from the app wallet's credits. The price per CU matches PAYG, and the key keeps its free 30M CU. **This app now does this** (see "The fallback in this app" below).
- **Live tests (2026-10-17), both modes:**
    - **Credits:** the gateway took $1 and did not credit it. The top-up settled on-chain, but the paid request answered `500`, and the gateway kept quoting a new $1 for the same wallet.
    - **Pay-per-request ($0.001):** works for `alchemy_getAssetTransfers`, the call the fallback makes (`200`, 475 transfers).
    - **Standard `eth_*` calls** (`eth_blockNumber`, `eth_call`) answered `500 Internal error` after payment in both modes.
    - Report for Alchemy: [alchemy-gateway-topup-not-credited.md](alchemy-gateway-topup-not-credited.md).

## Requirements

| What | Requirement | Source |
|---|---|---|
| Wallet | An EVM key (secp256k1) or a Solana key. The app wallet in `.dev.vars` works. Credits belong to whichever wallet signs. | [Wallet auth docs](https://www.alchemy.com/docs/alchemy-for-agents) |
| Auth | Header `Authorization: SIWE <base64(siwe message)>.<signature>`. The message uses domain `x402.alchemy.com`, URI `https://x402.alchemy.com`, chain ID `8453`, statement `Sign in to Alchemy Gateway`, an 8+ character nonce and an expiry (default 1 h). Sign again once it expires. | [authentication.md](https://github.com/alchemyplatform/skills/blob/main/skills/agentic-gateway/rules/x402/authentication.md) |
| Payment | x402 v2, scheme `exact`, USDC with 6 decimals. On Base (`eip155:8453`) it is an EIP-3009 `transferWithAuthorization`, so no approval and no gas. Solana USDC and a Circle Gateway batched option are also offered. | [payment.md](https://github.com/alchemyplatform/skills/blob/main/skills/agentic-gateway/rules/x402/payment.md), live `402` |
| Endpoint | `POST https://x402.alchemy.com/base-mainnet/v2` serves `eth_*` and `alchemy_getAssetTransfers`, the two kinds of call this app makes. NFT, Prices and Portfolio have their own routes. | [reference.md](https://github.com/alchemyplatform/skills/blob/main/skills/agentic-gateway/rules/x402/reference.md), [overview.md](https://github.com/alchemyplatform/skills/blob/main/skills/agentic-gateway/rules/x402/overview.md) |
| Libraries | `@alchemy/x402` (`signSiwe`, `buildX402Client`) with `@x402/fetch`, or our own `x402Client` + `ExactEvmScheme` with a SIWE message from `viem/siwe`. | [making-requests.md](https://github.com/alchemyplatform/skills/blob/main/skills/agentic-gateway/rules/x402/making-requests.md) |
| CLI (optional) | `@alchemy/cli`: `alchemy wallet connect --mode local`, then `alchemy config set x402 true`. Separate from `alchemy x402 request`, which pays *third-party* x402 APIs. | [CLI docs](https://www.alchemy.com/docs/alchemy-cli), [x402 payments](https://www.alchemy.com/docs/x402-payments) |

## Billing model: what the gateway actually quotes

Each row is one unpaid `POST /base-mainnet/v2` of `eth_blockNumber`, decoded from the `PAYMENT-REQUIRED` header. `alchemy_getAssetTransfers` (120 CU) got exactly the same quotes as `eth_blockNumber` (10 CU), so neither mode prices by method at the quote.

| Request | Status | Quote |
|---|---|---|
| No `Authorization` | `402` | 1000 units = **$0.001**: "Pay $0.001 per request — no account required." |
| SIWE, new throwaway wallet | `402` | 1000000 units = **$1.00**: "Purchase $1 of Alchemy API credits — includes 2,222,222 Compute Units (~100,000 requests) at $0.45 per million CUs." |
| SIWE, app wallet `0x5395…C8F8` | `402` | $1.00, same text (the wallet holds no credits) |
| `ALCHEMY_API_KEY` in the path, no SIWE | `402` | $0.001 per request, same as no auth |
| `ALCHEMY_API_KEY` as `Bearer` | `401` | `INVALID_AUTH_FORMAT`: "expected: SIWE <base64(siweMessage)>.<signature>" |
| SIWE and the key in the path | `402` | $1.00 credits; the key changes nothing |

Payee for every Base quote: `0x0573c4dA7fC31E944e5FF959fEf3b42199C308B2`.

### Where the sources disagree

| Source | What it says | Agrees with the live gateway? |
|---|---|---|
| [Launch blog](https://alchemy.com/blog/ai-agents-can-now-sign-up-for-alchemy) (updated 2026-02-26) | The `402` gives "payment instructions to top up the 'agentic account'"; "Subsequent requests work without additional payment until the balance runs out"; "as little as $1 (equivalent to $1 of CUs in Alchemy's pay-as-you-go tier)" | Yes, for SIWE requests |
| [overview.md](https://github.com/alchemyplatform/skills/blob/main/skills/agentic-gateway/rules/x402/overview.md) | "Subsequent requests with the same auth token do not require payment again." | Partly. It describes a balance but ties it to the token, which expires in 1 h. Whether credits follow the wallet across tokens is untested. |
| [payment.md](https://github.com/alchemyplatform/skills/blob/main/skills/agentic-gateway/rules/x402/payment.md) | One `exact` payment, amount "specified in the 402"; no mention of a balance or of $1 | Silent on the model |
| [reference.md](https://github.com/alchemyplatform/skills/blob/main/skills/agentic-gateway/rules/x402/reference.md) | "Gateway receiving wallet (EVM): `0x658dc531A7FE637F7BA31C3dDd4C9bf8A27c81e5`" | **No**: the live payee is `0x0573c4dA…08B2` |
| [Wallet auth docs](https://www.alchemy.com/docs/alchemy-for-agents) | "When payment is required, the server responds with HTTP 402"; no amount or model | Silent on the model |
| Live `402` without SIWE | "Pay $0.001 per request — no account required" | This mode appears in no doc we found |
| [x402 payments docs](https://www.alchemy.com/docs/x402-payments) | Covers the CLI paying *third-party* x402 APIs, not Alchemy | Different feature with a similar name |

The gateway skill was last changed on 2026-04-19, so the per-request mode and the new payee probably came later.

## Our account, the free plan and overage

- **Free plan:** 30M CU a month per account, and 300 CU per second per app ([free tier](https://support.alchemy.com/articles/5827006872-what-is-included-in-the-free-tier)).
- **Pay-As-You-Go:** $0.45 per million CU up to 300M, then $0.40. Upgrading means "you'll be charged for every CU consumed starting from zero". It needs a card with automatic collection, and a usage limit in dollars or CU can stop service at a ceiling ([PAYG article](https://support.alchemy.com/articles/2300474614-understanding-alchemy-s-pay-as-you-go-billing-model)).
- **x402 credits:** same $0.45 per million CU, prepaid in $1 steps, held by the wallet. The gateway never sees our key, so the dashboard account gets no credit for these payments.
- Search results describe paying an Alchemy invoice in crypto (US customers, manually each month). That support page returns `404` today, so it is unverified here.

## Cost for this app

| Call | Where | CU | PAYG or x402 credits | x402 without SIWE |
|---|---|---|---|---|
| `alchemy_getAssetTransfers` | `src/lib/transfers.ts`: 2 per refresh (out and in), plus 1 for each extra page of 1,000 transfers; cached 30 s per isolate | 120 | $0.000054 | $0.001 |
| `eth_call` (`balanceOf`, `allowance`) | `src/app.ts` `/api/wallet`: Alchemy first, then public RPCs; not cached | 26 each | $0.0000117 | $0.001 |

CU figures are from [Compute Unit Costs](https://www.alchemy.com/docs/reference/compute-unit-costs).

- A stats refresh (2 transfer calls) costs 240 CU: $0.000108 on credits, versus $0.002 per request without SIWE. **Always sign in:** for this traffic, credits cost 18x less than per-request (85x less for `eth_call`).
- $1 of credits buys about 9,200 stats refreshes. The free 30M CU buys about 125,000 a month. One isolate refreshing every 30 s for a whole month uses 20.7M CU. Several busy isolates could pass 30M; the dashboard's Usage tab shows the real figure.

## The fallback in this app

Implemented 2026-10-17 in `src/lib/alchemy.ts`, used by `src/lib/transfers.ts`.

1. **Key first.** Each call goes to `base-mainnet.g.alchemy.com/v2/<key>`. A `429` pauses the key for 60 s; `403 "Monthly capacity limit exceeded."` pauses it for 15 min. Calls during a pause go straight to the gateway. Other errors (a bad key, say) don't trigger the fallback.
2. **Gateway, unpaid first.** The app wallet signs a SIWE token (1 h, re-signed 5 min before expiry or after a `401`). With credits on the wallet, the unpaid call is the whole call.
3. **A top-up only on a `402`.** Gateway calls run one at a time per isolate, so parallel calls can't each buy $1. Before paying, the app claims the day's top-up in D1 (`events`, kind `alchemy.topup`), allowing at most one per 24 h app-wide. A `Budget` caps each top-up at `MAX_USDC_PER_ALCHEMY_TOPUP` (1) and each isolate at `MAX_USDC_ALCHEMY_PER_ISOLATE` (1).
4. **Accounting.** Payments to `0x0573c4dA…08B2` show up as party `Alchemy`, summed in `infraUsdc` and kept out of `paidUsdc` (joke cost). The x402 client now counts a payment as spent whenever its receipt reports success, even if the response failed: the live top-up settled under a `500`.
5. **Checks.** `bun run doctor` reports whether the key works and whether the wallet holds gateway credits. `test/alchemy.test.ts` covers the fallback rules.

## Open questions for Alchemy

- Can x402 credits be linked to an existing dashboard team and its API key, or are they always a separate "agentic account"?
- Why was our settled $1 top-up (tx `0xaac905…35f4`) never credited? See [the report](alchemy-gateway-topup-not-credited.md).
- Do credits stay with the wallet across SIWE tokens (each expires after 1 h by default)? Do they expire? Our live test couldn't tell, because the gateway never credited the top-up.
- Alchemy's [error reference](https://www.alchemy.com/docs/reference/error-reference) gives `403` "Monthly capacity limit exceeded." for the monthly limit. Does that last until the next billing month?
- Which EVM payee is current: `0x0573c4dA…08B2` (live) or `0x658dc531…81e5` (skill reference)?
- Is the no-SIWE mode ($0.001 per request) documented, and is it meant to last?

## Sources

- [Wallet auth for Alchemy APIs](https://www.alchemy.com/docs/alchemy-for-agents)
- [x402 payments (CLI, third-party APIs)](https://www.alchemy.com/docs/x402-payments)
- [Alchemy CLI](https://www.alchemy.com/docs/alchemy-cli)
- [AI agents can now use Alchemy autonomously](https://alchemy.com/blog/ai-agents-can-now-sign-up-for-alchemy), Alchemy blog, updated 2026-02-26
- Agent skill `agentic-gateway` (x402 rules): [overview](https://github.com/alchemyplatform/skills/blob/main/skills/agentic-gateway/rules/x402/overview.md), [authentication](https://github.com/alchemyplatform/skills/blob/main/skills/agentic-gateway/rules/x402/authentication.md), [payment](https://github.com/alchemyplatform/skills/blob/main/skills/agentic-gateway/rules/x402/payment.md), [making requests](https://github.com/alchemyplatform/skills/blob/main/skills/agentic-gateway/rules/x402/making-requests.md), [reference](https://github.com/alchemyplatform/skills/blob/main/skills/agentic-gateway/rules/x402/reference.md)
- [Compute Unit Costs](https://www.alchemy.com/docs/reference/compute-unit-costs)
- [Error reference](https://www.alchemy.com/docs/reference/error-reference) and [Throughput](https://www.alchemy.com/docs/reference/throughput)
- [What is included in the Free tier?](https://support.alchemy.com/articles/5827006872-what-is-included-in-the-free-tier)
- [Understanding Alchemy's Pay-As-You-Go billing model](https://support.alchemy.com/articles/2300474614-understanding-alchemy-s-pay-as-you-go-billing-model)
- Live quotes: unpaid `POST https://x402.alchemy.com/base-mainnet/v2`, 2026-10-16 (US time), with no auth, with SIWE from a throwaway wallet and from the app wallet, and with `ALCHEMY_API_KEY` in the path and as `Bearer`
