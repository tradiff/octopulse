ALTER TABLE PullRequest ADD COLUMN requested_reviewer_logins_json TEXT NOT NULL DEFAULT '[]';

ALTER TABLE PullRequest ADD COLUMN requested_review_team_keys_json TEXT NOT NULL DEFAULT '[]';
