-- One row per run (conversation), written at each transition: the gate inserts
-- it, the agent marks it running, each tool records its own step, the finish
-- hook closes it. GET /joke/<id> reads this row instead of replaying the events
-- log. Replaces the `access` table, which is kept but no longer written.
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,                     -- conversation id
  ticker TEXT,
  state TEXT NOT NULL,                     -- 'queued' | 'running' | 'done' | 'failed'
  paid_by TEXT,                            -- 'password' | 'x402' | NULL
  amount_usdc TEXT,                        -- the buyer's payment from PAYMENT-CONTEXT, when paid
  step_states TEXT NOT NULL DEFAULT '{}',  -- JSON { <tool name>: { state: 'running'|'done'|'error', error? } }
  steps TEXT,                              -- JSON { stocktwits, ceramic, joke }: the full tool outputs
  turns INTEGER NOT NULL DEFAULT 0,        -- paid model turns that succeeded
  last_error TEXT,                         -- latest failed turn or tool; cleared when something succeeds
  failed_step TEXT,                        -- tool name of the step that failed, if one did
  error TEXT,                              -- why the run failed, once state = 'failed'
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_runs_state ON runs (state, updated_at);
CREATE INDEX IF NOT EXISTS idx_runs_paid ON runs (paid_by, created_at);

-- Every x402 payment a run made, one row each, written as the payment completes.
CREATE TABLE IF NOT EXISTS run_payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id TEXT NOT NULL,
  at TEXT NOT NULL,
  label TEXT NOT NULL,
  url TEXT NOT NULL,                       -- seller URL, account id already stripped
  scheme TEXT NOT NULL,                    -- 'exact' | 'upto' | 'unknown'
  authorized_usdc TEXT NOT NULL,
  settled INTEGER NOT NULL,
  ok INTEGER NOT NULL DEFAULT 1,           -- 0 when the paid call itself failed
  tx TEXT,
  ray TEXT
);
CREATE INDEX IF NOT EXISTS idx_run_payments_run ON run_payments (run_id, at);

-- Per-joke settled amounts, computed once from the chain and stored (see src/lib/settlement.ts).
ALTER TABLE jokes ADD COLUMN settled TEXT;  -- JSON { paid, buyer }, NULL until computed

-- Convert history. Every finished joke is a done run carrying its step archive;
-- every admitted conversation that never produced a joke is a failed run.
INSERT OR IGNORE INTO runs (id, ticker, state, paid_by, amount_usdc, step_states, steps, created_at, updated_at, finished_at)
  SELECT j.conversation_id, j.ticker, 'done', COALESCE(j.paid_by, a.paid_by), a.amount_usdc,
         '{"fetch_stocktwits_signals":{"state":"done"},"search_stock_news":{"state":"done"},"write_joke":{"state":"done"}}',
         j.steps, COALESCE(a.created_at, j.created_at), j.created_at, j.created_at
  FROM jokes j
  LEFT JOIN access a ON a.conversation_id = j.conversation_id
  WHERE j.id = (SELECT id FROM jokes WHERE conversation_id = j.conversation_id ORDER BY created_at DESC LIMIT 1);
INSERT OR IGNORE INTO runs (id, state, paid_by, amount_usdc, error, created_at, updated_at, finished_at)
  SELECT a.conversation_id, 'failed', a.paid_by, a.amount_usdc, 'the run finished without a joke (before run tracking)', a.created_at, a.created_at, a.created_at
  FROM access a
  WHERE a.conversation_id NOT IN (SELECT conversation_id FROM jokes);
-- Each stored joke's payments array becomes one run_payments row per payment.
INSERT INTO run_payments (run_id, at, label, url, scheme, authorized_usdc, settled, ok, tx, ray)
  SELECT j.conversation_id,
         COALESCE(json_extract(p.value, '$.at'), j.created_at),
         COALESCE(json_extract(p.value, '$.label'), ''),
         COALESCE(json_extract(p.value, '$.url'), ''),
         COALESCE(json_extract(p.value, '$.scheme'), 'unknown'),
         COALESCE(json_extract(p.value, '$.authorizedUsdc'), '0'),
         CASE WHEN json_extract(p.value, '$.settled') THEN 1 ELSE 0 END,
         1,
         json_extract(p.value, '$.tx'),
         json_extract(p.value, '$.ray')
  FROM jokes j, json_each(j.payments) p
  WHERE j.id = (SELECT id FROM jokes WHERE conversation_id = j.conversation_id ORDER BY created_at DESC LIMIT 1);
-- Model turns for converted runs: one per successful orchestrator payment.
UPDATE runs SET turns = (SELECT COUNT(*) FROM run_payments p WHERE p.run_id = runs.id AND p.ok = 1 AND p.label LIKE '%orchestrator%');
