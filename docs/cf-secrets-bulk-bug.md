# Bug report: `cf workers secrets bulk` reports success but sets no secrets

**Observed:** 2026-10-16, `cf` 1.0.0-beta.17 (macOS, logged in via `cf auth login`, OAuth session with 476 scopes), Worker `x402-stock-jokes` deployed moments earlier with `wrangler deploy`.

## What happened

I uploaded four secrets in one call:

```sh
cf workers secrets bulk --worker x402-stock-jokes --file body.json
```

with `body.json` shaped as a JSON Merge Patch of secret objects, which is how the command's own help describes it ("to create or update a secret, set its value to a secret object"):

```json
{
  "CLOUDFLARE_ACCOUNT_ID": { "type": "secret_text", "text": "…" },
  "CLOUDFLARE_API_TOKEN":  { "type": "secret_text", "text": "…" },
  "EVM_BASE_ADDRESS":      { "type": "secret_text", "text": "…" },
  "EVM_BASE_PRIVATE_KEY":  { "type": "secret_text", "text": "…" }
}
```

The command exited successfully and printed a result that listed **only the Worker's existing plain-text vars** (`JOKE_MODEL`, `MAX_USDC_PER_*`, `ORCHESTRATOR_MODEL`, each `"type": "plain_text"`). None of the four secret names appeared.

Then:

```sh
cf workers secrets list --worker x402-stock-jokes
# []
```

and the Worker still failed at runtime with `Missing secret CLOUDFLARE_ACCOUNT_ID`.

The same four secrets uploaded immediately afterwards with wrangler worked on the first try:

```sh
bunx wrangler secret bulk secrets.json --name x402-stock-jokes
# ✨ 4 secrets successfully created
```

(`secrets.json` there is the flat `{ "NAME": "value" }` shape wrangler documents.)

## What the CLI knows about the request

`cf schema workers secrets bulk` shows the endpoint but **no request body fields**, so the CLI has no schema to validate or shape the body against:

```json
{
  "operationId": "workers.secrets.bulk",
  "httpMethod": "PATCH",
  "path": "/accounts/{account_id}/workers/scripts/{script_name}/secrets-bulk",
  "hasRequestBody": true,
  "requestBodyFields": []
}
```

## Hypotheses

1. The `--file` body is being sent in a different shape than the API expects (for example wrapped, or the API wants `{"NAME": {"type":"secret_text","text":"…"}}` inside another key), so the API treats the patch as empty and returns the unchanged binding list.
2. The API applies the patch to a *new version* that is never promoted to the deployed version, so `secrets list` (and the running Worker) never see it. The help text says the operation "creates a single version with all changes included".
3. `--file` is read but not parsed as JSON for this command (e.g. treated as `.env`), yielding an empty patch.

The response listing only pre-existing bindings fits 1 or 3 best.

## Suggested reproduction (safe, no real secrets)

```sh
# 1. a throwaway Worker
mkdir cf-secrets-repro && cd cf-secrets-repro
cat > wrangler.jsonc <<'JSON'
{ "name": "cf-secrets-repro", "main": "index.js", "compatibility_date": "2026-06-01",
  "vars": { "PLAIN": "hello" } }
JSON
cat > index.js <<'JS'
export default { fetch: (req, env) => new Response(JSON.stringify({ hasSecret: typeof env.MY_SECRET === "string" })) };
JS
npx wrangler deploy

# 2. the bulk call, with a dummy value
echo '{"MY_SECRET":{"type":"secret_text","text":"dummy-123"}}' > body.json
cf workers secrets bulk --worker cf-secrets-repro --file body.json
cf workers secrets bulk --worker cf-secrets-repro --body '{"MY_SECRET":{"type":"secret_text","text":"dummy-123"}}'   # also try --body

# 3. observe
cf workers secrets list --worker cf-secrets-repro          # expected: MY_SECRET; observed on 2026-10-16: []
curl https://cf-secrets-repro.<subdomain>.workers.dev/      # expected: {"hasSecret":true}

# 4. compare with the single-secret command and with wrangler
cf workers secrets update --worker cf-secrets-repro --type secret_text --text dummy-123   # does it need a name flag? help shows none
echo '{"MY_SECRET":"dummy-123"}' > flat.json && npx wrangler secret bulk flat.json --name cf-secrets-repro
cf workers secrets list --worker cf-secrets-repro

# 5. inspect what the CLI actually sends
cf workers secrets bulk --worker cf-secrets-repro --file body.json --dry-run
```

Things worth capturing in the other session: the raw HTTP request body the CLI sends (dry-run or a proxy), the raw API response, whether a new Worker *version* appeared in the dashboard with the secret attached, and whether `--body` behaves differently from `--file`.

## Workaround

`wrangler secret bulk <flat.json> --name <worker>` or `wrangler secret put NAME` (reads the value from stdin).
