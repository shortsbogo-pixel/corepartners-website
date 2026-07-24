-- chat rate limiting per IP (10-minute windows)
CREATE TABLE IF NOT EXISTS chat_rate (
  ip TEXT PRIMARY KEY,
  window_start INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 0
);
