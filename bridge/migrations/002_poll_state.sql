-- Cursor for GitHub polling mode.
--
-- Without a public hostname there is nowhere for GitHub to deliver webhooks, so the
-- bridge polls instead. This records how far it has read, so a restart doesn't
-- re-relay old comments or skip ones that arrived while it was down.

CREATE TABLE IF NOT EXISTS poll_state (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
