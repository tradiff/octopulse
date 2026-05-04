ALTER TABLE PullRequest ADD COLUMN mergeable INTEGER CHECK (mergeable IN (0, 1));

ALTER TABLE PullRequest ADD COLUMN mergeable_state TEXT;

ALTER TABLE PullRequest ADD COLUMN requested_review_team_slugs_json TEXT NOT NULL DEFAULT '[]';
