ALTER TABLE NotificationRecord
  ADD COLUMN normalized_event_id INTEGER REFERENCES NormalizedEvent(id) ON DELETE SET NULL;

ALTER TABLE NotificationRecord
  ADD COLUMN click_url TEXT;

CREATE UNIQUE INDEX idx_notification_record_event_bundle_id
  ON NotificationRecord (event_bundle_id)
  WHERE event_bundle_id IS NOT NULL;

CREATE UNIQUE INDEX idx_notification_record_normalized_event_id
  ON NotificationRecord (normalized_event_id)
  WHERE normalized_event_id IS NOT NULL;
