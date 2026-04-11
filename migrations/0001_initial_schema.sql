CREATE TABLE PullRequest (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  github_pull_request_id INTEGER NOT NULL,
  repository_owner TEXT NOT NULL,
  repository_name TEXT NOT NULL,
  number INTEGER NOT NULL,
  url TEXT NOT NULL,
  author_login TEXT NOT NULL,
  title TEXT NOT NULL,
  state TEXT NOT NULL,
  is_draft INTEGER NOT NULL DEFAULT 0 CHECK (is_draft IN (0, 1)),
  is_tracked INTEGER NOT NULL DEFAULT 1 CHECK (is_tracked IN (0, 1)),
  tracking_reason TEXT NOT NULL DEFAULT 'auto',
  is_sticky_untracked INTEGER NOT NULL DEFAULT 0 CHECK (is_sticky_untracked IN (0, 1)),
  last_seen_at TEXT,
  closed_at TEXT,
  merged_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (github_pull_request_id),
  UNIQUE (repository_owner, repository_name, number)
);

CREATE TABLE RawEvent (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pull_request_id INTEGER NOT NULL REFERENCES PullRequest(id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  source_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  actor_login TEXT,
  payload_json TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  ingested_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (source, source_id)
);

CREATE TABLE NormalizedEvent (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  raw_event_id INTEGER REFERENCES RawEvent(id) ON DELETE SET NULL,
  pull_request_id INTEGER NOT NULL REFERENCES PullRequest(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  actor_login TEXT,
  actor_class TEXT,
  decision_state TEXT,
  summary TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  occurred_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE EventBundle (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pull_request_id INTEGER NOT NULL REFERENCES PullRequest(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending',
  window_started_at TEXT NOT NULL,
  window_ends_at TEXT NOT NULL,
  summary TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  sent_at TEXT
);

CREATE TABLE NotificationRecord (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_bundle_id INTEGER REFERENCES EventBundle(id) ON DELETE SET NULL,
  pull_request_id INTEGER NOT NULL REFERENCES PullRequest(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  delivery_status TEXT NOT NULL DEFAULT 'sent',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  delivered_at TEXT
);

CREATE INDEX idx_pull_request_tracking
  ON PullRequest (is_tracked, is_sticky_untracked);

CREATE INDEX idx_raw_event_pull_request_occurred_at
  ON RawEvent (pull_request_id, occurred_at);

CREATE INDEX idx_normalized_event_pull_request_occurred_at
  ON NormalizedEvent (pull_request_id, occurred_at);

CREATE INDEX idx_event_bundle_pull_request_window
  ON EventBundle (pull_request_id, window_started_at, window_ends_at);

CREATE INDEX idx_notification_record_pull_request_created_at
  ON NotificationRecord (pull_request_id, created_at);
