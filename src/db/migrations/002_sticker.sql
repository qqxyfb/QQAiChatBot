-- 002_sticker.sql —— 表情包组 + 表情文件（v2）
-- 说明：迁移器会在执行后写入 PRAGMA user_version = 2，本文件不重复设置。

CREATE TABLE IF NOT EXISTS sticker_set (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  is_default INTEGER DEFAULT 0,
  created_at INTEGER
);

CREATE TABLE IF NOT EXISTS sticker (
  id         TEXT PRIMARY KEY,
  set_id     TEXT NOT NULL,
  file_name  TEXT NOT NULL,
  file_path  TEXT NOT NULL,
  tags       TEXT NOT NULL,
  created_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_sticker_set ON sticker(set_id);

-- 内置默认组（示例表情文件由资源随包附带，这里仅建组）
INSERT INTO sticker_set (id, name, is_default, created_at)
  SELECT 'default', '默认表情包', 1, strftime('%s','now')*1000
  WHERE NOT EXISTS (SELECT 1 FROM sticker_set WHERE id = 'default');
