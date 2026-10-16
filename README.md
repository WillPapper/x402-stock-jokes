# x402-stock-jokes

Generate jokes about any stock news with x402 stablecoin payments.

See [PLAN.md](./PLAN.md) for the full design: a [Flue](https://flueframework.com) agent on Cloudflare Workers that pays per request with USDC on Base via x402 (StockTwits, Ceramic search, and AI Gateway machine payments).

## Setup

```sh
npm install
```

Then add a model provider API key to `.env` (any [provider Pi supports](https://pi.dev/docs/latest/providers#api-keys)).

## Talk to your agent

```sh
npx flue run src/agents/joker.ts --message "Tell me a joke about NVDA."
```

Conversations are durable — pass `--id <id>` to continue one.

## Develop

```sh
npm run dev
```

The StockJoke agent is served at `http://localhost:5173/agents/joker` — see `src/app.ts` for the route map and an example request.

## Deploy

```sh
npm run deploy
```

## Learn more

- [Flue docs](https://flueframework.com/docs/) — or `npx flue docs` from the terminal.
