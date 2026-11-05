-- Operation journal (files/gateway/journal.sqlite, WAL, user_version=1)
-- REQUIREMENTS §7 field mapping in comments.
CREATE TABLE IF NOT EXISTS operation (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,                 -- timestamp
  session TEXT,                     -- session
  task TEXT,                        -- task
  tool TEXT,                        -- tool
  args TEXT,                        -- arguments (JSON, capped 4 KB)
  provider TEXT,                    -- effective provider/capability provider
  capability TEXT,                  -- capability id
  risk TEXT,                        -- risk class
  mode TEXT,                        -- gateway user mode at decision time
  decision TEXT,                    -- allow | deny | reject | backup-failed
  approval_source TEXT,             -- ui | timeout | policy:* | rpc-ceiling | host
  rule_hits TEXT,                   -- hard-confirm rule ids (JSON)
  hard_confirm INTEGER,             -- 1 when the hard-confirm tier fired
  result TEXT,                      -- result summary
  files_modified TEXT,              -- JSON array of absolute paths
  before_hash TEXT,                 -- sha256 pre-image (overwrites)
  after_hash TEXT,                  -- sha256 post-image (rollback rows exact)
  backup_path TEXT,                 -- backup artifact path
  reversible INTEGER,               -- 1 when a backup exists
  detail TEXT                       -- free-form context
);
