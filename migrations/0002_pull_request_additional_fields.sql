ALTER TABLE PullRequest ADD COLUMN grace_until TEXT;

ALTER TABLE PullRequest ADD COLUMN last_seen_head_sha TEXT;
