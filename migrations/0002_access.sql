-- How each conversation was admitted (password or x402), recorded by the HTTP
-- gate so the agent's Durable Object can stamp the joke row.
CREATE TABLE IF NOT EXISTS access (
  conversation_id TEXT PRIMARY KEY,
  paid_by TEXT NOT NULL,            -- 'password' | 'x402'
  amount_usdc TEXT,                 -- from the PAYMENT-CONTEXT token, when paid
  created_at TEXT NOT NULL
);
