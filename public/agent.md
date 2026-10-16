# How to get a stock joke from jokes.papper.me by paying with x402

You are an agent with an EVM wallet. This service writes one joke about a stock
ticker. Each joke costs **0.10 USDC on Base mainnet**, paid per request with the
x402 protocol (HTTP 402). There is no account, API key or sign-up: the payment
attached to the request is the credential.

## What you need

- An EVM wallet whose private key you can sign with (not an exchange account).
- At least 0.10 USDC on **Base mainnet** (`eip155:8453`) in that wallet. No ETH is
  needed: you sign an authorization, the seller's facilitator pays the gas.
- An x402 client library, or the ability to sign EIP-712 typed data yourself.

## The request

```
POST https://jokes.papper.me/agents/joke/<id>
content-type: application/json

{"kind":"user","body":"Tell me a joke about <TICKER>."}
```

`<id>` is any string you choose (letters, digits, dashes); it names the
conversation. Use a fresh one per joke, e.g. `my-agent-20261016-nvda`.

## The payment flow (handled automatically by an x402 client)

1. Send the POST without payment. The response is `402 Payment Required` with a
   `PAYMENT-REQUIRED` header: base64 JSON with `accepts[0]` =
   `{ scheme: "exact", network: "eip155:8453", amount: "100000", asset: <USDC>, payTo: <wallet>, maxTimeoutSeconds }`.
   `amount` is in USDC base units (6 decimals): `100000` = 0.10 USDC.
2. Sign a USDC `transferWithAuthorization` (EIP-3009, EIP-712 typed data) for
   exactly `amount` to `payTo`, valid for `maxTimeoutSeconds`, with a random nonce.
3. Repeat the same POST with the signed payload, base64-encoded, in a
   `PAYMENT-SIGNATURE` header. The gateway verifies it, forwards the request, and
   settles the transfer on Base. The response is `202 Accepted` with a
   `PAYMENT-RESPONSE` header (base64 JSON with the transaction hash).
4. Always use the values from `PAYMENT-REQUIRED`; never hardcode price or address.

## Reading the joke

The POST is accepted immediately; the joke takes 30 to 90 seconds. Poll the same
URL with GET (free, no payment) every few seconds:

```
GET https://jokes.papper.me/agents/joke/<id>
```

The JSON has `messages[]`, each with `parts[]`. Tool calls appear as parts of type
`dynamic-tool` (`fetch_stocktwits_signals`, `search_stock_news`, `write_joke`).
When `settlements[0].outcome` is `"completed"`, the last part of type `text` in
the last message with `role: "assistant"` is the reply: the joke on the first
line, then `Based on: …` and `Paid: …` lines with the data sources and receipts.
The assistant message's `metadata.payments` lists every x402 payment the agent
itself made to StockTwits, Ceramic and Cloudflare AI Gateway while working.

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

const id = `agent-${Date.now()}`;
const url = `https://jokes.papper.me/agents/joke/${id}`;
const res = await fetchWithPayment(url, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ kind: "user", body: "Tell me a joke about NVDA." }),
});
if (!res.ok) throw new Error(`submit failed: ${res.status} ${await res.text()}`);

for (;;) {
  await new Promise((r) => setTimeout(r, 5000));
  const snap = await (await fetch(url)).json();
  if (snap.settlements?.length) {
    const reply = snap.messages.filter((m) => m.role === "assistant").flatMap((m) => m.parts.filter((p) => p.type === "text").map((p) => p.text)).at(-1);
    console.log(reply);
    break;
  }
}
```

## Free alternatives

- `GET https://jokes.papper.me/api/jokes/latest?ticker=NVDA` returns the most
  recent joke already made for a ticker, with its facts and receipts. No payment.
- `GET https://jokes.papper.me/api/jokes?limit=20` is the public feed.
- `GET https://jokes.papper.me/api/stats` has counts and USDC totals.

## Errors

- `402` again after you paid: the payment was rejected. Decode `PAYMENT-REQUIRED`
  and read its `error` (insufficient USDC, expired or reused authorization, wrong
  amount/recipient/network). Nothing was charged.
- `401`: you sent an `x-joke-password` header with the wrong value. Drop the
  header to pay instead.
- `403`: the gateway does not accept payments from your country, or the method
  is not allowed.

Source and docs: https://github.com/WillPapper/x402-stock-jokes
