ALTER TABLE PullRequestCiJobState ADD COLUMN head_sha TEXT;

UPDATE PullRequestCiJobState
SET head_sha = (
  SELECT json_extract(raw_event.payload_json, '$.head_sha')
  FROM RawEvent AS raw_event
  WHERE raw_event.pull_request_id = PullRequestCiJobState.pull_request_id
    AND raw_event.source = 'github_actions_workflow_run'
    AND raw_event.source_id = PullRequestCiJobState.workflow_run_id || ':' || PullRequestCiJobState.workflow_run_updated_at
  ORDER BY raw_event.id DESC
  LIMIT 1
);
