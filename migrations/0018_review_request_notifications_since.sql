-- Ignore timeline review requests that predate this feature on existing installations.
INSERT INTO AppState (key, value)
VALUES ('review_request_notifications_since', STRFTIME('%Y-%m-%dT%H:%M:%fZ', 'now'));
