# x402 Stock Jokes

One joke per ticker, and every step of making it is an **x402 micro-payment in USDC on Base**. No API keys for the data or the model, just a wallet. Live at **https://jokes.papper.me**.

```
"Tell me a joke about TSLA"
  → 1. StockTwits   GET symbols/show/TSLA (+ the free symbol stream)   0.001 USDC, exact
  → 2. Ceramic      POST /search ×3 keyword queries, ranked locally    0.003 USDC, exact
  → 3. AI Gateway   POST /ai/run google/gemma-4-26b-a4b-it            ≤ 0.026 USDC ceiling, upto
  and the agent's own turns on alibaba/qwen3.8-27b, also via AI Gateway x402 (≤ 0.13 USDC ceiling each)
```

Built with [Flue](https://flueframework.com) (Cloudflare's agent framework) on Workers, Durable Objects and D1, the [x402](https://x402.org) TypeScript client, and three sellers behind Cloudflare's [Monetization Gateway](https://blog.cloudflare.com/monetization-gateway-beta/) / [AI Gateway machine payments](https://developers.cloudflare.com/ai-gateway/features/machine-payments/). The app is itself an x402 seller: submitting a joke without the password costs 0.10 USDC through the Monetization Gateway.

A real run (2026-10-17):

> AstraZeneca is using Salesforce's new AI platform to transform their global customer engagement. I assume that means instead of a doctor calling me, an automated bot will just text me to tell me I'm dying.
>
> Based on: AstraZeneca picked Salesforce's Agentforce Life Sciences for global customer engagement per its 2026 Connectivity Report (salesforce.com); TCS agreed to buy Salesforce consulting firm Coastal Cloud for $700 million (techcircle.in); Salesforce beat Wall Street forecasts in Q3 FY2026 with AI revenue tripling year over year (IBTimes UK).
> Paid: StockTwits 0.001 USDC [tx](https://basescan.org/tx/0xeb6698896d6b8e446061c1ebdb08722b698b60b95e56c74803483dd78a20e332), Ceramic 3 × 0.001 USDC ([tx](https://basescan.org/tx/0x8f783699ea4c4c66a0a4a8a97110ddd12adbf7fc56111e91852f4d21c02fbfe0), [tx](https://basescan.org/tx/0x5b3191e15cbc417b2662e946065d2d8df4b878b61d78bc7da882cfd154ff2c01), [tx](https://basescan.org/tx/0xb8c5c0c28849518fa25d7243553caaf086a30f5b37f251639482d28b3aed1a0c)), AI Gateway joke ≤ 0.0257 USDC

## Architecture

```
  Buyer (browser or agent)
      │  POST /joke/NVDA          pays 0.10 USDC (x402)  or sends a coupon code
      ▼
  Cloudflare Monetization Gateway ── 402 quote → verify payment → forward with PAYMENT-CONTEXT
      │
      ▼
  Worker (Hono, src/routes/agent.ts) checks coupon or JWT, inserts the run in D1, answers 202
      │  submit
      ▼
  JokeRunner (Durable Object, US)  alarm fires at once → dispatch(Joke)
      │
      ▼
  Flue agent Joke (Durable Object, src/agents/joke.ts)
      │
      ├─ model turns ───────▶ AI Gateway /ai/run    x402 upto   (real token cost settled)
      ├─ 1. fetch_stocktwits ▶ StockTwits            x402 exact  0.001 USDC
      ├─ 2. search_stock_news ▶ Ceramic               x402 exact  0.001 USDC
      ├─ 3. write_joke ──────▶ AI Gateway /ai/run    x402 upto   (real token cost settled)
      │
      ▼
  D1 (runs, run_payments, jokes)  ◀── GET /joke/<id> polls here, never the agent; feed and stats read here too
                       (events is a debug log: every gateway exchange, behind Cloudflare Access)

  Money, per joke (USDC on Base; averages over the 21 jokes in D1 on 2026-10-17):

    buyer ──0.100──▶ app wallet ──▶ StockTwits    0.001   exact: charged as quoted
                                ──▶ Ceramic       0.001   exact: charged as quoted
                                ──▶ AI Gateway    0.55    upto: the ceiling the wallet signs
                                                          (4-5 turns × 0.131 + joke call 0.026)
                                                  0.014   what AI Gateway actually settles (0.009-0.026)

    in 0.100  →  out 0.016 on average (worst seen 0.028)  →  margin 0.084, about 84%

    The ceiling is never charged, only held in flight, so the wallet needs about 0.6 USDC
    of headroom per joke. If a joke were ever charged its full ceiling it would lose 0.45.
    Caps in src/lib/budget.ts refuse anything above wrangler.jsonc's limits before signing;
    the settled figures come from the wallet's on-chain history via Alchemy (/api/stats).
```

The runner exists because Cloudflare's gateways are US-only and judge the visitor whose request is in flight; an alarm has no visitor, so every paid call leaves from a US Durable Object with nobody attached (see [Where the agent runs](#where-the-agent-runs-and-why-it-matters)).

## How the money moves

| Step | Seller | Scheme | What you sign | Gas |
|---|---|---|---|---|
| 1, 2 | StockTwits, Ceramic (Monetization Gateway) | `exact` | USDC EIP-3009 `transferWithAuthorization` for exactly the quoted price | none, the facilitator pays |
| 3 and agent turns | Cloudflare AI Gateway `/ai/run` | `upto` | Permit2 `permitWitnessTransferFrom` for a *ceiling*; the actual token cost is settled | none per call, but one on-chain `USDC.approve(Permit2)` first |
| Submitting a joke to *this* app | jokes.papper.me (Monetization Gateway) | `exact` | 0.10 USDC, unless you send the password | none |

The Flue agent's own model turns pay too: `src/lib/ai-gateway-provider.ts` is a pi-ai provider whose fetch rewrites each chat-completions call into the AI Gateway `/ai/run` envelope with `Payment-Method: x402`, pays the 402, and replays the completed result as a stream.

Spend caps and model choices are plain-text vars in `wrangler.jsonc`, enforced *before* anything is signed (`src/lib/budget.ts`). Every payment is recorded with its Basescan receipt, attached to the reply, and stored with the joke in D1.

| Var (`wrangler.jsonc` → `vars`) | Default | Meaning |
|---|---|---|
| `ORCHESTRATOR_MODEL` | `alibaba/qwen3.8-27b` | the agent's own model; must be one of the four AI Gateway machine-payment models |
| `JOKE_MODEL` | `google/gemma-4-26b-a4b-it` | the model `write_joke` pays for |
| `MAX_USDC_PER_DATA_CALL` | `0.01` | cap per StockTwits or Ceramic payment (they quote 0.001) |
| `MAX_USDC_PER_INFERENCE` | `0.25` | cap per AI Gateway authorization ceiling (Qwen quotes about 0.13) |
| `MAX_USDC_PER_ISOLATE` | `5` | total one Worker isolate may authorize before it refuses |
| `ALCHEMY_GATEWAY_PAYMENTS` | `off` | `off`: the Alchemy fallback uses only credits already on the wallet and never pays. `credits`: it may also buy a $1 top-up (at most one a day). There is no pay-per-request mode: at $0.001 a call it costs 18× to 222× the credits price ([docs/alchemy-x402.md](docs/alchemy-x402.md)) |
| `MAX_USDC_PER_ALCHEMY_TOPUP` | `1` | cap per Alchemy gateway credit top-up (quoted at exactly 1.00), used only when the free Alchemy key is out of capacity |
| `MAX_USDC_ALCHEMY_PER_ISOLATE` | `1` | Alchemy top-ups one isolate may buy; app-wide the code also allows at most one per 24 h |

They apply in `bun run dev`, in production, and in the scripts, which read `wrangler.jsonc` too. `.dev.vars` holds only the secrets.

## Who can submit a joke

Submitting a joke (`POST /joke/<TICKER>` or `POST /agents/joke/<id>`) spends real money, so it needs one of:

- a coupon code, in the `X-Joke-Password` header (header only, never the URL), stored as the `JOKE_PASSWORD` secret; a WAF rate-limiting rule blocks an IP that sends more than 5 coupon POSTs in 10 seconds; or
- an x402 payment of **0.10 USDC** to the app, handled by Cloudflare's Monetization Gateway in front of `jokes.papper.me`. The gateway answers the first request with a real x402 `402` quote, verifies the signed USDC authorization on the retry, and forwards the request with a signed `PAYMENT-CONTEXT` JWT that the Worker verifies against `https://payments.cloudflare.com/certs` (`src/lib/access.ts`). The token's audience must be the URL that was paid for, and each token admits exactly one request (hashes in the D1 `payment_tokens` table).

Neither present: the gateway answers `402` with the x402 quote (and, off the gateway, the Worker answers `402` with instructions and the latest cached joke). Reading a conversation or a joke status (`GET`), the feed and the stats are always free.

**Simple API for agents:** `POST https://jokes.papper.me/joke/NVDA` (no body) returns `202 { id, poll }`; `GET` the `poll` URL until `done` is true to get `joke`, `basedOn`, `steps` and `payments`. Full instructions, including the x402 flow and a TypeScript example, are served at [jokes.papper.me/agent.md](https://jokes.papper.me/agent.md); the page's "Copy instructions for my agent" button copies them with the ticker filled in.

Gateway rule on the `papper.me` zone (dashboard, or `cf monetization rules update`; the API form is a Wirefilter expression):

```
http.host eq "jokes.papper.me" and starts_with(http.request.uri.path, "/agents/joke/")
  and http.request.method eq "POST" and not len(http.request.headers["x-joke-password"]) > 0
```
Fixed price `$0.10` (`exact`), audience Everyone, receiving wallet = the app wallet, so revenue tops up what the app spends. The rule matches both `/agents/joke/` and `/joke/` and charges whenever the header is *absent*; the Worker checks the header's *value*, so a wrong coupon code is a 401, not a free ride.

Verified 2026-10-16: an unpaid POST gets the gateway's 402 with a 0.10 USDC quote; `bun scripts/pay-for-joke.ts TSLA` from a second wallet paid it ([tx](https://basescan.org/tx/0x140f1cc2580e8a7771d6e55e5cd248715bc7ade6142549174c775df32634725c)), the Worker accepted the signed `PAYMENT-CONTEXT`, and the joke was stored with `paidBy: "x402"`. Paying from the app's own wallet is refused by the facilitator ("facilitator rejected verify request"), so use a different wallet to test.

## Where the agent runs, and why it matters

Monetization Gateway and AI Gateway machine payments are US-only, and they evaluate the country of the **visitor whose request is in flight** when the Worker pays, not the account, the wallet, or the datacenter. Cloudflare carries that identity down the whole request chain, and a Durable Object attributes its outbound calls to whichever incoming request is active. So the path is built to keep every visitor out of the paying code:

1. The entry Worker (any colo, any visitor) only checks the coupon or the gateway's payment and **queues** the message into `JokeRunner`, a Durable Object in the `us` jurisdiction (`src/cloudflare.ts`).
2. The runner's **alarm**, which has no originating request, dispatches the agent as soon as the submit call has returned. The agent's Durable Object is placed next to the runner (ORD so far) and every paid call leaves from there with no visitor attached.
3. **Nothing reads the agent's object.** Each tool writes its step to the run's D1 row (`runs`), every payment lands in `run_payments`, the finished joke goes to `jokes`, and `GET /joke/<id>` is served from those rows. Conversation reads (`GET /agents/joke/<id>`, streams) answer with the D1 status until the run is done, then serve the conversation with the account id redacted; abort is not public.

Verified with a Canadian VPN: submit, poll every 2 s, full run, all payments 200. The `gate` events record visitor country, runner and agent colo for every run. Full write-up and bug report: [docs/ai-gateway-visitor-country.md](./docs/ai-gateway-visitor-country.md).

## Logging and reporting gateway bugs

Every gateway interaction is logged as one JSON line (Workers Logs) and stored in the D1 `events` table:

- `x402.payment`: one per paid call, with every HTTP attempt (the 402 quote with its `cloudflare-quote` JWT claims, the `PAYMENT-SIGNATURE` we sent minus the signature bytes, the final status, the decoded `PAYMENT-RESPONSE`), the upstream ids (`cf-ray`, `cf-aig-request-id`, `cf-aig-event-id`, `cf-aig-trace-id`, `cf-auditlog-id`), payer, amounts, and timings.
- `gate`: each admission or denial with visitor country/colo, the verified `PAYMENT-CONTEXT` claims and key id for x402 payers, plus the runner's and agent's colo probes.
- `ai.turn`: each orchestrator model turn with usage, finish reason and ids.
- `tool.start` / `tool.done` / `tool.error` / `agent.done`: step and run transitions (the full tool outputs live on the run's row in `runs.steps`, not in the event).
- `error`: tool failures at agent finish.

Read them with `GET /api/events?conversation=<id>`, `?failures=1`, `?kind=x402.payment`, `?since=<iso>`, or live with `bunx wrangler tail x402-stock-jokes --format json`. `/api/events` and `/api/_trace` are **internal**: they hold visitor IPs, countries and raw gateway exchanges, so they sit behind a Cloudflare Access self-hosted application (Allow policy for the owner's email, Service Auth policy for a service token), and the Worker verifies the `Cf-Access-Jwt-Assertion` JWT itself (`src/lib/internal.ts`; team domain and AUD tag in `wrangler.jsonc` vars, empty AUD = 403). In a browser the page's "x402 gateway events" links go through the Access login; from a script send the service token headers:

```sh
curl -H "CF-Access-Client-Id: <client_id>" -H "CF-Access-Client-Secret: <client_secret>" "https://jokes.papper.me/api/events?limit=20"
```

Payment records are stored with the Cloudflare account id already stripped from AI Gateway URLs (rows from before 2026-10-17 are cleaned when read); the `events` table and Workers Logs keep the full URL. To report a bug to Cloudflare, send the event JSON for the conversation: it has the `cf-ray` and `cf-aig-*` ids, the quote `jti`, the payer address, the tx hash and the exact timestamps. `GET /api/_trace` shows what a subrequest from the Worker looks like to Cloudflare-fronted endpoints.

## The page

`web/`, an Astro site: one component per card (`web/src/components/`), the client logic as TypeScript modules (`web/src/scripts/`, components talk through typed events), shared styles in `web/src/styles/global.css`, and no client framework beyond that. You enter a ticker, nothing else. Every joke card's StockTwits, Ceramic and AI Gateway badges expand into an "under the hood" panel with that service's full response, the facts passed to the model, the payment, and links to the conversation JSON and the x402 gateway events; the same works on the live run's step rows. Jokes made before the step archive existed (2026-10-16) show a note instead. The 402 card then offers two paths: copy the agent instructions (your agent pays 0.10 USDC with x402), or type a coupon code for a free joke; a working coupon is remembered in the browser. The run shows each of the three steps and the agent's turns with receipt chips, then the joke and the facts behind it. Below: a live feed of every joke ever made (polled from D1 every 3 s), counters, and a jokes-per-hour sparkline.

**Money numbers come from the chain, not from estimates.** Every x402 payment is a USDC transfer out of the app wallet, so `/api/stats` reads the wallet's USDC history through Alchemy's Transfers API (`ALCHEMY_API_KEY`) and reports **USDC paid on-chain** per seller and the number of x402 jokes sold (from the gateway's `PAYMENT-CONTEXT` amounts). The `upto` scheme never moves the authorized ceiling: AI Gateway settles only the real token cost, within seconds of each call. StockTwits and Ceramic amounts are matched to each joke by transaction hash; AI Gateway settlements by a time window around the joke (so concurrent jokes can share a settlement).

## Setup

Requirements: [Bun](https://bun.sh), a Cloudflare account with AI Gateway machine payments and Monetization Gateway enabled (US, card on file), and about $2 of USDC plus $0.25 of ETH on **Base mainnet**.

```sh
bun install
cp .dev.vars.example .dev.vars
```

Fill `.dev.vars`:

- `CLOUDFLARE_ACCOUNT_ID`: `cf accounts list` or `bunx wrangler whoami`.
- `CLOUDFLARE_API_TOKEN`: a token with **Account › Workers AI › Read** (and AI Gateway › Run). Example via the `cf` CLI, after `cf auth login`:
  ```sh
  cf user tokens create --name x402-stock-jokes --policies '[{"effect":"allow","resources":{"com.cloudflare.api.account.<ACCOUNT_ID>":"*"},"permission_groups":[{"id":"a92d2450e05d4e7bb7d0a64968f83d11","name":"Workers AI Read"},{"id":"644535f4ed854494a59cb289d634b257","name":"AI Gateway Run"}]}]'
  ```
- `EVM_BASE_ADDRESS` / `EVM_BASE_PRIVATE_KEY`: `bun run wallet:new` creates a dedicated wallet, or paste your own. Keep only a few dollars in it.
- `JOKE_PASSWORD`: the coupon code that lets friends skip the paywall.
- `ALCHEMY_API_KEY`: an [Alchemy](https://www.alchemy.com) app key with Base Mainnet enabled, for the wallet's USDC history (`/api/stats`, `/api/transfers`). When Alchemy refuses it for capacity (429, or 403 "Monthly capacity limit exceeded"), calls fall back to Alchemy's x402 gateway, paid from the app wallet's prepaid credits ([docs/alchemy-x402.md](docs/alchemy-x402.md)).

Then:

```sh
bun run approve            # one-time USDC.approve(Permit2) on Base, needs a little ETH
bun run doctor             # balances, allowance, and the three live 402 quotes
bun run db:migrate:local   # D1 schema for the local dev database
```

## Run locally

```sh
bun run dev       # the Worker at http://localhost:5173 and the page at http://localhost:4321
```

`bun run dev:worker` and `bun run dev:web` start either alone; `API_ORIGIN=https://jokes.papper.me bun run dev:web` serves the page against production data, which is the quickest way to work on the UI.

Open the page, type a ticker and the password, watch the three steps pay and complete. Or use the agent API directly:

```sh
curl -X POST http://localhost:5173/joke/NVDA -H 'x-joke-password: <JOKE_PASSWORD>'   # names the run j-nvda-<time>-<rand>

# or name the run yourself (use a test- prefix for hand runs so they are easy to spot):
curl -X POST http://localhost:5173/agents/joke/test-demo-1 \
  -H 'content-type: application/json' -H 'x-joke-password: <JOKE_PASSWORD>' \
  -d '{"kind":"user","body":"Tell me a joke about NVDA."}'

curl http://localhost:5173/joke/test-demo-1             # status from D1: steps with outputs, payments, joke
curl http://localhost:5173/api/jokes?limit=10           # feed, newest first (add &after=<iso> for updates)
curl 'http://localhost:5173/api/jokes/latest?ticker=NVDA'
curl http://localhost:5173/api/stats                    # count, tickers, USDC authorized, per-hour buckets
curl http://localhost:5173/api/wallet                   # address, USDC balance, Permit2 status
```

Conversation reads are not public (they would lend the reader's location to in-flight payments); `/joke/<id>` is the status API. `bun scripts/pay-for-joke.ts NVDA` pays the app from `BUYER_PRIVATE_KEY` (or the app wallet) and prints the joke; the core of it:

```ts
import { x402Client } from "@x402/core/client";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { wrapFetchWithPayment } from "@x402/fetch";
import { privateKeyToAccount } from "viem/accounts";
const client = x402Client.fromConfig({ schemes: [{ network: "eip155:8453", client: new ExactEvmScheme(privateKeyToAccount(KEY)) }], spendControls: { maxAmountPerPayment: "$0.25" } });
const fetchWithPayment = wrapFetchWithPayment(fetch, client);
await fetchWithPayment("https://jokes.papper.me/agents/joke/my-id", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "user", body: "Tell me a joke about NVDA." }) });
```

## Deploy

```sh
bunx wrangler login
bun run db:migrate                  # D1 schema (once per migration)
bun run deploy                      # vite build (Worker) + astro build (page into dist/client), then wrangler deploy; creates the jokes.papper.me custom domain
# upload the six secrets (a JSON object of name → value; keep the file out of git):
bunx wrangler secret bulk secrets.json --name x402-stock-jokes
```

`cf deploy` does not understand Flue's Vite build output yet, so deploy goes through wrangler. Everything else (login, tokens, D1 creation) works with the `cf` CLI.

## What's inside

```
src/app.ts                     the route map: mounts the four route modules below
src/routes/agent.ts            startJoke (the one gate + runner hand-off), POST /joke/<TICKER>, GET /joke/<id>, the /agents/joke/* conversation routes
src/routes/public.ts           /api/health, /api/jokes, /api/jokes/latest, /api/stats, /api/transfers, /api/wallet, /api/ledger
src/routes/permalink.ts        GET /j/<id>, the shareable page
src/routes/internal.ts         /api/events, /api/_trace (behind Cloudflare Access, src/lib/internal.ts)
src/cloudflare.ts              JokeRunner: us-jurisdiction Durable Object that starts every conversation; registers the x402 AI Gateway provider
src/lib/runs.ts                D1 `runs` + `run_payments`: the run's state, step states and outputs, payments; runStatus()
src/lib/status.ts              statusOf(): the run row + joke row → the JSON the page polls (pure, unit-tested)
src/lib/persist.ts             persistJoke(): the joke row from the run's own records (called by write_joke and by the finish hook)
src/lib/settlement.ts          what each joke cost on-chain, computed once and stored in jokes.settled
src/lib/log.ts                 structured events (Workers Logs + D1 `events`), the conversation log scope
src/lib/upstream.ts            cf-ray / cf-aig-* extraction, JWT payload decoding
src/agents/joke.ts             Joke: the Flue agent, its model and tools, payment metadata on every reply, closes the run on finish
src/tools/stocktwits.ts        step 1 (paid symbols/show + free stream → price, bull/bear counts, sample posts)
src/tools/ceramic.ts           step 2 (three paid searches → ranked company news; ranking in src/lib/news.ts)
src/tools/joke.ts              step 3 (paid /ai/run → the joke)
src/lib/x402.ts                one x402 client (exact + upto), budget-guarded signer, receipt decoding
src/lib/ai-gateway-provider.ts the agent's model, paid with x402 through AI Gateway
src/lib/access.ts              password or Monetization Gateway PAYMENT-CONTEXT check
src/lib/db.ts                  D1 `jokes`: insert, complete, feed, per-ticker latest, stats; `payment_tokens`
src/lib/transfers.ts           the wallet's USDC transfers from Alchemy: USDC paid per seller, earned
src/lib/alchemy.ts             Alchemy JSON-RPC: free key first, x402 gateway credits (SIWE, $1 top-ups) when the key is out of capacity
src/lib/budget.ts, ledger.ts   spend caps; the PaymentRecord shape and this isolate's recent payments
web/src/pages/index.astro      the page; components in web/src/components, client scripts in web/src/scripts, styles in web/src/styles
src/routes/permalink.ts        /j/<id>, server-rendered with the page's stylesheet inlined
public/                        served as-is: agent.md, favicon.svg
migrations/                    D1 schema
scripts/                       wallet:new, approve, doctor, pay-for-joke
```

Models: the orchestrator is `alibaba/qwen3.8-27b` (best multi-step tool use of the four machine-payment models) and the joke writer is `google/gemma-4-26b-a4b-it` (top of the four on creative-writing benchmarks). Both are thinking models; the joke call turns thinking off via `chat_template_kwargs.enable_thinking=false`, while the orchestrator keeps it on (without it Qwen asked for ticker confirmation instead of calling tools; the price is a slow final turn). Change either model in `wrangler.jsonc` vars.

Cost per joke: 0.002 USDC for data plus about 0.014 USDC settled for inference (mean over the first 21 jokes, range 0.009 to 0.026), against the 0.10 USDC a buyer pays. AI Gateway quotes a *ceiling* per call against the model's full context window (about 0.13 USDC per Qwen turn, 0.026 per Gemma call), so the wallet must hold roughly 0.5 USDC of headroom even though far less is charged.

## Operational notes

- **Wallet headroom.** One joke reserves roughly 0.55 USDC in flight while about 0.015 USDC settles. Keep at least 1 USDC in the wallet or the facilitator refuses with `verify returned 403`.
- **AI Gateway settles per call, on-chain, for the real token cost** (fractions of a cent, never the ceiling), but returns no `PAYMENT-RESPONSE` receipt. `/api/transfers` lists the settlements.
- **Secrets are read lazily on purpose.** Workers validate the module at upload time before any secret exists, so nothing in `src/lib/` touches a secret at import. Keep it that way when adding code, or `wrangler deploy` fails with error 10021.
- **Base RPC rate limits.** Public Base RPCs return 429 to Cloudflare's edge under light load; `/api/wallet` rotates through several and falls back to address-only. Set `BASE_RPC_URL` for the scripts if `mainnet.base.org` throttles you locally.
- **Jokes come from news, not statistics.** Early jokes recited "14 bullish, 2 bearish of 30 posts, 565,947 on the watchlist". Now `write_joke` takes `news` (2 to 4 one-sentence company events), optional `chatter` (a trader quote or two) and `price`; the prompt (`src/lib/joke-prompt.ts`) builds the premise from the news and forbids counts, tallies and percentages. The StockTwits tool returns the mood in words and quotable posts first and parks the counts under `stats`.
- **Ceramic is lexical and has no date filter.** One `"<TICKER> stock news"` query returns evergreen pages ("5 reasons to buy", quote pages, 2023 analyst round-ups); its index also trails the news by weeks. Following [Ceramic's best practices](https://docs.ceramic.ai/api/search/best-practices), step 2 runs three keyword queries (`<Company> <TICKER> stock news`, `<Company> stock <year>`, `<Company> announces OR unveils OR acquires …`), 20 results each, then `src/lib/news.ts` dedupes, drops listicles, recommendations, quote and filing pages, detects a publish date from the URL or snippet, and ranks dated company events first. Recency gate: items older than 18 months go; when any dated item survives, undated items and anything 9 months older than the newest go too (a Nike run had joked about an undated 2023 NFT drop). Ceramic rejects every recency parameter (`freshness`, `recency`, `startPublishedDate` all return `unsupported_parameter`) and its newest item is typically 2 to 12 months old, so the tool reports the newest date and both models are told today's date and that the items are past events, not current news. Short tickers are kept out of two queries because `NET` matches `.NET` and `cloudflare.net`. The under-the-hood panel shows the queries and what was dropped. How far the index trails is measurable from the run rows, since each `search_stock_news` result is archived whole in `runs.steps.ceramic`:

  ```sh
  cf d1 query <db-id> -q --sql "SELECT substr(created_at,1,10) AS day, ticker, json_extract(steps,'$.ceramic.newestDate') AS newest, json_extract(steps,'$.ceramic.dropped.undated') AS undated FROM runs WHERE steps IS NOT NULL ORDER BY created_at DESC LIMIT 20"
  ```
- **Routine notices are not news.** A lexical index is full of pages that look like company news and never make a joke: 13F holdings write-ups ("Graney King LLC grows stock position in Costco"), law-firm class-action solicitations, earnings-date and conference notices, dividend declarations, proxy filings, price "projections". `rankNews` drops them as `notice` (or `listicle`/`index`), so the orchestrator's "first 2 or 3 items" are events. A re-published press release carries the aggregator's date ("Lyft Announces Results for First Quarter 2024", dated 2026-03-16 by its re-publisher); when the period in the title is more than a year older than the detected date, the title wins and the item goes as stale. `write_joke` puts the dates back on the lines the orchestrator hands it (`restoreDates`, matched to the Ceramic items by word overlap), because the orchestrator writes "Dec 2025:" or "undated:" often enough that the joke model had been reading months-old facts as today's. Two probe scripts spend a few thousandths of a USDC to test changes against the real services: `bun scripts/ceramic-probe.ts "Tesla" TSLA [queries…]` prints how fresh each query's results are, `bun scripts/joke-probe.ts [n]` writes n jokes per fixed fact set with the current prompt.
- **Ceramic's index trails the news by about six months, and no query shape changes that.** Measured 2026-10-17 with the probe: six query shapes for Tesla (ticker, year, month names, "this week", current quarter) returned 120 results whose newest full date was 2026-05-03 and whose median was mid-2025; queries for the current quarter returned last year's. There is no recency parameter (see above), so the best the app can do is rank the newest surviving items first, tell both models the age of every item, and keep stale and undated pages away from the joke.
- **The joke model is told the company is public.** StockTwits reports the exchange, `write_joke` passes it as `Listed: SPCX trades on NASDAQ today`, and the prompt treats IPO and "still private" items as resolved history. Without it, SpaceX jokes framed the IPO as pending, because Ceramic only indexes pre-IPO pages.
- **Reply format drift.** The orchestrator sometimes writes `Based:` instead of `Based on:`; the page accepts both. The D1 row uses the facts passed to `write_joke`, not the reply text.
- **`cf workers secrets bulk` did not set secrets** in this session (it reported success, then `secrets list` was empty); see [docs/cf-secrets-bulk-bug.md](./docs/cf-secrets-bulk-bug.md). `wrangler secret bulk` works.
- **The joke is stored as soon as `write_joke` returns.** The orchestrator's closing turn only formats the reply, and it can fail (an AI Gateway `504 / 7009 Upstream service unavailable` after five minutes lost a finished AMD joke). `write_joke` calls `persistJoke()` (src/lib/persist.ts), which inserts the row from the run's D1 records; the finish hook calls it again to add the closing turn's payments and marks the run `done`. `GET /joke/<id>` therefore shows the joke about a minute before the conversation JSON has its final message, and `done` once the run closes.
- **A failed turn is not a failed run.** Flue retries transient provider errors with a backoff (10 attempts, one hour per submission). `GET /joke/<id>` used to report `failed` 45 s after a failed turn; a Nintendo run was declared dead after an AI Gateway 504 and its joke arrived two minutes later, after the caller had stopped polling. Now a failed turn sets `last_error` on the run row, shown as `retrying: true` with `lastError` while `done` stays false; the next successful turn or tool clears it, and only a run row untouched for 20 minutes (or the agent finishing without a joke) is reported `failed`.
- **The run's state lives in D1, not in the Durable Object's memory.** Early versions handed tool outputs and payments to the finish hook through module-level maps and replayed the `events` log to work out a run's status; a Durable Object restart mid-run (a deploy, an eviction) wiped the maps, Flue resumed without re-running finished tools, and jokes were archived with missing steps and payments (a Nintendo row kept 4 of 11). Now the gate inserts a `runs` row, each tool writes its own step state and full output to it (`setStep`), every paid call appends a `run_payments` row before it returns (`paidFetch` in src/lib/env.ts awaits the insert), the provider's turn hook counts model turns, and the finish hook closes the row. A restart changes nothing: `persistJoke()` and `runStatus()` read D1. The one in-memory list left is the ledger in src/lib/ledger.ts, used only for the receipts attached to each reply (Flue's `useResponseStart`/`useResponseFinish` must be synchronous) and `GET /api/ledger`. The orchestrator's own turns are tagged with the conversation through the agent's log scope, set on every render, because the pi-ai provider knows no conversation.
- **Settled amounts are computed once.** `/api/jokes` used to match 30 rows against the wallet's transfer history on every request. `src/lib/settlement.ts` still does the matching (exact receipts by tx hash, AI Gateway settlements by a 3-minute window, the buyer's 0.10 USDC by admission time), but stores the result in `jokes.settled` once the joke is older than three minutes and every receipt it recorded was found on the chain; later reads skip the chain.
- **The company keyword must be clean.** StockTwits titles carry tags (`Nintendo Co. Ltd - ADR`, `Snowflake Inc, Class A`); `companyKeyword` strips share-class tags and chained corporate suffixes, otherwise the three Ceramic queries search for "Nintendo Co. Ltd - ADR" and return 2 usable items out of 60.
- **`503 facilitator verify returned 403` / `403 disallowed visitor country`** were the visitor-identity check described above, not flakiness; the alarm-driven runner plus D1-served status fixes them. `write_joke` still retries once on a 5xx.
- **Run time is the gateway's generation speed.** The three tool steps take seconds; the four paid Qwen turns take anywhere from 4 s to 300 s each, by the hour (median 10 output tokens/s, 2 to 38 across the 10th to 90th percentile), and the closing reply turn is the largest. Measurements, ids and options in [docs/ai-gateway-turn-latency.md](./docs/ai-gateway-turn-latency.md).
- **Only `write_joke` may produce the joke.** The agent is told it cannot write jokes itself and may call a tool at most twice per reply; an earlier version retried a failing joke call seven times.
- **Only one hostname.** Adding the custom domain turned off the `workers.dev` route (requests there get Cloudflare error 1042). Everything, including the password path, goes through `jokes.papper.me`.
- **Admission is recorded in D1**, not in memory: the HTTP gate and the agent's Durable Object are different isolates, so the `runs` row carries `paid_by` across (the older `access` table was folded into `runs` by migration 0006 and is no longer written).
- **Conversation IDs are names, not proof.** Runs the app starts (the page, `POST /joke/<ticker>`) are named `j-<ticker>-<ms base36>-<rand4>` by `src/lib/ids.ts`, so they read well and sort by time. Anyone may POST `/agents/joke/<any id>`, so a prefix says nothing about who paid; paid versus coupon is always the gate's verdict in `runs.paid_by` (copied into `jokes.paid_by`). Hand-run tests use a `test-` prefix by convention. Older rows carry `web-<hex>` (the page used to mint its own) and ad-hoc names from the first day; nothing parses the ID, so they were left alone.
- **Renaming the agent** renames its Durable Object class; `wrangler.jsonc` carries a `renamed_classes` migration (`FlueStockJokeAgent` → `FlueJokeAgent`) so existing conversations survive.

## Caveats

- StockTwits' x402 preview serves only `GET /api/2/symbols/show/{SYM}.json`; the price and sentiment numbers come from the free `streams/symbol` endpoint on the same gateway. The preview is staging, geo-fenced, and has no SLA.
- AI Gateway `/ai/run` does not stream under x402 and returns no `PAYMENT-RESPONSE` receipt; the page shows those rows as ceilings.
- Tool-calling orchestration on an open 27B model is good, not perfect. The agent is instructed to call all three tools in order and to only output jokes that came from step 3.

See [PLAN.md](./PLAN.md) for the design, the research behind it, and what was verified live.
