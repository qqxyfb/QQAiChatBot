-- 001_init.sql —— 初始 schema（v1）
-- 说明：迁移器会在执行后写入 PRAGMA user_version = 1，本文件不重复设置。

CREATE TABLE IF NOT EXISTS connection (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  connection_id TEXT UNIQUE NOT NULL,
  name          TEXT NOT NULL,
  type          TEXT NOT NULL,
  status        TEXT,
  persona_id    TEXT,
  config_json   TEXT,
  created_at    INTEGER,
  updated_at    INTEGER
);

CREATE TABLE IF NOT EXISTS persona (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  content_json TEXT NOT NULL,
  builtin      INTEGER DEFAULT 0,
  created_at   INTEGER,
  updated_at   INTEGER
);

CREATE TABLE IF NOT EXISTS banword (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  word       TEXT NOT NULL UNIQUE,
  direction  TEXT DEFAULT 'both',
  enabled    INTEGER DEFAULT 1,
  created_at INTEGER
);

CREATE TABLE IF NOT EXISTS run_session (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  connection_id  TEXT NOT NULL,
  start_at       INTEGER NOT NULL,
  end_at         INTEGER,
  connector_type TEXT,
  persona        TEXT,
  model          TEXT,
  status         TEXT
);
CREATE INDEX IF NOT EXISTS idx_session_conn ON run_session(connection_id);

CREATE TABLE IF NOT EXISTS message_log (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  connection_id     TEXT NOT NULL,
  session_id        INTEGER,
  ts                INTEGER NOT NULL,
  channel           TEXT,
  from_hash         TEXT,
  group_hash        TEXT,
  direction         TEXT,
  content           TEXT,
  reply             TEXT,
  finish_reason     TEXT,
  latency_ms        INTEGER,
  llm_ms            INTEGER,
  llm_attempts      INTEGER,
  prompt_tokens     INTEGER,
  completion_tokens INTEGER,
  msg_id            TEXT
);
CREATE INDEX IF NOT EXISTS idx_msg_conn ON message_log(connection_id);
CREATE INDEX IF NOT EXISTS idx_msg_ts   ON message_log(ts);
CREATE INDEX IF NOT EXISTS idx_msg_from ON message_log(from_hash);

CREATE TABLE IF NOT EXISTS llm_call (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  connection_id     TEXT NOT NULL,
  session_id        INTEGER,
  ts                INTEGER NOT NULL,
  model             TEXT,
  prompt_tokens     INTEGER,
  completion_tokens INTEGER,
  latency_ms        INTEGER,
  status            TEXT,
  retry_cnt         INTEGER,
  error             TEXT
);
CREATE INDEX IF NOT EXISTS idx_llm_conn ON llm_call(connection_id);
CREATE INDEX IF NOT EXISTS idx_llm_ts   ON llm_call(ts);

CREATE TABLE IF NOT EXISTS connection_event (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  connection_id  TEXT NOT NULL,
  ts             INTEGER NOT NULL,
  event          TEXT,
  connector_type TEXT,
  detail         TEXT
);

CREATE TABLE IF NOT EXISTS abuse_event (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  connection_id TEXT NOT NULL,
  ts            INTEGER NOT NULL,
  from_hash     TEXT,
  reason        TEXT,
  kind          TEXT
);

-- 每日 token 预算持久化（重启后预算不丢失）
CREATE TABLE IF NOT EXISTS token_budget (
  connection_id TEXT NOT NULL,
  from_hash     TEXT NOT NULL,
  day           TEXT NOT NULL,
  tokens        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (connection_id, from_hash, day)
);

CREATE TABLE IF NOT EXISTS persona_snapshot (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  ts         INTEGER NOT NULL,
  persona_id TEXT,
  name       TEXT,
  note       TEXT
);

CREATE TABLE IF NOT EXISTS config_snapshot (
  id    INTEGER PRIMARY KEY AUTOINCREMENT,
  ts    INTEGER NOT NULL,
  scope TEXT,
  json  TEXT,
  note  TEXT
);

CREATE TABLE IF NOT EXISTS app_meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- 内置全局安全词（占位，可增删）
INSERT OR IGNORE INTO banword (word, direction, enabled, created_at) VALUES
  ('政治敏感话题', 'both', 1, 0),
  ('露骨色情描写', 'both', 1, 0),
  ('辱骂攻击他人', 'both', 1, 0),
  ('违法犯罪引导', 'both', 1, 0),
  ('诱导自残或自杀', 'both', 1, 0),
  ('泄露真实隐私', 'both', 1, 0),
  ('宣扬暴力', 'both', 1, 0),
  ('虚假医疗建议', 'both', 1, 0);
