# Alchemy x402 gateway: two settled $1 credit top-ups were not credited to the wallet

**Product:** Alchemy Agentic Gateway, x402 with SIWE (`https://x402.alchemy.com`), as described in [Wallet auth for Alchemy APIs](https://www.alchemy.com/docs/alchemy-for-agents) and the [`agentic-gateway` skill](https://github.com/alchemyplatform/skills/tree/main/skills/agentic-gateway).
**Wallet (payer and SIWE identity):** `0x539567137621363bC699Aa6C8dfc3BE1466aC8F8` on Base.
**Observed:** 2026-10-17, 05:29–06:19 UTC.

## Summary

Our wallet signed in with SIWE, got the `402` "Purchase $1 of Alchemy API credits", and paid it twice. Both payments settled on-chain: 1 USDC each to the gateway's payee. The first paid request answered `500 Internal error`. The second answered `402` again, with no receipt, though its transfer had settled two seconds earlier.

Neither top-up can be used:
- **JSON-RPC routes:** they quote a new $1 top-up on every request, as if the wallet had never paid.
- **REST routes:** the gateway lets the wallet through (a never-funded wallet gets `402` there). Alchemy's backend then refuses with "Monthly capacity limit exceeded".

The wallet seems to have an account with no compute units behind it. It has stayed that way for 50 minutes, through the second payment.

**Requests:**
1. Please credit the $2 (4,444,444 CU) to this wallet's gateway balance, or refund it.
2. Please look at `eth_*` methods on `base-mainnet`. They answered `500 Internal error` after payment in both the credits and pay-per-request modes; two payments of 0.001 USDC bought failed requests (below).

## Payments from the wallet to the gateway

All to `0x0573c4dA7fC31E944e5FF959fEf3b42199C308B2`, the `payTo` of the gateway's quotes, in USDC on Base.

| Time (UTC) | Amount | Transaction | Block | Submitted by | Quote paid | Gateway's answer to the paid request |
|---|---|---|---|---|---|---|
| 05:29:13 | 1.000000 | [`0xaac905d3…35f4`](https://basescan.org/tx/0xaac905d38ac3313387389e57d47ba2aad879d9c3cbaa1c1313532540689335f4) | 52712803 | `0x59b7ebc6…a704` | $1 credits, on `eth_blockNumber` | `500` Internal error, with a `PAYMENT-RESPONSE` receipt |
| 05:37:25 | 0.001000 | [`0xa220bce4…5790`](https://basescan.org/tx/0xa220bce4b820066015369c86299a5efaf8a1a7beb9925a85ce2b066a15ea5790) | 52713049 | | $0.001 per request (no SIWE), `eth_blockNumber` | `500` Internal error |
| 05:37:27 | 0.001000 | [`0x740942e9…ff20`](https://basescan.org/tx/0x740942e965f353ca40b809d9856d172195f00f474174efbf0c6b54d25ec2ff20) | 52713050 | | $0.001 per request, `alchemy_getAssetTransfers` | `200`, 475 transfers |
| 05:37:29 | 0.001000 | [`0x9658be43…24c2`](https://basescan.org/tx/0x9658be4307f5df6a7e3ada1832d705959e2556b3eb1650dbb3ac565f60ad24c2) | 52713051 | | $0.001 per request, `eth_call` | `500` Internal error |
| 06:15:15 | 1.000000 | [`0x4dd7859f…3078`](https://basescan.org/tx/0x4dd7859f951b18b79981e786227e8810d693249db24fdb777775a6acd4bc3078) | 52714184 | `0xca5e87f8…c70d` | $1 credits, on `alchemy_getAssetTransfers` | `402` with a new $1 quote after 5.0 s, no `PAYMENT-RESPONSE` |

Both credit quotes read: `exact`, `eip155:8453`, amount `1000000`, asset USDC `0x8335…2913`, `extra.name` "USD Coin". Description: "Purchase $1 of Alchemy API credits — includes 2,222,222 Compute Units (~100,000 requests) at $0.45 per million CUs."

## How to reproduce

These use Alchemy's own `@alchemy/x402` CLI (0.6.6) and curl. `wallet-key.txt` holds a wallet's private key. The `Authorization` header is the same for every request.

**1. Sign in** (free):

```sh
TOKEN=$(npx @alchemy/x402 sign --private-key ./wallet-key.txt)
```

**2. Check the wallet's state** (free; no `Payment-Signature`, so nothing is paid):

```sh
# JSON-RPC: our wallet gets 402 + a $1 quote, as if it had never paid.
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://x402.alchemy.com/base-mainnet/v2 \
  -H "Authorization: SIWE $TOKEN" -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}'

# REST: our wallet gets 429 "Monthly capacity limit exceeded" + an x-alchemy-trace-id.
# A never-funded wallet (npx @alchemy/x402 wallet generate) gets 402 here instead.
curl -s -i 'https://x402.alchemy.com/prices/v1/tokens/by-symbol?symbols=ETH' \
  -H "Authorization: SIWE $TOKEN" | grep -i -E '^HTTP|x-alchemy-trace-id|capacity'
```

**3. Buy the $1 top-up** (this spends 1 USDC). It follows [payment.md](https://github.com/alchemyplatform/skills/blob/main/skills/agentic-gateway/rules/x402/payment.md):

```sh
BODY='{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}'
curl -s -D headers.txt -o /dev/null -X POST https://x402.alchemy.com/base-mainnet/v2 \
  -H "Authorization: SIWE $TOKEN" -H 'Content-Type: application/json' -d "$BODY"
PAYMENT_REQUIRED=$(grep -i '^payment-required:' headers.txt | sed 's/^[^:]*: //' | tr -d '\r')
PAYMENT_SIG=$(npx @alchemy/x402 pay --private-key ./wallet-key.txt --payment-required "$PAYMENT_REQUIRED")
curl -s -i -X POST https://x402.alchemy.com/base-mainnet/v2 \
  -H "Authorization: SIWE $TOKEN" -H 'Content-Type: application/json' \
  -H "Payment-Signature: $PAYMENT_SIG" -d "$BODY"
```

Then repeat step 2. Expected: `200` on both. What we get: `402` and `429` (sections below).

**TypeScript, the same check** (free; Node 20+ or Bun, `npm i @alchemy/x402`). It prints the status for our wallet next to a never-funded one:

```ts
import { generateWallet, signSiwe } from '@alchemy/x402';
import { readFileSync } from 'node:fs';

const G = 'https://x402.alchemy.com';
const paidKey = readFileSync('wallet-key.txt', 'utf8').trim();
const freshKey = generateWallet().privateKey;

async function check(label: string, privateKey: string) {
  const auth = { Authorization: `SIWE ${await signSiwe({ privateKey })}` };
  const rpc = await fetch(`${G}/base-mainnet/v2`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }),
  });
  const rest = await fetch(`${G}/prices/v1/tokens/by-symbol?symbols=ETH`, { headers: auth });
  console.log(label, { rpc: rpc.status, rest: rest.status, trace: rest.headers.get('x-alchemy-trace-id'), restBody: (await rest.text()).slice(0, 60) });
}

await check('paid wallet', paidKey);   // ours: rpc 402, rest 429 "Monthly capacity limit exceeded"
await check('fresh wallet', freshKey); // rpc 402, rest 402
```

## First top-up: timeline (UTC, 2026-10-17)

Every request is a `POST https://x402.alchemy.com/base-mainnet/v2` with `Authorization: SIWE <token>` for the wallet above. Rows after the first paid nothing.

| Time | Sign-in | Method | Answer |
|---|---|---|---|
| 05:29:1x | token A | `eth_blockNumber` | `402` $1 quote → paid with `Payment-Signature` → **`500` `{"code":-32002,"message":"Internal error"}`**, with a `PAYMENT-RESPONSE` receipt for the first transaction |
| 05:29:1x | token A | `eth_blockNumber` | `500` Internal error (no `402`) |
| 05:29:1x | token A | `alchemy_getAssetTransfers` (USDC, `fromAddress` = wallet) | **`200`, 474 transfers, no payment asked** |
| 05:29:1x | token B (new) | `eth_blockNumber` | `500` Internal error |
| ~05:29:30 | token C (new) | `alchemy_getAssetTransfers` | `403` `{"code":-32600,"message":"Monthly capacity limit exceeded. Visit https://dashboard.alchemyapi.io/settings/billing …"}` |
| ~05:29:30 | token C | `eth_blockNumber`, `eth_chainId` | `402` $1 quote |
| ~05:29:30 | token C | `eth_call` (USDC `balanceOf`) | `500` Internal error |
| 05:30:14 | token D (new) | `alchemy_getAssetTransfers`, `eth_blockNumber`, `eth_call` | `402` $1 quote, all three |
| 05:31:00 | token E (new) | same three | `403` Monthly capacity limit exceeded; `500`; `500` |
| 05:31:46 | token F (new) | same three | `402`; `402`; `500` |
| 05:34:10, 05:34:11, 05:37:11 | new tokens | same three | `402` $1 quote, all three, every round |

The JSON-RPC responses carried no request-ID header. The only identifiers were `date` and `x-envoy-upstream-service-time`; `server` was `istio-envoy`.

## Follow-up, 06:02–06:04 UTC: the wallet has an account, but no capacity

About 35 minutes after the first payment we tried to use the credits again. Every request was unpaid: plain HTTP, never a `Payment-Signature` header.

| Route (signed in) | Our wallet (paid $1) | A never-funded wallet |
|---|---|---|
| `POST /base-mainnet/v2`: `alchemy_getAssetTransfers`, `eth_blockNumber`, `alchemy_getTokenBalances` | `402`, $1 quote | `402`, $1 quote |
| `POST /eth-mainnet/v2`: `eth_blockNumber` | `402`, $1 quote | — |
| `GET /prices/v1/tokens/by-symbol?symbols=ETH` | **`429` "Monthly capacity limit exceeded"**, trace `b8eeaa5e-afe3-47b4-8b0b-5ad422b162b8` | `402`, $1 quote |
| `POST /data/v1/assets/tokens/by-address` | **`429` "Monthly capacity limit exceeded"**, trace `d868e245-d2df-42d8-af22-40583ea4c5d0` | — |
| `GET /base-mainnet/nft/v3/getNFTsForOwner` | **`429` "Monthly capacity limit exceeded"** | `402`, $1 quote |

On the REST routes the gateway lets our wallet through, where a wallet that never paid gets a `402`. Alchemy's backend then refuses for capacity. So the payment created something for our wallet, but with no compute units behind it. The JSON-RPC routes don't see it at all and ask for another $1. The `403` "Monthly capacity limit exceeded" that `alchemy_getAssetTransfers` returned at 05:29:30 and 05:31:00 is the same backend refusal.

It is not our client:
- **Same sign-in token:** a token built exactly as `signSiwe` in [`@alchemy/x402`](https://www.npmjs.com/package/@alchemy/x402) 0.6.6 builds it (same message, base64url encoding) got the same answers as ours.
- **Same request flow:** the gateway client in [`@alchemy/cli`](https://www.npmjs.com/package/@alchemy/cli) 0.25.1 (`X402Client`) makes the same calls we do. It sends `Authorization: SIWE <token>`, reuses one token for an hour, and on a `402` pays and retries with `Payment-Signature`.
- **No balance endpoint:** the gateway has none we could check (`/balance`, `/credits`, `/account` answer `404`).

## Second top-up, 06:15 UTC: did not unlock the account

We paid one more $1, this time on `alchemy_getAssetTransfers`. That method had answered `200` before, so the paid request should not fail for an unrelated reason. Same wallet, same flow.

| Time | Step | Answer |
|---|---|---|
| 06:15:12 | Unpaid check, token T1 | `402`, $1 quote |
| 06:15:12 → 06:15:17 | Paid retry with `Payment-Signature`, token T1 | **`402` with a new $1 quote**, `x-envoy-upstream-service-time: 5034`, no `PAYMENT-RESPONSE`. The transfer settled on-chain at 06:15:15 (second $1 row above). |

Unpaid rounds afterwards, each over five routes:

| Time | Sign-in | `/base-mainnet/v2`: `alchemy_getAssetTransfers`, `eth_blockNumber`, `eth_call` | `/prices/v1/…` | `/data/v1/assets/tokens/by-address` |
|---|---|---|---|---|
| 06:15:17 | T1 (the paying token) | `402`, $1 quote, all three | `429` capacity, trace `7e2d2b76-2f5d-4bbf-83db-3ac0948299d2` | `429` capacity, trace `51d99da0-1f7c-4921-a5cb-54e5be324855` |
| 06:15:18 | new | `402`, all three | `429`, trace `ff70582b-e3d3-4f3c-b142-a05f32bcf33d` | `429`, trace `39b5418a-a465-485b-87aa-1ad1ce52bb0a` |
| 06:16:19 | new | `402`, all three | `429`, trace `a19fb426-8dd2-4dbb-99f2-658b3b2c5edc` | `429`, trace `b87aee75-b824-482e-a441-0d906e2f30ba` |
| 06:18:20 | new | `402`, all three | `429`, trace `d7c7cb23-90be-41b2-b2fb-1520d6c1cd6e` | `429`, trace `bcfe8349-020c-45ba-9192-7bd0ea500437` |
| 06:19:05 | new | `402`, all three, plus `alchemy_getTokenBalances` and `eth-mainnet` | `429` | — (NFT route: `429`) |

So a second payment changes nothing: no credits on JSON-RPC, no capacity on REST. Separately, a paid request can answer `402` after its payment has settled. A client then can't tell that it paid.

## Pay-per-request mode: the same methods fail after payment

At 05:37 UTC we called the gateway without SIWE, paying its "$0.001 per request — no account required" quote each time (the three 0.001 rows above). All three payments settled; `eth_blockNumber` and `eth_call` answered `500 Internal error` anyway, and `alchemy_getAssetTransfers` answered `200`. Across both modes, every standard `eth_*` call on `base-mainnet` that reached the backend answered `500`.

## Expected vs. actual

Alchemy's launch post says the agent pays, "Alchemy processes the request and returns the blockchain data, drawing from the newly funded balance. Subsequent requests work without additional payment until the balance runs out" ([blog](https://alchemy.com/blog/ai-agents-can-now-sign-up-for-alchemy)).

- **Expected:** the paid request returns its result; later requests from the same wallet draw on 2,222,222 CU per top-up without a `402`.
- **Actual:**
  - Two top-ups settled; the paid requests answered `500` and `402`.
  - Since then, JSON-RPC asks for another $1 every time. REST routes refuse with "Monthly capacity limit exceeded", which a never-funded wallet doesn't get.

## What we changed on our side

- **Accounting:** our client didn't count the first payment, because the response was a `500`. It now counts any payment whose `PAYMENT-RESPONSE` reports success. The second payment returned no receipt at all, so it still can't be seen from the response; the on-chain transfer is the only record.
- **App behavior:** the app has stopped paying the gateway (`ALCHEMY_GATEWAY_PAYMENTS=off`). It still calls the gateway unpaid, so restored credits would be used. Even when payments are on, it buys at most one top-up per 24 h across all its instances, and it never pays per request.
- Details: [alchemy-x402.md](alchemy-x402.md).
