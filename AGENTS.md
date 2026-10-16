# AGENTS.md

This is a [Flue](https://flueframework.com) project: agents are TypeScript functions.

## Layout

- `src/agents/` — agent modules. A module whose first line is the `'use agent'` directive exports agents: every exported capitalized function is one, and the function name is its durable identity.
- `src/app.ts` — the route map; every route is mounted here explicitly.
- `src/cloudflare.ts` — Worker-level exports and non-HTTP handlers.
- `wrangler.jsonc` — Worker config; every agent needs a Durable Object migration entry.
- `src/lib/` — x402 client, budget, ledger, and the pi-ai provider that pays AI Gateway for the agent's own turns.
- `src/tools/` — the three paid steps (StockTwits, Ceramic, AI Gateway joke).
- `src/lib/access.ts` — who may POST a joke: password header, or a Monetization Gateway `PAYMENT-CONTEXT` JWT; `src/lib/db.ts` — D1 feed/cache; `public/index.html` — the page.
- The agent is `Joke` (`src/agents/joke.ts`, Durable Object class `FlueJokeAgent`, mounted at `/agents/joke`).
- Every tool call and model turn spends real USDC; keep caps in `wrangler.jsonc` vars small and run `bun run doctor` first.

## Commands

- `bun run dev` — start the dev server (needs `.dev.vars`, see README).
- `bun run deploy` — build and deploy the Worker.
- `bun run check:types` — typecheck; `bun test` — unit tests.
- `bun run doctor` — check wallet, allowance and the live 402 quotes before spending.
- `bun run db:migrate` / `bun run db:migrate:local` — apply D1 migrations (migrations/).
- `bunx flue docs search <query>` — search the Flue docs from the terminal (then `bunx flue docs read <path>`).
- `bunx flue add` — list blueprints for adding channels, sandboxes, and databases.

## Cloudflare CLI

Use the `cf` CLI (`npm i -g cf`, or `npx cf`) instead of `wrangler` whenever possible — e.g. `cf deploy`, `cf dev`, `cf build`. Fall back to `wrangler` only when `cf` has no equivalent command.

- `cf cli search "<task>"` — discover commands instead of chaining `--help` calls; then run `<command> --help` for details.
- `cf docs search "<question>"` — search the Cloudflare docs.
- Keep search queries anonymous: describe the action and resource type only — no account IDs, domains, names, or tokens.
