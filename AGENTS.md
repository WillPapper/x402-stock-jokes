# AGENTS.md

This is a [Flue](https://flueframework.com) project: agents are TypeScript functions.

## Layout

- `src/agents/` — agent modules. A module whose first line is the `'use agent'` directive exports agents: every exported capitalized function is one, and the function name is its durable identity.
- `src/app.ts` — the route map; it mounts `src/routes/agent.ts` (the gate, `/joke/<TICKER>`, `/joke/<id>`, `/agents/joke/*`), `src/routes/public.ts`, `src/routes/permalink.ts` and `src/routes/internal.ts`.
- `src/cloudflare.ts` — Worker-level exports and non-HTTP handlers: the `JokeRunner` Durable Object and the x402 AI Gateway provider registration.
- `wrangler.jsonc` — Worker config; every agent needs a Durable Object migration entry.
- `src/lib/` — x402 client, budget, ledger, and the pi-ai provider that pays AI Gateway for the agent's own turns.
- `src/tools/` — the three paid steps (StockTwits, Ceramic, AI Gateway joke).
- `src/lib/access.ts` — who may POST a joke: password header, or a Monetization Gateway `PAYMENT-CONTEXT` JWT; `src/lib/runs.ts` — the D1 `runs` and `run_payments` tables every run writes to (state, steps, payments) and `runStatus()`; `src/lib/db.ts` — D1 `jokes` feed/cache; `src/lib/persist.ts` — the joke row from the run.
- `web/` — the page, an Astro site: `web/src/pages/index.astro` composes the components in `web/src/components/`, the client logic is TypeScript in `web/src/scripts/` (components talk through the typed events in `bus.ts`), shared styles are `web/src/styles/global.css` (the permalink page inlines it too). `astro build` writes to `dist/client`, which the Worker serves as assets; `public/` holds the files served as-is (`agent.md`, `favicon.svg`).
- Run state is D1-only. Tools record their step with `setStep`, payments are stored by `paidFetch` (pass the conversation id), nothing is handed between tools and hooks in memory. Status is `statusOf()` in `src/lib/status.ts` (pure, tested).
- The agent is `Joke` (`src/agents/joke.ts`, Durable Object class `FlueJokeAgent`, mounted at `/agents/joke`).
- Every tool call and model turn spends real USDC; keep caps in `wrangler.jsonc` vars small and run `bun run doctor` first.

## Commands

- `bun run dev` — start the Worker (`vite dev`, :5173) and the page (`astro dev`, :4321, proxying the API to the Worker) together; needs `.dev.vars`, see README. `bun run dev:web` alone with `API_ORIGIN=https://jokes.papper.me` works on the page against production data.
- `bun run deploy` — build the Worker and the page, then deploy.
- `bun run check:types` — typecheck the Worker and the page's scripts (the `<script>` blocks inside `.astro` files are not type-checked: `astro check` does not support TypeScript 7 yet); `bun test` — unit tests; `bun run check` — both, failing on either.
- `bun run doctor` — check wallet, allowance and the live 402 quotes before spending.
- `bun run db:migrate` / `bun run db:migrate:local` — apply D1 migrations (migrations/).
- `bunx flue docs search <query>` — search the Flue docs from the terminal (then `bunx flue docs read <path>`).
- `bunx flue add` — list blueprints for adding channels, sandboxes, and databases.

## Cloudflare CLI

Use the `cf` CLI (`npm i -g cf`, or `npx cf`) instead of `wrangler` whenever possible — e.g. `cf deploy`, `cf dev`, `cf build`. Fall back to `wrangler` only when `cf` has no equivalent command.

- `cf cli search "<task>"` — discover commands instead of chaining `--help` calls; then run `<command> --help` for details.
- `cf docs search "<question>"` — search the Cloudflare docs.
- Keep search queries anonymous: describe the action and resource type only — no account IDs, domains, names, or tokens.
