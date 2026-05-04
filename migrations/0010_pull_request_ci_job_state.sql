ALTER TABLE PullRequest ADD COLUMN base_branch TEXT;

CREATE TABLE PullRequestCiJobState (
  id INTEGER PRIMARY KEY,
  pull_request_id INTEGER NOT NULL REFERENCES PullRequest(id),
  workflow_run_id TEXT NOT NULL,
  workflow_run_name TEXT NOT NULL,
  workflow_run_updated_at TEXT NOT NULL,
  job_id TEXT NOT NULL,
  job_name TEXT NOT NULL,
  job_status TEXT NOT NULL,
  job_conclusion TEXT,
  is_blocking_merge INTEGER,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(pull_request_id, job_id)
);
