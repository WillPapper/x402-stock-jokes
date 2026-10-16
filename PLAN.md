# x402 Stock Jokes — Implementation Plan

Status: **built, deployed and verified in production, 2026-10-16** at https://x402-stock-jokes.papper.workers.dev. All steps done. Section 8 records what changed during implementation.

## 1. Goal

A Flue agent on Cloudflare Workers that, given a ticker, produces a joke about that stock. Every upstream call, including the agent's own model turns, is paid per request with USDC on Base via x402. No upstream API keys other than the Cloudflare token that AI Gateway machine payments require alongside the payment.

```
user: "tell me a joke about NVDA"           (HTML page or curl)
  │
  │  Flue agent StockJoke — its own model turns run on AI Gateway /ai/run, paid with x402
  │
  ├─ Step 1  StockTwits (x402, Cloudflare Monetization Gateway)  → symbol details + "why it's trending"
  ├─ Step 2  Ceramic search (x402, Cloudflare Monetization Gateway) → recent news headlines
  └─ Step 3  Cloudflare AI Gateway /ai/run (x402 machine payments)  → the joke
  │
  └─ reply: joke + the data it riffs on + Basescan receipts for every payment
```

## 2. What the research established

Verified live today unless marked otherwise.

### StockTwits Monetization Gateway (x402) — preview
- Base URL `https://api-staging-mgw.stocktwits.com`. Priced: `GET /api/2/symbols/*`, 0.001 USD/request, USDC on Base mainnet (`eip155:8453`), x402 v2 `exact` scheme. Only `GET/HEAD/OPTIONS`. Geo-restricted (403 outside supported countries).
- Probed unpaid:
  - `GET /api/2/symbols/show/{SYM}.json` → **402**. Returns symbol metadata: title, exchange, instrument class, watchlist_count, trade status.
  - `GET /api/2/symbols/trending/{SYM}.json` → **402**. Per the spec: `trending`, `trends.summary` (why it's trending), `sector`, `industry`, `last_updated`.
  - The dedicated sentiment and price-chart endpoints need Basic Auth and are not on the gateway. **Decision: use only the two paid endpoints.** Price movement and sentiment come from the trending summary text, which is what the preview sells to agents.
- Official TS client: `@x402/core` + `@x402/evm` + `@x402/fetch` + `viem`; `x402Client.fromConfig({ schemes: [{ network: "eip155:*", client: new ExactEvmScheme(signer) }], spendControls: { maxAmountPerPayment: "$0.01" } })`.

### Ceramic Search
- `POST https://api.ceramic.ai/search` with `{"query": "..."}` → **402** unpaid; quote 1000 base units (0.001 USDC), `eip155:8453`, `maxTimeoutSeconds: 3600`. Response `result.results[] { title, url, description }`.
- Reference implementation `github.com/CeramicTeam/ceramic-x402-search-agent`: budget-guarded signer, receipt decoding. We adapt its `src/search.ts`.

### Cloudflare AI Gateway machine payments (x402)
- `POST https://api.cloudflare.com/client/v4/accounts/$CLOUDFLARE_ACCOUNT_ID/ai/run`, headers `Authorization: Bearer $CLOUDFLARE_API_TOKEN` and `Payment-Method: x402`, body `{ "model": "...", "input": { "messages": [...], "max_tokens": N } }`. Universal endpoint only, per the docs.
- Eligible models: `z-ai/glm-4.7-flash`, `google/gemma-4-26b-a4b-it`, `openai/gpt-oss-20b`, `alibaba/qwen3.8-27b`.
- Flow: 402 → wallet signs an authorization for the *maximum* → retry with `PAYMENT-SIGNATURE` → actual token cost deducted.
- Account is confirmed eligible (Monetization Gateway active). **No fallbacks.**
- **Verified 2026-10-16 with the real token** (`x402-stock-jokes`, permissions Workers AI Read + AI Gateway Run, created via `cf user tokens create`, stored in `.dev.vars`):
  - Unpaid `POST /ai/run` with `Payment-Method: x402` → **402** with a standard x402 v2 `PAYMENT-REQUIRED` header. The token scope is sufficient (a scope problem would be 401/403).
  - The quote uses **scheme `upto`, not `exact`**: `amount` is a ceiling (25606 base units ≈ $0.0256 for `max_tokens: 20` on `openai/gpt-oss-20b`, priced as if the full 128k-token context were used) and the actual token cost is settled. The quote carries `extra.facilitatorAddress` and a `cloudflare-quote` JWT (valid 120 s) plus `cloudflare-model-provider` extensions.
  - `upto` on EVM is **Permit2-based** (`permitWitnessTransferFrom`), so the wallet needs a one-time on-chain `USDC.approve(Permit2)` on Base. The 402 advertises neither `eip2612GasSponsoring` nor `erc20ApprovalGasSponsoring`, so the approval is a direct transaction: **the wallet needs a little ETH on Base for that one tx** (cents). After that, payments are gasless signatures like `exact`.
  - The OpenAI-compatible `/ai/v1/chat/completions` path also answers 402 with the same price, but with a non-standard JSON body and **no `PAYMENT-REQUIRED` header**, so the x402 client cannot drive it. The provider shim must translate chat-completions requests into the `/ai/run` envelope.
  - Still unverified (needs the funded, approved wallet): the `/ai/run` success envelope, `input.tools` for tool calling, streaming.

### Flue 2.3.0 and how its model layer can pay with x402 (from reading the installed packages)
- Flue agents call models through `@earendil-works/pi-ai`. pi-ai's `ProviderRequestOptions` accepts `fetch?: FetchFunction` and `headers?`, and the `openai-completions` adapter passes both into the OpenAI SDK client it builds (`dist/api/openai-completions.js`, `createClient(model, ctx, apiKey, options.headers, options.fetch, ...)`). The adapter always requests `stream: true`.
- `createProvider({ id, auth, models, api })` (from `@earendil-works/pi-ai/models`) accepts `api: { stream, streamSimple }`. Wrapping `openAICompletionsApi()` so every call gets `{ fetch: paidFetch, headers: { 'Payment-Method': 'x402' } }` gives an x402-paying provider without touching Flue. `setProvider(...)` in `app.ts` registers it; a model specifier `x402-ai-gateway/openai/gpt-oss-20b` resolves provider = text before the first slash.
- Tools: `defineTool` with Valibot; `durable: true` gives `step.do(name, fn)` (exactly-once-recorded, so a payment is never repeated on Durable Object recovery). `usePersistentState` for a durable spend ledger. `useResponseFinish` can attach metadata (receipts) to the reply.
- Cloudflare target: `'use agent'` files → Durable Object classes; `wrangler.jsonc` owns `new_sqlite_classes` migrations; `import { env } from 'cloudflare:workers'` for secrets; static assets with `run_worker_first` for agent routes; `vite dev` / `vite build` / `wrangler deploy`.
- HTTP: `createAgentRouter(Agent)` → `POST /agents/<name>/:id` (202), `GET` same URL for a snapshot or `?view=updates&offset=...&live=sse` for a live stream.

### Toolchain
Node 26.2, **Bun** (chosen), no global wrangler (use `bunx`). The scaffold commit used npm and left a `package-lock.json`; step 1 swaps it for `bun.lock`.

## 3. Architecture

```
src/
  app.ts                     Hono app: setProvider(x402AiGatewayProvider), mount /agents/joker, GET /api/health, GET /api/wallet
  agents/joker.ts            'use agent' — StockJoke: useModel('x402-ai-gateway/openai/gpt-oss-20b'), useTool x3,
                             usePersistentState spend ledger, useResponseFinish receipts, ordered instructions
  tools/stocktwits.ts        fetch_stocktwits_signals  (durable; 2 paid calls: trending + show)
  tools/ceramic.ts           search_stock_news         (durable; 1 paid call)
  tools/joke.ts              write_joke                (durable; 1 paid /ai/run call)
  lib/x402.ts                buildPaidFetch(caps): x402Client + ExactEvmScheme(viem account) + budget-guarded signer + receipt decode
  lib/ai-gateway-provider.ts pi-ai createProvider wrapping openAICompletionsApi() with the paid fetch + Payment-Method header
                             (plus, if the spike says so, a chat-completions ⇄ /ai/run translating fetch)
  lib/budget.ts              per-call and per-conversation USDC caps (reserve / commit / release)
  lib/ledger.ts              in-isolate receipt ledger keyed by conversation id, read by useResponseFinish and the page
  lib/env.ts                 typed secrets via cloudflare:workers env
public/
  index.html                 ticker box → POST to the agent → SSE stream renders joke, data, receipts (no framework, one file)
scripts/
  wallet-new.ts              generate a dedicated key, print address, write .dev.vars (never overwrite an existing key)
  doctor.ts                  USDC balance on Base, decode the 402 quotes from StockTwits + Ceramic + AI Gateway, check CF token
wrangler.jsonc / vite.config.ts / flue.config.ts / .dev.vars.example / bun.lock / README.md
```

Design decisions:
- **Everything the model does is x402-paid.** The orchestrator provider pays per turn through AI Gateway machine payments. Step 3 stays a separate `write_joke` tool so the joke call has its own prompt, model, cap and receipt.
- **Three tools, fixed order via the instructions.** Each is `durable: true`; every paid request lives inside `step.do(...)`. Tool outputs carry `{ data, paid, tx }`.
- **One x402 client, both EVM schemes, two spend caps.** Register `ExactEvmScheme` (StockTwits, Ceramic) and `UptoEvmScheme` (AI Gateway) on `eip155:8453`. Data calls capped at $0.01 per payment; inference authorizations capped at $0.10 (AI Gateway quotes a ceiling against the full context window; the settled cost is far lower). The guard wraps `signTypedData`, so an over-cap payment is refused before it is signed. Per-conversation total in `usePersistentState`.
- **Receipts are first-class.** `PAYMENT-RESPONSE` decoded to `https://basescan.org/tx/<hash>` for tools and for orchestrator turns, shown in the reply and on the page.
- **Trust the 402 quote**, never hardcoded `payTo` or `amount`; caps are the only client-side constants.

## 4. Implementation steps

Commit after each step; push at the end of each step.

0. **Spike — partly done (token verified, quote decoded; see section 2).** Remaining, once the wallet holds USDC + a little ETH and the Permit2 approval is mined: (a) a paid `/ai/run` call to `openai/gpt-oss-20b`, record the success envelope and the settled amount from `PAYMENT-RESPONSE`; (b) repeat with `input.tools` to confirm tool calling; (c) try `stream: true`. (d) is settled: `/ai/v1/chat/completions` is not x402-drivable, so the paid fetch rewrites chat-completions requests into the `/ai/run` envelope and, if `/ai/run` does not stream, converts the completed result into a one-chunk SSE stream for the adapter.
1. **Scaffold — done (commit d8d4252).** Flue skeleton merged, agent `StockJoke` at `src/agents/joker.ts`, mounted at `/agents/joker`, x402 packages installed. Remaining: switch the lockfile to Bun (`rm package-lock.json && bun install`), add `@earendil-works/pi-ai` as a direct dependency for the provider shim, and replace the keyless `cloudflare/...` model with the x402 provider in step 4.
2. **Wallet + doctor + approve scripts.** `wallet-new` (key), `doctor` (USDC + ETH balances on Base, the three 402 quotes, Permit2 allowance), `approve-permit2` (one-time `USDC.approve(Permit2, max)` sent from the wallet, needs a few cents of ETH on Base).
3. **`lib/x402.ts`, `lib/budget.ts`, `lib/ledger.ts`** with `bun test` coverage for budget math and receipt decoding. Use `atob`, not `Buffer`.
4. **`lib/ai-gateway-provider.ts`** per the spike; register in `app.ts`; smoke-test one agent turn locally under `vite dev` and confirm a receipt.
5. **Step 1 tool `fetch_stocktwits_signals(symbol)`**: paid `symbols/trending` + paid `symbols/show` → `{ title, exchange, sector, industry, trending, trendingSummary, watchlistCount, lastUpdated }`. Handle 402-after-payment (decode `error`), 403 geo, 429.
6. **Step 2 tool `search_stock_news(query)`**: paid Ceramic search, query from title + ticker + "stock news", top 5 results.
7. **Step 3 tool `write_joke(context)`**: paid `/ai/run` with `z-ai/glm-4.7-flash` (configurable), prompt: one joke ≤ 60 words, must reference a real datapoint, no financial advice.
8. **Agent wiring**: instructions enforce 1→2→3 and the reply format (joke, "based on" block, receipts, total spent); spend ledger; `useResponseFinish` metadata with orchestrator receipts.
9. **`public/index.html` + `app.ts` routes + wrangler assets** (`run_worker_first: ["/agents/*", "/api/*"]`), observability on.
10. **Local e2e** with ~$1 USDC: `curl -X POST .../agents/joker/demo -d '{"kind":"user","body":"joke about AAPL"}'`, read with `GET`, then the page. Fix whatever real responses break.
11. **Deploy**: `wrangler secret put` ×3, `bunx vite build`, `bunx wrangler deploy`, smoke test. README: setup, funding, cost per joke, curl examples.

## 5. Secrets and config

| Name | Where | Purpose |
|---|---|---|
| `EVM_PRIVATE_KEY` | `.dev.vars` / `wrangler secret` | dedicated wallet, holds only a few USDC on Base |
| `CLOUDFLARE_ACCOUNT_ID` | `.dev.vars` / `wrangler secret` | AI Gateway `/ai/run` URL |
| `CLOUDFLARE_API_TOKEN` | `.dev.vars` / `wrangler secret` | required alongside `Payment-Method: x402` |
| `MAX_USDC_PER_DATA_CALL` (`0.01`), `MAX_USDC_PER_INFERENCE` (`0.10`, authorization ceiling), `MAX_USDC_PER_JOKE` (`0.25`, authorized total), `ORCHESTRATOR_MODEL`, `JOKE_MODEL` | `vars` in wrangler.jsonc | caps and model overrides |

Expected cost per joke: 0.002 (StockTwits) + 0.001 (Ceramic) + 3–4 orchestrator turns + 1 joke call on sub-cent open models ≈ **$0.005–0.03** settled, dominated by inference. Note the `upto` authorizations are ceilings: the wallet must hold at least the ceiling of each in-flight call (≈ $0.03–0.10) even though far less is charged.

## 6. Review decisions (2026-10-15)

1. StockTwits source: **x402 paid endpoints only** (`symbols/trending`, `symbols/show`). No Basic Auth path, no free stream.
2. Orchestrator model: **AI Gateway machine-payment models via x402**, through a custom pi-ai provider (section 2, Flue). Default `openai/gpt-oss-20b` for tool calling; spike may change it.
3. AI Gateway eligibility: **confirmed, no fallbacks.**
4. Interface: **both** HTTP agent endpoints and a static HTML page on the same Worker.
5. Package manager: **Bun.**

## 7. Risks

- **Provider shim is the critical path.** If `/ai/run` rejects `tools` for every eligible model, the orchestrator cannot call tools and the design must change (e.g. deterministic pipeline behind one durable tool). The spike settles this first, before any other code.
- **Streaming.** pi-ai's adapter always streams; if `/ai/run` is non-streaming under x402 we synthesize SSE from the completed result. Latency is fine for a joke; correctness of usage/cost fields needs a check.
- `@x402/*` and `viem` inside workerd with `nodejs_compat`: expected to work (pure-JS crypto), verified in step 3.
- StockTwits preview: staging, no SLA, geo-fenced by the Worker's egress country, not yours. Known at step 10.
- Durable Object retries and payments: covered by `step.do`; the orchestrator turns are not inside `step.do`, so an interrupted turn may be re-run and paid again. Flue only retries when it can prove the provider call did not complete, which bounds this to one extra turn.

## 8. Implementation log (2026-10-16)

- **AI Gateway x402 is `upto` + Permit2.** Added `UptoEvmScheme`, a one-time `scripts/approve-permit2.ts`, and ETH-for-gas to the wallet checklist. No `PAYMENT-RESPONSE` receipt comes back from AI Gateway; settlement is visible only as wallet balance.
- **`/ai/run` facts:** returns `{ result: <OpenAI chat.completion>, success }`; `tools` work; `stream: true` yields an empty result; message `content` must be a string. The provider shim (`src/lib/ai-gateway-provider.ts`) rewrites, pays, normalizes, and replays the completion as SSE.
- **StockTwits preview reality:** only `symbols/show` is served; `symbols/trending` and other `symbols/*` paths 402 then 404 at the origin (not charged). Step 1 pays for `symbols/show` and reads the free `streams/symbol` on the same gateway for prices and bull/bear counts.
- **Models (per review on 2026-10-16):** orchestrator `alibaba/qwen3.8-27b`, joke `google/gemma-4-26b-a4b-it`. Thinking models burn the whole budget reasoning unless `chat_template_kwargs: { enable_thinking: false }` is sent (works for Gemma and Qwen; `thinking`/`reasoning_effort` flags are ignored). Qwen's ceiling is ≈ 0.13 USDC per turn, so `MAX_USDC_PER_INFERENCE` is 0.25.
- **Agent guardrails:** the agent may only output a joke returned by `write_joke`; tool retries are capped by instruction; an earlier run retried a failing joke call seven times before the facilitator refused.
- **Bun** replaced the npm lockfile; the Workers AI binding was removed so `vite dev` runs without a wrangler login.
- **Deploy:** Workers validate the module at upload time before secrets exist, so every secret read (wallet key, account id, token, even the x402 client construction) is lazy. `cf deploy` cannot handle the Flue/Vite output; `wrangler deploy` + `wrangler secret bulk` are used. Public Base RPCs rate-limit the edge, so `/api/wallet` tries several and degrades to address-only.
