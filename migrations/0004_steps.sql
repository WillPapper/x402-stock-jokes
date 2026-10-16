-- Full response from each service (StockTwits, Ceramic, AI Gateway) per joke,
-- so the page can show what happened under the hood.
ALTER TABLE jokes ADD COLUMN steps TEXT;   -- JSON: { stocktwits, ceramic, joke }
