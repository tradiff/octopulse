ALTER TABLE NormalizedEvent
  ADD COLUMN event_bundle_id INTEGER REFERENCES EventBundle(id) ON DELETE SET NULL;

CREATE INDEX idx_normalized_event_event_bundle_id
  ON NormalizedEvent (event_bundle_id);
