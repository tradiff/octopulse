CREATE INDEX idx_normalized_event_raw_event_id
  ON NormalizedEvent (raw_event_id);

CREATE INDEX idx_pull_request_ci_job_state_workflow_run
  ON PullRequestCiJobState (pull_request_id, workflow_run_id, workflow_run_updated_at);
