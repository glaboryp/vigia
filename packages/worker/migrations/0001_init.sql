CREATE TABLE snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider TEXT NOT NULL,
  source TEXT NOT NULL,
  ok INTEGER NOT NULL,
  error_kind TEXT,
  error_message TEXT,
  quotas_json TEXT,
  read_at TEXT NOT NULL
);
CREATE INDEX idx_snapshots_read_at ON snapshots (read_at);
CREATE INDEX idx_snapshots_provider ON snapshots (provider, read_at);

CREATE TABLE current_quotas (
  provider TEXT NOT NULL,
  quota_id TEXT NOT NULL,
  name TEXT NOT NULL,
  window TEXT NOT NULL,
  remaining_fraction REAL NOT NULL,
  remaining REAL,
  total REAL,
  unit TEXT,
  resets_at TEXT NOT NULL,
  period_reset_at TEXT NOT NULL,
  read_at TEXT NOT NULL,
  source TEXT NOT NULL,
  PRIMARY KEY (provider, quota_id)
);

CREATE TABLE period_closes (
  provider TEXT NOT NULL,
  quota_id TEXT NOT NULL,
  window TEXT NOT NULL,
  period_reset_at TEXT NOT NULL,
  used_fraction REAL NOT NULL,
  UNIQUE (provider, quota_id, period_reset_at)
);

CREATE TABLE sent_alerts (
  key TEXT PRIMARY KEY,
  sent_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE credentials (
  provider TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE provider_health (
  provider TEXT PRIMARY KEY,
  consecutive_failures INTEGER NOT NULL,
  last_error_kind TEXT,
  last_error_message TEXT,
  broken_notified INTEGER NOT NULL,
  last_ok_at TEXT,
  muted_until TEXT
);

CREATE TABLE leases (
  name TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);
