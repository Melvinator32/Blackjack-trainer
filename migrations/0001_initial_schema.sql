-- Blackjack Trainer — multi-user schema.
--
-- Every table holding user-owned data carries a user_id foreign key, and every
-- API query filters on the user_id resolved from the session cookie server-side.

-- ---------------------------------------------------------------------------
-- Identity
-- ---------------------------------------------------------------------------

CREATE TABLE users (
  id          TEXT PRIMARY KEY,          -- stable opaque user id (usr_<random>)
  email       TEXT UNIQUE,               -- lowercased; may be NULL if provider gives none
  name        TEXT,
  picture     TEXT,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- One row per external login method linked to a user. Lets the same person sign
-- in with Google or an email code and land on the same user_id.
CREATE TABLE identities (
  provider    TEXT NOT NULL,             -- 'google' | 'email'
  subject     TEXT NOT NULL,             -- google 'sub', or lowercased email
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (provider, subject)
);
CREATE INDEX idx_identities_user ON identities(user_id);

-- Opaque session tokens. Only the SHA-256 hash is stored, so a database leak
-- does not yield usable session cookies.
CREATE TABLE sessions (
  token_hash  TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  expires_at  INTEGER NOT NULL
);
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);

-- Pending one-time email codes. Stores a hash of the code, never the code.
CREATE TABLE email_codes (
  email       TEXT PRIMARY KEY,
  code_hash   TEXT NOT NULL,
  expires_at  INTEGER NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL
);

-- ---------------------------------------------------------------------------
-- User-owned application data
-- ---------------------------------------------------------------------------

-- Audio preferences (sfx/music toggles and volumes). Small and schemaless, so
-- stored as a JSON document with last-write-wins on updated_at.
CREATE TABLE user_preferences (
  user_id     TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  data        TEXT NOT NULL,             -- JSON
  updated_at  INTEGER NOT NULL
);

-- Saved sessions shown in the High Scores table. One row per entry so scores
-- recorded on different devices merge by union rather than overwriting.
CREATE TABLE high_scores (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  entry_key   TEXT NOT NULL,             -- derived server-side; dedupes re-syncs
  date        TEXT,
  bankroll    INTEGER,
  peak        INTEGER,
  hands       INTEGER,
  book_acc    INTEGER,
  count_acc   INTEGER,
  region      TEXT,
  created_at  INTEGER NOT NULL
);
CREATE UNIQUE INDEX idx_high_scores_user_entry ON high_scores(user_id, entry_key);
CREATE INDEX idx_high_scores_user_peak ON high_scores(user_id, peak DESC);
