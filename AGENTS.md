# AGENTS.md

This is a [Flue](https://flueframework.com) project: agents are TypeScript functions.

## Layout

- `src/agents/` — agent modules. A module whose first line is the `'use agent'` directive exports agents: every exported capitalized function is one, and the function name is its durable identity.
- `src/app.ts` — the route map; every route is mounted here explicitly.
- `src/cloudflare.ts` — Worker-level exports and non-HTTP handlers.
- `wrangler.jsonc` — Worker config; every agent needs a Durable Object migration entry.

## Commands

- `npx flue run src/agents/joker.ts --message "Tell me a joke about NVDA."` — run an agent locally, no server.
- `npm run dev` — start the dev server.
- `npm run deploy` — build and deploy the Worker.
- `npm run check:types` — typecheck.
- `npx flue docs search <query>` — search the Flue docs from the terminal (then `flue docs read <path>`).
- `npx flue add` — list blueprints for adding channels, sandboxes, and databases.

## Cloudflare CLI

Use the `cf` CLI (`npm i -g cf`, or `npx cf`) instead of `wrangler` whenever possible — e.g. `cf deploy`, `cf dev`, `cf build`. Fall back to `wrangler` only when `cf` has no equivalent command.

- `cf cli search "<task>"` — discover commands instead of chaining `--help` calls; then run `<command> --help` for details.
- `cf docs search "<question>"` — search the Cloudflare docs.
- Keep search queries anonymous: describe the action and resource type only — no account IDs, domains, names, or tokens.
