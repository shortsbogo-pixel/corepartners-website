-- masked chatbot conversation logs for weekly review / topic analytics
CREATE TABLE IF NOT EXISTS chat_logs (
  id TEXT PRIMARY KEY,
  session TEXT,
  role TEXT NOT NULL,
  topic TEXT,
  flagged INTEGER NOT NULL DEFAULT 0,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chat_logs_created ON chat_logs (created_at);
