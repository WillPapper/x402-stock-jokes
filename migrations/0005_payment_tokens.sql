-- Every PAYMENT-CONTEXT token the gate has admitted, by SHA-256 of the token,
-- so a token that paid for one joke cannot be presented a second time.
CREATE TABLE IF NOT EXISTS payment_tokens (
  token_hash TEXT PRIMARY KEY,
  aud TEXT,
  conversation_id TEXT,
  created_at TEXT NOT NULL
);
