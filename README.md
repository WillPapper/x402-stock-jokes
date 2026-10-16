# x402 Stock Jokes

One joke per ticker, and every step of making it is an **x402 micro-payment in USDC on Base**. No API keys for the data or the model, just a wallet.

```
"Tell me a joke about TSLA"
  → 1. StockTwits   GET symbols/show/TSLA (+ the free symbol stream)   0.001 USDC, exact
  → 2. Ceramic      POST /search "Tesla TSLA stock news"              0.001 USDC, exact
  → 3. AI Gateway   POST /ai/run google/gemma-4-26b-a4b-it            ≤ 0.026 USDC ceiling, upto
  and the agent's own turns on alibaba/qwen3.8-27b, also via AI Gateway x402 (≤ 0.13 USDC ceiling each)
```

Built with [Flue](https://flueframework.com) (Cloudflare's agent framework) on Workers + Durable Objects, the [x402](https://x402.org) TypeScript client, and three sellers behind Cloudflare's [Monetization Gateway](https://blog.cloudflare.com/monetization-gateway-beta/) / [AI Gateway machine payments](https://developers.cloudflare.com/ai-gateway/features/machine-payments/).

A real run (2026-10-16):

> NVDA is currently trading at $214.85, and people are losing their minds. One trader is out here questioning if the stock even looks good at that price, while analysts are dreaming of a $10 trillion market cap. I don't know about $10 trillion, but with 671,863 people watching it, it's definitely the most popular kid in school.
>
> Based on: NVDA traded at $214.85 on StockTwits with 671,863 people on its watchlist; an analyst sees about 31% upside and TipRanks asks if Nvidia can hit a $10 trillion market cap by 2030.
> Paid: StockTwits 0.001 USDC [tx](https://basescan.org/tx/0x23107b86878bb565e6f0adfec8ea5e699267417e3401ac67fd086be98dea9b9a), Ceramic 0.001 USDC [tx](https://basescan.org/tx/0xfc277a0f2047ef062676926562a67b377dcd93876f86a74d09ed2a0aabe10c7a), AI Gateway joke ≤ 0.0258 USDC

## How the money moves

| Step | Seller | Scheme | What you sign | Gas |
|---|---|---|---|---|
| 1, 2 | StockTwits, Ceramic (Monetization Gateway) | `exact` | USDC EIP-3009 `transferWithAuthorization` for exactly the quoted price | none, the facilitator pays |
| 3 and agent turns | Cloudflare AI Gateway `/ai/run` | `upto` | Permit2 `permitWitnessTransferFrom` for a *ceiling*; the actual token cost is settled | none per call, but one on-chain `USDC.approve(Permit2)` first |

The Flue agent's own model turns pay too: `src/lib/ai-gateway-provider.ts` is a pi-ai provider whose fetch rewrites each chat-completions call into the AI Gateway `/ai/run` envelope with `Payment-Method: x402`, pays the 402, and replays the completed result as a stream.

Spend caps live in `wrangler.jsonc` (`MAX_USDC_PER_DATA_CALL`, `MAX_USDC_PER_INFERENCE`, `MAX_USDC_PER_ISOLATE`) and are enforced *before* anything is signed (`src/lib/budget.ts`). Every payment is recorded with its Basescan receipt and attached to the reply.

## Setup

Requirements: [Bun](https://bun.sh), a Cloudflare account with AI Gateway machine payments enabled (US, card on file), and about $2 of USDC plus $0.25 of ETH on **Base mainnet**.

```sh
bun install
cp .dev.vars.example .dev.vars
```

Fill `.dev.vars`:

- `CLOUDFLARE_ACCOUNT_ID`: `cf accounts list` or `wrangler whoami`.
- `CLOUDFLARE_API_TOKEN`: a token with **Account › Workers AI › Read** (and AI Gateway › Run). Example via the `cf` CLI, after `cf auth login`:
  ```sh
  cf user tokens create --name x402-stock-jokes --policies '[{"effect":"allow","resources":{"com.cloudflare.api.account.<ACCOUNT_ID>":"*"},"permission_groups":[{"id":"a92d2450e05d4e7bb7d0a64968f83d11","name":"Workers AI Read"},{"id":"644535f4ed854494a59cb289d634b257","name":"AI Gateway Run"}]}]'
  ```
- `EVM_BASE_ADDRESS` / `EVM_BASE_PRIVATE_KEY`: `bun run wallet:new` creates a dedicated wallet, or paste your own. Keep only a few dollars in it.

Then:

```sh
bun run approve   # one-time USDC.approve(Permit2) on Base, needs a little ETH
bun run doctor    # balances, allowance, and the three live 402 quotes
```

## Run locally

```sh
bun run dev       # http://localhost:5173
```

Open the page, type a ticker, watch the three steps pay and complete. Or use the agent API directly:

```sh
curl -X POST http://localhost:5173/agents/joker/demo-1 \
  -H 'content-type: application/json' \
  -d '{"kind":"user","body":"Tell me a joke about NVDA."}'

curl http://localhost:5173/agents/joker/demo-1          # snapshot: tool calls, reply, payments in metadata
curl http://localhost:5173/api/wallet                    # address, USDC balance, Permit2 status
curl http://localhost:5173/api/ledger                    # every payment this instance made
```

Conversations are durable: reuse the same id to keep talking.

## Deploy

```sh
bunx wrangler login
bun run deploy                      # vite build && wrangler deploy
# then upload the four secrets (a JSON object of name → value; keep the file out of git):
bunx wrangler secret bulk secrets.json --name x402-stock-jokes
```

`cf deploy` does not understand Flue's Vite build output yet, so deploy goes through wrangler. Live instance: https://x402-stock-jokes.papper.workers.dev

## What's inside

```
src/app.ts                     routes: /agents/joker, /api/health, /api/wallet, /api/ledger; registers the x402 provider
src/agents/joker.ts            StockJoke: the Flue agent, its model and tools, payment metadata on every reply
src/tools/stocktwits.ts        step 1 (paid symbols/show + free stream → price, bull/bear counts, sample posts)
src/tools/ceramic.ts           step 2 (paid search → headlines)
src/tools/joke.ts              step 3 (paid /ai/run → the joke)
src/lib/x402.ts                one x402 client (exact + upto), budget-guarded signer, receipt decoding
src/lib/ai-gateway-provider.ts the agent's model, paid with x402 through AI Gateway
src/lib/budget.ts, ledger.ts   spend caps, payment records
public/index.html              the page
scripts/                       wallet:new, approve, doctor
```

Models: the orchestrator is `alibaba/qwen3.8-27b` (best multi-step tool use of the four machine-payment models) and the joke writer is `google/gemma-4-26b-a4b-it` (top of the four on creative-writing benchmarks). Both are thinking models; the joke call turns thinking off via `chat_template_kwargs.enable_thinking=false`, and the orchestrator keeps it on with a 2,048-token budget. Change either in `wrangler.jsonc` vars.

Cost per joke: about 0.002 USDC for data plus a few thousandths of a USDC settled for inference. AI Gateway quotes a *ceiling* per call against the model's full context window (about 0.13 USDC per Qwen turn, 0.026 per Gemma call), so the wallet must hold roughly 0.5 USDC of headroom even though far less is charged.

## Operational notes

- **Wallet headroom.** AI Gateway's `upto` quotes are ceilings against the full context window: about 0.13 USDC per Qwen turn and 0.026 per Gemma call, so one joke reserves roughly 0.55 USDC in flight while a few thousandths settle. Keep at least 1 USDC in the wallet or the facilitator refuses with `verify returned 403`.
- **Settlement is invisible per call.** AI Gateway returns no `PAYMENT-RESPONSE` receipt; the only confirmation is the wallet balance going down (`/api/wallet`, or `bun run doctor`).
- **Secrets are read lazily on purpose.** Workers validate the module at upload time before any secret exists, so nothing in `src/lib/env.ts` or `src/lib/x402.ts` touches a secret at import. Keep it that way when adding code, or `wrangler deploy` fails with error 10021.
- **Base RPC rate limits.** Public Base RPCs return 429 to Cloudflare's edge under light load; `/api/wallet` rotates through several and falls back to address-only. Set `BASE_RPC_URL` for the scripts if `mainnet.base.org` throttles you locally.
- **Reply format drift.** The orchestrator sometimes writes `Based:` instead of `Based on:`; the page accepts both. A structured-output step would make this strict.
- **`cf workers secrets bulk` did not set secrets** in this session (it reported success, then `secrets list` was empty); see [docs/cf-secrets-bulk-bug.md](./docs/cf-secrets-bulk-bug.md). `wrangler secret bulk` works.
- **Only `write_joke` may produce the joke.** The agent is told it cannot write jokes itself and may call a tool at most twice per reply; an earlier version retried a failing joke call seven times.

## Caveats

- StockTwits' x402 preview serves only `GET /api/2/symbols/show/{SYM}.json`; the price and sentiment numbers come from the free `streams/symbol` endpoint on the same gateway. The preview is staging, geo-fenced, and has no SLA.
- AI Gateway `/ai/run` does not stream under x402 and returns no `PAYMENT-RESPONSE` receipt; the page shows those rows as "settled by AI Gateway".
- Tool-calling orchestration on an open 27B model is good, not perfect. The agent is instructed to call all three tools in order and to only output jokes that came from step 3.

See [PLAN.md](./PLAN.md) for the design, the research behind it, and what was verified live.
