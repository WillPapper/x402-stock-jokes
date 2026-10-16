# x402 Stock Jokes — Implementation Plan

Status: **draft for review** (2026-10-15). Nothing below is built yet.

## 1. Goal

A Flue agent on Cloudflare Workers that, given a ticker, produces a joke about that stock. Every upstream call is paid per request with USDC on Base via x402. No upstream API keys.

```
user: "tell me a joke about NVDA"
  │
  ├─ Step 1  StockTwits (x402, Cloudflare Monetization Gateway)  → price points + bull/bear sentiment + "why it's trending"
  ├─ Step 2  Ceramic search (x402, Cloudflare Monetization Gateway) → recent news headlines
  └─ Step 3  Cloudflare AI Gateway /ai/run (x402 machine payments)  → the joke
  │
  └─ reply: joke + the data it riffs on + Basescan receipts for each payment
```

## 2. What the research established (verified live today unless noted)

### StockTwits Monetization Gateway (x402) — preview
- Base URL `https://api-staging-mgw.stocktwits.com`. Priced: `GET /api/2/symbols/*`, 0.001 USD/request, USDC on Base mainnet (`eip155:8453`), x402 v2 `exact` scheme. Only `GET/HEAD/OPTIONS`. Geo-restricted (403 outside supported countries).
- Probed unpaid:
  - `GET /api/2/symbols/show/{SYM}.json` → **402** (documented). Returns only symbol metadata (title, exchange, watchlist_count). No price, no sentiment.
  - `GET /api/2/symbols/trending/{SYM}.json` → **402** (matches the `symbols/*` rule). Per the spec it returns `trending`, `trends.summary` ("why it's trending"), `sector`, `industry`.
  - `GET /api/2/streams/symbol/{SYM}.json` → **200, free** through the same gateway. 30 recent messages with `entities.sentiment.basic` (Bullish/Bearish/null), `prices[].price` (price at post time, so a mini time series), and `symbols[].sentiment_change` / `volume_change`.
- **Gap:** the dedicated sentiment/price-chart endpoints (`/api-middleware/external/sentiment/v2/...`) require Basic Auth and are *not* exposed over x402 (404 on the gateway host). See Open Question 1.
- Official TS client snippet uses `@x402/core` + `@x402/evm` + `@x402/fetch` + `viem`, `x402Client.fromConfig({ schemes, spendControls: { maxAmountPerPayment: "$0.01" } })`.

### Ceramic Search
- `POST https://api.ceramic.ai/search` with `{"query": "..."}` → **402** unpaid, quote: 1000 base units (0.001 USDC), `eip155:8453`, `maxTimeoutSeconds: 3600`. Response shape `result.results[] { title, url, description }`.
- Reference implementation: `github.com/CeramicTeam/ceramic-x402-search-agent` (budget-guarded signer pattern, receipt decoding; we will adapt `src/search.ts` from it).

### Cloudflare AI Gateway machine payments (x402)
- `POST https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/ai/run` with headers `Authorization: Bearer $CLOUDFLARE_API_TOKEN` **and** `Payment-Method: x402`. Body `{ "model": "z-ai/glm-4.7-flash", "input": { "max_tokens": N, "messages": [...] } }`.
- Eligible models: `z-ai/glm-4.7-flash`, `google/gemma-4-26b-a4b-it`, `openai/gpt-oss-20b`, `alibaba/qwen3.8-27b`.
- Flow: 402 → wallet signs authorization for the *maximum* → retry with `PAYMENT-SIGNATURE` → actual token cost deducted. Requires a US Cloudflare account with a card on file (not verified from here; see Open Question 3).
- Not verified: exact response envelope for `/ai/run` (docs list `result`, `usage`, `model`, `provider`). First task in Step 3 is to hit it once with curl and pin the parser to the real shape.

### Flue (v2.3.0)
- Scaffold: `npx @flue/cli init <dir> --target cloudflare`. Generates `flue.config.ts`, `vite.config.ts` (`flue()` then `cloudflare()`), `wrangler.jsonc` (`nodejs_compat`, compat date ≥ 2026-04-01, `new_sqlite_classes` migrations), `src/app.ts` (Hono), `src/agents/hello.ts`.
- Agent = exported capitalized function in a `'use agent'` file; returns the system prompt; `useModel('provider/model')`; `useTool(defineTool({...}))` with **Valibot** schemas; `durable: true` gives `step.do(name, fn)` for exactly-once-recorded side effects (exactly what a payment needs); `usePersistentState` for durable per-conversation state.
- `cloudflare/@cf/...` model specifiers run on Workers AI keylessly on the Cloudflare target (AI Gateway enabled by default). `import { env } from 'cloudflare:workers'` for secrets/bindings.
- HTTP: `createAgentRouter(Agent)` mounted in `app.ts` → `POST /agents/<name>/:id` (202, fire-and-forget), `GET` same URL for snapshot or `?view=updates&offset=...&live=sse`.
- Deploy: `npx vite build` then `npx wrangler deploy`. Secrets via `.dev.vars` locally, `wrangler secret put` in prod.

### Toolchain on this machine
Node 26.2, npm 11.13, pnpm and bun present, no global wrangler (use `npx`). Repo contains only README, LICENSE, .gitignore.

## 3. Architecture

```
src/
  app.ts                     Hono app; mounts the agent at /agents/joker; GET /health; GET /wallet (address + USDC balance)
  agents/joker.ts            'use agent' — StockJoker: useModel (orchestrator), useTool x3, usePersistentState (spend ledger), instructions
  tools/stocktwits.ts        fetch_stocktwits_signals  (durable; 1 paid call + 1 free call)
  tools/ceramic.ts           search_stock_news         (durable; 1–2 paid calls)
  tools/joke.ts              write_joke                (durable; 1 paid AI Gateway call)
  lib/x402.ts                buildPaidFetch(): x402Client + ExactEvmScheme(viem account) + guarded signer + receipt decode
  lib/budget.ts              per-call and per-conversation USDC caps (reserve / commit / release)
  lib/env.ts                 typed access to secrets via cloudflare:workers env
scripts/
  wallet-new.ts              generate a dedicated private key, print address, write .dev.vars (never overwrite an existing key)
  doctor.ts                  check USDC balance on Base, fetch the 402 quotes from StockTwits + Ceramic + AI Gateway, verify CF token
wrangler.jsonc / vite.config.ts / flue.config.ts / .dev.vars.example / PLAN.md / README.md
```

Design decisions baked in (flag if you disagree):
- **Three tools, fixed order via the agent instructions.** Each is `durable: true`; every paid request lives inside `step.do(...)` so a Durable Object restart never double-pays. Tool outputs carry `{ data, paid: "0.001", tx: "0x…" }` so receipts bubble into the reply.
- **Orchestrator model ≠ joke model.** Flue's provider layer cannot attach x402 payments, and AI Gateway machine payments only exist on the universal `/ai/run` endpoint. So the Flue agent runs on a keyless Workers AI model (`cloudflare/@cf/...`, billed to the Worker account, free tier) for routing/tool calls, and the *joke itself* is generated by a direct x402-paid `/ai/run` call inside `write_joke`. All three "content" steps are x402-paid; only the thin orchestration is not.
- **One shared x402 client** built once per isolate from `EVM_PRIVATE_KEY` (`network: "eip155:8453"`, `maxAmountPerPayment: "$0.01"` for data, a separate higher cap for inference). A budget guard wraps `signTypedData` so an over-cap payment is refused *before* it is signed (Ceramic's pattern). Per-conversation total tracked in `usePersistentState`.
- **Receipts are first-class.** Decode `PAYMENT-RESPONSE` (base64 JSON) → `https://basescan.org/tx/<hash>` in every tool output and in the final reply.
- **Always trust the 402 quote**, never hardcoded `payTo`/`amount`; the caps are the only client-side constants.

## 4. Implementation steps

0. **Scaffold** — `npx @flue/cli init` into a scratch dir (repo is non-empty), move generated files in, merge `.gitignore` (add `.dev.vars`, `.flue-vite.wrangler.jsonc`, `dist/`). Install `@x402/core @x402/evm @x402/fetch viem valibot`. Rename hello agent → `StockJoker`, update `wrangler.jsonc` migration class name (`FlueStockJokerAgent`). Commit.
1. **Wallet + doctor scripts** — `wallet-new` (viem `generatePrivateKey`), `doctor` (balance via `eth_call balanceOf` on `0x8335…2913`, decode the three 402 quotes, check `CLOUDFLARE_API_TOKEN` with `/ai/run` unpaid). Commit.
2. **`lib/x402.ts` + `lib/budget.ts`** — paid fetch factory, guarded signer, receipt decoder (use `atob`, not `Buffer`, to stay Workers-friendly). Unit tests (vitest) for budget math and receipt decoding. Commit.
3. **Step 1 tool: `fetch_stocktwits_signals(symbol)`** — paid `GET /api/2/symbols/trending/{SYM}.json`, free `GET /api/2/streams/symbol/{SYM}.json`; derive `{ title, exchange, sector, trendingSummary, latestPrice, priceRange, bullish, bearish, neutral, sentimentChange, volumeChange, topMessages[] (3 short bodies, stripped of HTML) }`. Handle 402-after-payment (decode `error`), 403 geo, 429. Commit.
4. **Step 2 tool: `search_stock_news(query)`** — paid `POST https://api.ceramic.ai/search`; query built from `title + ticker + "news"`; return top 5 `{title,url,description}`. Commit.
5. **Step 3 tool: `write_joke(context)`** — first pin the real `/ai/run` response shape with curl; then paid call with `Payment-Method: x402`, default model `z-ai/glm-4.7-flash`, tight prompt ("one joke, ≤ 60 words, reference at least one real datapoint, no financial advice"). Commit.
6. **Agent wiring** — `useModel('cloudflare/@cf/<small instruct model>')`, mount tools, instructions enforce order 1→2→3 and the reply format (joke, then a 3-line "based on" block, then receipts and total spent). `usePersistentState` spend ledger with a per-conversation cap. Commit.
7. **`app.ts` + wrangler** — mount `/agents/joker`, add `/health` and `/wallet`, `observability.enabled = true`. Commit.
8. **Local e2e** — fund wallet with ~$1 USDC on Base, `npx vite dev`, `curl -X POST .../agents/joker/demo -d '{"kind":"user","body":"joke about AAPL"}'`, read with `GET`. Fix whatever the real responses break. Commit.
9. **Deploy** — `wrangler secret put` ×3, `vite build`, `wrangler deploy`, smoke test on `*.workers.dev`. README: setup, funding, cost per joke, curl examples. Commit + push.

## 5. Secrets and config

| Name | Where | Purpose |
|---|---|---|
| `EVM_PRIVATE_KEY` | `.dev.vars` / `wrangler secret` | dedicated wallet, holds only a few USDC on Base |
| `CLOUDFLARE_ACCOUNT_ID` | `.dev.vars` / `wrangler secret` | AI Gateway `/ai/run` URL |
| `CLOUDFLARE_API_TOKEN` | `.dev.vars` / `wrangler secret` | required alongside `Payment-Method: x402` (Workers AI read scope) |
| `MAX_USDC_PER_CALL` (default `0.01`), `MAX_USDC_PER_JOKE` (default `0.05`), `JOKE_MODEL` | `vars` in wrangler.jsonc | caps and model override |

Expected cost per joke: 0.001 (trending) + 0.001–0.002 (search) + inference (sub-cent for a 60-word completion on glm-4.7-flash) ≈ **$0.003–0.01**.

## 6. Open questions for you

1. **StockTwits data.** The x402 preview does not expose the sentiment/price-chart endpoints. Proposed source for "price movements and sentiment": paid `symbols/trending` (why-trending summary) + free `streams/symbol` (per-message bull/bear labels, post-time prices, sentiment/volume change). OK, or do you have Basic Auth StockTwits credentials you want wired in as an optional richer path?
2. **Orchestrator model.** Keyless Workers AI (`cloudflare/@cf/...`) as proposed, or an Anthropic key (`anthropic/claude-haiku-4-5`) for more reliable tool-ordering?
3. **AI Gateway machine payments eligibility.** Is your Cloudflare account US-based with a card on file, and do you have (or can you create) an API token? If not, fallback for Step 3 is a keyless Workers AI call (no x402) and the plan notes it.
4. **Interface.** HTTP agent endpoints + curl examples only, or also a minimal static HTML page (ticker box → streamed joke) served from the same Worker?
5. **Package manager.** npm by default (lockfile committed); say so if you prefer pnpm/bun.

## 7. Risks

- `@x402/*` and `viem` inside workerd with `nodejs_compat`: expected to work (pure-JS crypto), verified in Step 2 before anything else depends on it.
- StockTwits preview is staging, no SLA, geo-fenced; the Worker's egress country decides the 403, not yours. If it fails from Cloudflare's edge we will know in Step 8.
- AI Gateway x402 authorizes a *maximum* per call; cap `max_tokens` (≈200) so the authorized amount stays small.
- Durable Object retries + payments: covered by `step.do`; the one unavoidable window is a crash between settlement and recording, which would cost one extra 0.001 USDC, not a double joke.
