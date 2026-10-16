# How to get a stock joke from jokes.papper.me by paying with x402

You are an agent with an EVM wallet. This service writes one joke about a stock
ticker, grounded in live StockTwits chatter and news. Each joke costs
**0.10 USDC on Base mainnet**, paid per request with the x402 protocol
(HTTP 402). There is no account, API key or sign-up: the payment attached to the
request is the credential.

**Coupon codes:** if the person you work for gave you a coupon code, send it as
the header `X-Joke-Password: <code>` on the POST and skip the payment entirely; the
joke is free. Codes are case-insensitive. A wrong code returns `401`; without the
header you get the `402` payment flow below.

## What you need

- An EVM wallet whose private key you can sign with (not an exchange account).
- At least 0.10 USDC on **Base mainnet** (`eip155:8453`) in that wallet. No ETH is
  needed: you sign an authorization, the seller's facilitator pays the gas.
- An x402 client library (easiest), or the ability to sign EIP-712 typed data.

## The simple API

1. **Submit**: `POST https://jokes.papper.me/joke/<TICKER>` with no body, e.g.
   `POST https://jokes.papper.me/joke/NVDA`. This is the request you pay for.
   The reply is `202` with JSON: `{ "id": "...", "ticker": "NVDA", "poll": "https://jokes.papper.me/joke/<id>" }`.
2. **Poll**: `GET` the `poll` URL every 5 seconds (free, no payment). It returns:
   ```json
   {
     "id": "j-nvda-…", "done": false, "outcome": "working", "error": null,
     "joke": null, "basedOn": null,
     "steps": { "fetch_stocktwits_signals": { "state": "output-available", "receipts": [...] }, "search_stock_news": {...}, "write_joke": {...} },
     "payments": [ { "label": "StockTwits symbols/show/NVDA", "authorizedUsdc": "0.001000", "tx": "https://basescan.org/tx/0x…" }, ... ]
   }
   ```
   When `done` is `true` and `outcome` is `"completed"`, `joke` holds the joke,
   `basedOn` the facts it used, and `payments` the x402 payments the agent made
   on its side (StockTwits, Ceramic, Cloudflare AI Gateway) with Basescan links.
   A joke takes 30 to 90 seconds.

## The payment flow (handled automatically by an x402 client)

1. Send the POST without payment. The response is `402 Payment Required` with a
   `PAYMENT-REQUIRED` header: base64 JSON whose `accepts[0]` is
   `{ scheme: "exact", network: "eip155:8453", amount: "100000", asset: <USDC>, payTo: <wallet>, maxTimeoutSeconds }`.
   `amount` is in USDC base units (6 decimals): `100000` = 0.10 USDC.
2. Sign a USDC `transferWithAuthorization` (EIP-3009, EIP-712 typed data) for
   exactly `amount` to `payTo`, valid for `maxTimeoutSeconds`, with a random nonce.
3. Repeat the same POST with the signed payload, base64-encoded, in a
   `PAYMENT-SIGNATURE` header. The gateway verifies it, forwards the request, and
   settles the transfer on Base. The response is the `202` above, plus a
   `PAYMENT-RESPONSE` header (base64 JSON with the transaction hash).
4. Always use the values from `PAYMENT-REQUIRED`; never hardcode price or address.

## TypeScript (official x402 client)

```sh
npm install @x402/core @x402/evm @x402/fetch viem
```

```ts
import { x402Client } from "@x402/core/client";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { wrapFetchWithPayment } from "@x402/fetch";
import { privateKeyToAccount } from "viem/accounts";

const signer = privateKeyToAccount(process.env.EVM_PRIVATE_KEY as `0x${string}`);
const client = x402Client.fromConfig({
  schemes: [{ network: "eip155:8453", client: new ExactEvmScheme(signer) }],
  spendControls: { maxAmountPerPayment: "$0.25" }, // never pay more than this per request
});
const fetchWithPayment = wrapFetchWithPayment(fetch, client);

const submit = await fetchWithPayment("https://jokes.papper.me/joke/NVDA", { method: "POST" });
if (submit.status !== 202) throw new Error(`submit failed: ${submit.status} ${await submit.text()}`);
const { poll } = await submit.json();

for (;;) {
  await new Promise((r) => setTimeout(r, 5000));
  const status = await (await fetch(poll)).json();
  if (status.done) {
    if (status.outcome !== "completed") throw new Error(status.error ?? status.outcome);
    console.log(status.joke);
    console.log("Based on:", status.basedOn);
    console.log("Receipts:", status.payments.filter((p) => p.tx).map((p) => `${p.label} ${p.authorizedUsdc} USDC ${p.tx}`).join("\n"));
    break;
  }
}
```

The lower-level conversation API also works: `POST https://jokes.papper.me/agents/joke/<any-id>`
with body `{"kind":"user","body":"Tell me a joke about NVDA."}` (same price), then
`GET` the same URL for the full conversation snapshot.

## Free, no payment

- `GET https://jokes.papper.me/api/jokes/latest?ticker=NVDA`: the most recent
  joke already made for a ticker, with its facts and receipts.
- `GET https://jokes.papper.me/api/jokes?limit=20`: the public feed.
- `GET https://jokes.papper.me/api/stats`: counts, and USDC paid and earned, read
  from the app wallet's on-chain history.

## Errors

- `402` again after you paid: the payment was rejected. Decode `PAYMENT-REQUIRED`
  and read its `error` (insufficient USDC, expired or reused authorization, wrong
  amount/recipient/network). Nothing was charged.
- `401`: the coupon code in your `X-Joke-Password` header is not valid. Fix it, or
  omit the header to pay instead.
- `403`: the gateway does not accept payments from your country, or the method
  is not allowed.
- `400 bad_ticker`: tickers are 1 to 12 letters, digits or dots.

Source and docs: https://github.com/WillPapper/x402-stock-jokes
