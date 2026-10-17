# AI Gateway orchestrator turns: where the time goes

Written 2026-10-17 after two runs (TSLA, ORCL) took 4 and 5 minutes where a run an hour earlier (LYFT) took 86 seconds. Everything below comes from the `ai.turn` and `x402.payment` events in D1 (`GET /api/events?kind=ai.turn`), which record the duration of every paid model call as seen from the Worker, the gateway's own ids, and the token counts the gateway returned.

## Short version

A joke run is three tool steps and four paid orchestrator turns (`alibaba/qwen3.8-27b` through AI Gateway `/ai/run`, x402 `upto`). The tool steps take 1 to 4 seconds each and the queue hand-off under a second, in every run. All of the variance is in the model turns, and the variance is in the gateway's generation speed, not in what we send:

- 144 completed turns since 2026-10-16 18:00 UTC: median **9.9 output tokens per second**, 10th percentile **2.1**, 90th percentile **37.8**. The same prompt shape runs 18× faster in a good minute than in a bad one.
- The closing turn (the reply that formats the stored joke, about 500 to 900 output tokens on a 3,500 to 4,000 token prompt) took 22 s on LYFT, 151 s on TSLA and 204 s on ORCL. Its size did not change.
- 7 of 158 turns hit the gateway's 300 s limit and came back `7009 Upstream service unavailable` with no usage; Flue retried them and the runs finished.
- Prompt size and output size each correlate only moderately with duration (r = 0.52): a 1,000-token prompt has taken 88 s and a 4,000-token one 11 s.

Nothing in the app changed between the fast and slow runs on 2026-10-17: the provider code, the request body and the model are the same, and the D1 writes added by the run-state refactor sit inside the tool steps, whose timings are unchanged.

## The three runs that prompted this

Per-turn durations are the gateway's response time for the paid `/ai/run` call (`durationMs` on the `ai.turn` event, which equals `totalMs` on the matching `x402.payment` event).

| Turn | LYFT 06:00 UTC | TSLA 07:12 UTC | ORCL 07:14 UTC |
|---|---|---|---|
| 1: call `fetch_stocktwits_signals` | 4.1 s (99 tokens out) | 21.4 s (120) | 4.6 s (127) |
| 2: call `search_stock_news` | 6.6 s (98) | 32.1 s (165) | 17.6 s (71) |
| 3: call `write_joke` | 43.0 s (1,181) | 24.7 s (977) | 77.0 s (837) |
| 4: closing reply | 22.5 s (690) | 150.5 s (520) | 203.6 s (571) |
| StockTwits step | 1.5 s | 3.4 s | 2.5 s |
| Ceramic step (3 searches) | 4.1 s | 3.8 s | 4.4 s |
| Joke call (Gemma) | 1.8 s | 2.4 s | 1.4 s |
| Runner queue to agent start | 0.75 s | 0.68 s | 0.60 s |
| Whole run | 86 s | 241 s | 314 s |

The 21 s "before the first step" on TSLA is turn 1 at the gateway, not the queue.

Gateway ids for the two slow closing turns, for a support ticket:

| Run | cf-ray | cf-aig-request-id | prompt / output tokens | duration |
|---|---|---|---|---|
| j-tsla-mvc26w4u-nbll | `a4bd80b2b8c90001-ORD` | `01a148b5-aceb-7559-bea7-478cb0c783c3` | 3,968 / 520 | 150.6 s |
| j-orcl-mvc2a8fh-epoz | `a4bd84f9d8eaf856-ORD` | `01a148b8-5913-760b-b805-d47fa31af687` | 3,876 / 571 | 203.6 s |

And a fast one for comparison, same prompt shape: LYFT's closing turn, 4,000 / 690 tokens in 22.5 s.

## It comes and goes by the hour

Completed turns grouped by hour (UTC, 2026-10-16 19:00 to 2026-10-17 07:30). "tok/s" is output tokens divided by duration; "timeouts" are turns that hit 300 s with no usage.

| Hour | Turns | Median s | p90 s | Median tok/s | Min tok/s | Max tok/s | Timeouts |
|---|---|---|---|---|---|---|---|
| 19:00 | 4 | 23 | 29 | 15.1 | 4.4 | 28.5 | 0 |
| 20:00 | 53 | 29 | 80 | 9.0 | 0.6 | 41.9 | 1 |
| 21:00 | 4 | 18 | 18 | 27.2 | 3.0 | 46.6 | 0 |
| 23:00 | 3 | 10 | 10 | 40.3 | 20.6 | 44.0 | 0 |
| 00:00 | 22 | 55 | 185 | 4.2 | 1.1 | 30.9 | 5 |
| 04:00 | 26 | 12 | 31 | 25.9 | 4.2 | 50.6 | 0 |
| 05:00 | 33 | 29 | 97 | 8.1 | 1.3 | 45.7 | 1 |
| 06:00 | 4 | 15 | 22 | 25.7 | 14.8 | 30.7 | 0 |
| 07:00 | 8 | 28 | 151 | 5.4 | 2.8 | 39.5 | 0 |

The slow windows (00:00 to 01:00 and 05:00 to 05:30, then 07:10 onwards) have both the lowest throughput and the timeouts. Between them the same model answers at 25 to 50 tokens per second. The `7009 Upstream service unavailable` errors all carry the gateway's 300 s duration, so they are the gateway giving up on the backend, not on us.

## What it costs

Every slow turn is still one `upto` authorization of up to 0.131072 USDC, settled at the real token cost (0.001 to 0.003 USDC per turn on the chain, see `/api/stats`). Slowness does not cost more money; a timeout costs a retry, which is another authorization and another settled turn.

## Options

1. **Live with it.** The joke is written and stored at step 3, and `GET /joke/<id>` shows it then. Only `done` and the conversation JSON wait for the closing turn. The page already shows the joke as soon as the row exists.
2. **Stop paying for the closing turn.** The reply is a formatted copy of what `write_joke` stored (the joke, the facts, the payments). The agent could end after `write_joke` returns and the finish hook could write the reply text itself. That removes the slowest and largest turn (a quarter of the authorizations and about a third of the settled inference cost) and makes a run three turns. It changes what the conversation JSON contains and needs a product decision.
3. **Try another orchestrator.** `openai/gpt-oss-20b` with `reasoning_effort: low` was faster per turn in the 2026-10-16 trials but routed tools less reliably (it asked for confirmation instead of calling them). Worth re-measuring if Qwen's slow windows persist; swap `ORCHESTRATOR_MODEL` in `wrangler.jsonc`.
4. **Report it.** The table above has the cf-ray and cf-aig ids; the `x402.payment` event for each turn has the quote `jti`, the payer and every attempt.

## How to re-measure

```sh
# per-turn durations and throughput for the last day
cf d1 query 79517cc1-da36-41eb-a82b-da3b9116a939 -q --sql "SELECT substr(ts,1,13) AS hour, COUNT(*) AS turns, ROUND(AVG(json_extract(data,'\$.durationMs'))/1000) AS avg_s, MAX(json_extract(data,'\$.durationMs'))/1000 AS max_s, ROUND(AVG(json_extract(data,'\$.usage.completion_tokens') * 1000.0 / json_extract(data,'\$.durationMs')),1) AS tok_s FROM events WHERE kind='ai.turn' AND ok=1 AND ts > datetime('now','-1 day') GROUP BY hour ORDER BY hour"
```

Or through Access: `GET /api/events?kind=ai.turn&limit=200` and read `durationMs`, `usage.completion_tokens` and `ids`.
