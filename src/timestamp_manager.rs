use chrono::{DateTime, Utc};
use std::fs;
use std::io::Write;
use tracing::error;

// For now we're using this simple file, but in the future we might use a db
const LAST_SEEN_FILE: &str = "last_seen.txt";

pub struct TimestampManager;

impl TimestampManager {
    pub fn get_last_seen_timestamp() -> Option<DateTime<Utc>> {
        fs::read_to_string(LAST_SEEN_FILE)
            .ok()
            .and_then(|s| DateTime::parse_from_rfc3339(s.trim()).ok())
            .map(|dt| dt.with_timezone(&Utc))
    }

    pub fn write_last_seen_timestamp(ts: &DateTime<Utc>) {
        match fs::File::create(LAST_SEEN_FILE) {
            Ok(mut file) => {
                if let Err(e) = writeln!(file, "{}", ts.to_rfc3339()) {
                    error!("Failed to store last seen timestamp: {}", e);
                }
            }
            Err(e) => {
                error!("Failed to create file `last_seen.txt`: {}", e);
            }
        }
    }
}
