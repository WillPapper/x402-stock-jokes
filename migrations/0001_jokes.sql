-- Every completed joke, with the facts it used and the x402 payments that produced it.
CREATE TABLE IF NOT EXISTS jokes (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  ticker TEXT NOT NULL,
  title TEXT,
  joke TEXT NOT NULL,
  facts TEXT NOT NULL,              -- JSON array of strings
  payments TEXT NOT NULL,           -- JSON array of PaymentRecord
  total_authorized_usdc TEXT NOT NULL,
  orchestrator_model TEXT,
  joke_model TEXT,
  paid_by TEXT,                     -- 'password' | 'x402' | NULL
  created_at TEXT NOT NULL          -- ISO 8601
);
CREATE INDEX IF NOT EXISTS idx_jokes_created ON jokes (created_at);
CREATE INDEX IF NOT EXISTS idx_jokes_ticker ON jokes (ticker, created_at);
