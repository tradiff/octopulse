CREATE TABLE PullRequestReviewState (
  id INTEGER PRIMARY KEY,
  pull_request_id INTEGER NOT NULL REFERENCES PullRequest(id),
  reviewer_login TEXT NOT NULL,
  reviewer_avatar_url TEXT,
  review_state TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(pull_request_id, reviewer_login)
);
