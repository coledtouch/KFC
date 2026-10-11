-- Operational counts only. Never store IPs, full URLs, raw user agents, uploads,
-- prompts, transcripts, provider response bodies, or passwords.
CREATE TABLE IF NOT EXISTS analytics_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS analytics_sessions (
  session_hash TEXT PRIMARY KEY,
  first_seen INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  country TEXT NOT NULL,
  device TEXT NOT NULL,
  referrer TEXT NOT NULL,
  source TEXT NOT NULL,
  medium TEXT NOT NULL,
  campaign TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS analytics_sessions_seen ON analytics_sessions(last_seen);
CREATE TABLE IF NOT EXISTS analytics_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp INTEGER NOT NULL,
  session_hash TEXT,
  event TEXT NOT NULL,
  path TEXT NOT NULL,
  status INTEGER,
  duration_ms INTEGER,
  error_code TEXT
);
CREATE INDEX IF NOT EXISTS analytics_events_time ON analytics_events(timestamp);
CREATE INDEX IF NOT EXISTS analytics_events_session ON analytics_events(session_hash, timestamp);
CREATE TABLE IF NOT EXISTS analytics_scans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp INTEGER NOT NULL,
  status INTEGER NOT NULL,
  provider_status INTEGER,
  duration_ms INTEGER NOT NULL,
  model TEXT NOT NULL,
  mode TEXT NOT NULL,
  app TEXT NOT NULL,
  image_count INTEGER NOT NULL,
  voice_seconds REAL NOT NULL,
  provider_attempted INTEGER NOT NULL,
  error_code TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cache_read_tokens INTEGER,
  cache_creation_tokens INTEGER,
  cache_write_5m_tokens INTEGER,
  cache_write_1h_tokens INTEGER,
  estimated_usd REAL
);
CREATE INDEX IF NOT EXISTS analytics_scans_time ON analytics_scans(timestamp);
-- A signed cookie is also checked against this table so logout revokes replay.
CREATE TABLE IF NOT EXISTS admin_sessions (
  session_id TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS admin_sessions_expiry ON admin_sessions(expires_at);
