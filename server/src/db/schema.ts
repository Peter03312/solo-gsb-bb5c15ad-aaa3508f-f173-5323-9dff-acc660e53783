/** 数据库表结构。服务启动时幂等执行（IF NOT EXISTS）。 */
export const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE,
  display_name  TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('checker','librarian')),
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS labels (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  title          TEXT NOT NULL,
  subtitle       TEXT NOT NULL DEFAULT '',
  current_version INTEGER NOT NULL DEFAULT 1,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS label_versions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  label_id    INTEGER NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
  version     INTEGER NOT NULL,
  body        TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  UNIQUE (label_id, version)
);

CREATE TABLE IF NOT EXISTS suggestions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  label_id        INTEGER NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
  author_id       INTEGER NOT NULL REFERENCES users(id),
  sel_start       INTEGER NOT NULL,
  sel_end         INTEGER NOT NULL,
  selected_text   TEXT NOT NULL,
  replacement     TEXT NOT NULL,
  basis           TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','conflict','adopted')),
  range_version   INTEGER NOT NULL,
  based_on_version INTEGER NOT NULL,
  conflict_reason TEXT,
  adopted_in_version INTEGER,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_suggestions_label ON suggestions(label_id, status);

CREATE TABLE IF NOT EXISTS publications (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  label_id         INTEGER NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
  label_version    INTEGER NOT NULL,
  body             TEXT NOT NULL,
  published_by     INTEGER NOT NULL REFERENCES users(id),
  published_at     TEXT NOT NULL,
  note             TEXT NOT NULL DEFAULT '',
  UNIQUE (label_id, label_version)
);

CREATE TABLE IF NOT EXISTS publication_adoptions (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  publication_id INTEGER NOT NULL REFERENCES publications(id) ON DELETE CASCADE,
  suggestion_id  INTEGER NOT NULL REFERENCES suggestions(id),
  sel_start      INTEGER NOT NULL,
  sel_end        INTEGER NOT NULL,
  selected_text  TEXT NOT NULL,
  replacement    TEXT NOT NULL,
  basis          TEXT NOT NULL,
  author_name    TEXT NOT NULL,
  adopted_in_version INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pa_pub ON publication_adoptions(publication_id);
`;
