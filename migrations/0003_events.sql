-- Structured log of every gateway interaction (payments, admissions, model
-- turns), kept so bugs can be reported to Cloudflare with full identifiers.
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  kind TEXT NOT NULL,               -- 'x402.payment' | 'gate' | 'ai.turn' | 'error'
  conversation_id TEXT,
  label TEXT,
  ok INTEGER NOT NULL,              -- 1 success, 0 failure
  data TEXT NOT NULL                -- JSON
);
CREATE INDEX IF NOT EXISTS idx_events_ts ON events (ts);
CREATE INDEX IF NOT EXISTS idx_events_conv ON events (conversation_id);
