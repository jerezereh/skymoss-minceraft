-- Skymoss bridge — initial schema.
--
-- The live database is NOT tracked in git. This file is the source of truth for its
-- shape; the running DB is a binary that rewrites on every message and would conflict
-- on every pull. Back it up on the host instead (see docs/bridge.md).

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------------
-- issue_threads — the core mapping: one GitHub issue <-> one Discord thread.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS issue_threads (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  repo               TEXT    NOT NULL,
  issue_number       INTEGER NOT NULL,
  discord_channel_id TEXT    NOT NULL,
  discord_thread_id  TEXT    NOT NULL,
  issue_title        TEXT,
  state              TEXT    NOT NULL DEFAULT 'open',
  created_at         TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at         TEXT    NOT NULL DEFAULT (datetime('now')),

  UNIQUE (repo, issue_number),
  UNIQUE (discord_thread_id)
);

-- ---------------------------------------------------------------------------
-- message_links — every relayed message, recorded in both directions.
-- ---------------------------------------------------------------------------
-- This table is what prevents infinite echo. Relaying a GitHub comment to Discord
-- produces a Discord message, whose creation fires a Discord event, which would
-- relay back to GitHub, and so on. Before relaying anything we check whether either
-- ID is already recorded here; if it is, the message is one we produced and is
-- dropped. Losing this table means the bridge will loop.
CREATE TABLE IF NOT EXISTS message_links (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id          INTEGER REFERENCES issue_threads(id) ON DELETE CASCADE,

  github_comment_id  TEXT,
  discord_message_id TEXT,

  -- 'gh->dc' or 'dc->gh'
  direction          TEXT    NOT NULL,
  author_kind        TEXT    NOT NULL DEFAULT 'human',  -- human | bot | agent | system
  synced_at          TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- Partial unique indexes: a given upstream ID may only be relayed once. NULLs are
-- excluded so a row can carry only one side's ID without colliding.
CREATE UNIQUE INDEX IF NOT EXISTS idx_message_links_gh
  ON message_links(github_comment_id) WHERE github_comment_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_message_links_dc
  ON message_links(discord_message_id) WHERE discord_message_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_message_links_thread ON message_links(thread_id);

-- ---------------------------------------------------------------------------
-- actors — Discord identity <-> GitHub identity.
-- ---------------------------------------------------------------------------
-- Optional. Unlinked Discord users still get relayed, attributed by display name;
-- linking just makes attribution on the GitHub side real rather than cosmetic.
CREATE TABLE IF NOT EXISTS actors (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  discord_user_id TEXT UNIQUE,
  github_login    TEXT UNIQUE,
  display_name    TEXT,
  kind            TEXT NOT NULL DEFAULT 'human',   -- human | bot | agent
  linked_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------------------
-- event_log — append-only audit of everything the bridge handled.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS event_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  source      TEXT NOT NULL,          -- github | discord | ci
  event_type  TEXT NOT NULL,
  payload     TEXT,                   -- JSON
  outcome     TEXT,                   -- relayed | ignored | error
  detail      TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_event_log_created ON event_log(created_at);
CREATE INDEX IF NOT EXISTS idx_event_log_outcome ON event_log(outcome);
