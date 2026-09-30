CREATE TABLE IF NOT EXISTS groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  name TEXT NOT NULL UNIQUE,
  icon TEXT NOT NULL DEFAULT '📁',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS webhook_targets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  method TEXT NOT NULL CHECK(method IN ('get', 'post_json', 'post_form')),
  url TEXT NOT NULL DEFAULT '',
  template TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  provider TEXT NOT NULL DEFAULT 'generic' CHECK(provider IN ('generic', 'serverchan3'))
);
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  message TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL DEFAULT '',
  cron_expression TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT 'webhook' CHECK(channel = 'webhook'),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
  tags TEXT NOT NULL DEFAULT '[]',
  group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE RESTRICT,
  webhook_id INTEGER NOT NULL REFERENCES webhook_targets(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS execution_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER REFERENCES tasks(id) ON DELETE SET NULL,
  legacy_task_id INTEGER,
  status TEXT NOT NULL CHECK(status IN ('success', 'failed')),
  error TEXT,
  executed_at TEXT NOT NULL,
  scheduled_for TEXT,
  source TEXT NOT NULL DEFAULT 'scheduled' CHECK(source IN ('scheduled', 'manual'))
);
-- A claim is never replayed: ambiguous network failures must not duplicate notifications.
CREATE TABLE IF NOT EXISTS execution_claims (
  task_id INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  scheduled_for TEXT NOT NULL,
  claimed_at INTEGER NOT NULL,
  finished INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(task_id, scheduled_for)
);
CREATE TABLE IF NOT EXISTS scheduler_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  csrf TEXT NOT NULL,
  username TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS login_attempts (bucket TEXT PRIMARY KEY, attempts INTEGER NOT NULL, expires_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_tasks_enabled ON tasks(enabled);
CREATE INDEX IF NOT EXISTS idx_tasks_group ON tasks(group_id);
CREATE INDEX IF NOT EXISTS idx_tasks_webhook ON tasks(webhook_id);
CREATE INDEX IF NOT EXISTS idx_history_task_time ON execution_history(task_id, executed_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_history_scheduled ON execution_history(task_id,scheduled_for) WHERE scheduled_for IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_history_time ON execution_history(executed_at);
CREATE INDEX IF NOT EXISTS idx_claims_age ON execution_claims(claimed_at);
CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_login_expiry ON login_attempts(expires_at);
INSERT OR IGNORE INTO groups (id, sort_order, name, icon, created_at, updated_at)
VALUES (1, 0, '默认', '📁', '2026-09-30 00:00:00', '2026-09-30 00:00:00');
INSERT OR IGNORE INTO webhook_targets (id, name, method, url, template, note, provider)
VALUES (1, 'Server酱³', 'post_json', '', '{"title":"{{title}}","desp":"{{content}}\n\n[查看详情]({{url}})"}', '填写 UID 和 SendKey 后即可发送', 'serverchan3');
