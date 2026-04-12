ALTER TABLE EventBundle
  RENAME COLUMN window_started_at TO first_event_occurred_at;

ALTER TABLE EventBundle
  RENAME COLUMN window_ends_at TO last_event_occurred_at;

DROP INDEX idx_event_bundle_pull_request_window;

CREATE INDEX idx_event_bundle_pull_request_event_range
  ON EventBundle (pull_request_id, first_event_occurred_at, last_event_occurred_at);
