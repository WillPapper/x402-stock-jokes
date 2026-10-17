# Web search freshness: Ceramic vs Exa over x402 (measured 2026-10-17)

Question: Ceramic's results for the joke run are months old. Is that the x402 route, or the index, and is any other x402-payable search fresher?

## Ceramic (api.ceramic.ai/search, x402 exact 0.001 USDC per query)

Same service behind the Monetization Gateway as behind an API key (their x402 page: the gateway "forwards the request to Ceramic"). The endpoint takes `query`, `maxResults` (max 20) and `maxDescriptionLength`; `freshness`, `recency`, `startPublishedDate` and `dateRestrict` return 422 `unsupported_parameter`.

Probe (`bun scripts/ceramic-probe.ts "Tesla" TSLA …`), six query shapes, 120 results:

| query | fully dated | newest | median |
|---|---|---|---|
| Tesla TSLA stock news | 4 | 2026-02-02 | 2025-08 |
| Tesla stock 2026 | 9 | 2026-04-06 | 2025-06 |
| Tesla October 2026 | 9 | 2026-04-09 | 2025-01 |
| Tesla "October 2026" OR "September 2026" | 12 | 2026-05-03 | 2025-11 |
| Tesla news this week | 5 | 2024-04-04 | 2022-06 |
| Tesla Q3 2026 earnings OR deliveries | 5 | 2025-10-22 (Q3 2025 coverage) | 2025-10 |

The index trails the news by about six months whatever the query. Price: 0.001 USDC per query over x402 is 4x the pay-as-you-go list price ($0.25 per 1K) and 5x Pro ($0.20 per 1K).

## Exa (api.exa.ai/search, x402 exact, 0.007 USDC per `fast` query)

One paid probe, `{ query: 'Tesla stock news', type: 'fast', numResults: 10, category: 'news', startPublishedDate: <30 days ago> }`: ten results, all published 2026-10-15 or 2026-10-16 (Reuters via Investing.com, Forbes, CNBC, Motley Fool, Yahoo Finance), each with a `publishedDate`. The date filter and news category work over x402; `numResults` is clamped to 10. Quote accepted on Base, Solana, World Chain and Arc. Same list price as the API-key path ($0.007 per fast search); the response reports `costDollars`.

## Parallel (parallelmpp.dev/api/search, Parallel's own x402/MPP gateway, 0.01 USDC per search)

One paid probe, `fast` mode, two keyword queries plus an objective, `advanced_settings.source_policy.after_date` set to 30 days ago, `max_results: 10`: ten results. Four were dated October 2026 news (CNBC Q3 deliveries 2026-10-02, Bloomberg 2026-10-12, two Investing.com "Tesla News Today" pages 2026-10-14/15), one was Tesla's own Q3 2026 deliveries release (undated), and five were undated quote or index pages (Markets Insider, Morningstar, Benzinga, Tracxn). The `after_date` filter did not keep undated pages out, and `publish_date` is only present on about half the results. Fresh, but noisier than Exa for this job and 10x Ceramic's price per query; `advanced` mode (about 3 s) was not tried.

## Others

- Brave, Tavily, Firecrawl, Linkup: no x402 endpoint found.
- Cloudflare AI Gateway's "web search" is a tool inside model calls (Anthropic, OpenAI, xAI, Qwen, Perplexity, Parallel), billed through Unified Billing; Machine Payments covers `/ai/run` only, so it is not a drop-in for step 2.

## Implication for the demo

Per joke today: three Ceramic queries, 0.003 USDC, newest item months old, heavy local filtering. One Exa `fast` query with `category: 'news'` and a 30-day `startPublishedDate` would cost 0.007 USDC and return dated, current news with no ranking work. Parallel at 0.01 USDC is as fresh but returns quote pages alongside the news, so the ranking code would still be needed. Not changed: the app stays on Ceramic by decision; this note records the measurement.
