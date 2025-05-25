use crate::github_client::GithubClient;
use chrono::{DateTime, Utc};
use notify_rust::Notification as DesktopNotification;
use octocrab::{Page, models::activity::Notification};
use serde::Serialize;
use std::fs;
use std::io::Write;
use std::sync::Arc;
use tokio::time::{Duration, sleep};
use tracing::{debug, error, info};

const POLL_INTERVAL_SECS: u64 = 10;

pub struct GithubNotificationPoller {
    github_client: Arc<GithubClient>,
}

impl GithubNotificationPoller {
    pub fn new(github_client: Arc<GithubClient>) -> Self {
        Self { github_client }
    }

    pub async fn run(&self) {
        loop {
            debug!("Fetching notifications...");
            let last_seen = Self::get_last_seen_timestamp();
            let notifications = match self
                .github_client
                .get_participating_notifications(last_seen.as_ref())
                .await
            {
                Ok(n) => n,
                Err(e) => {
                    debug!("Failed to fetch notifications: {}", e);
                    sleep(Duration::from_secs(POLL_INTERVAL_SECS)).await;
                    continue;
                }
            };
            let max_seen = Self::process_notifications(notifications.clone());
            if let Some(mut ts) = max_seen {
                // Add 1 second to avoid retrieving the same notification
                ts += chrono::Duration::seconds(1);
                debug!("Updating last seen timestamp to {}", ts);
                Self::write_last_seen_timestamp(&ts);
            }

            debug!("Fetched {} notifications", notifications.items.len());
            sleep(Duration::from_secs(POLL_INTERVAL_SECS)).await;
        }
    }

    fn show_desktop_notification(
        github_notification: &octocrab::models::activity::Notification,
    ) -> Result<(), notify_rust::error::Error> {
        let title = format!(
            "[{}] {}",
            github_notification
                .repository
                .full_name
                .as_deref()
                .unwrap_or_default(),
            github_notification.subject.title
        );
        let body = format!(
            "{}\nType: {}\nReason: {}",
            github_notification.subject.title,
            github_notification.subject.r#type,
            github_notification.reason
        );

        info!("New github notification: {} - {}", title, body);

        let desktop_notification_result = DesktopNotification::new()
            .summary(&title)
            .body(&body)
            .show();

        match desktop_notification_result {
            Ok(_) => Ok(()),
            Err(e) => {
                error!("Failed to show desktop notification: {}", e);
                Err(e)
            }
        }
    }

    fn process_notifications(notifications: Page<Notification>) -> Option<DateTime<Utc>> {
        for notification in &notifications.items {
            Self::process_notification(notification);
        }

        // return max updated_at
        notifications.items.into_iter().map(|n| n.updated_at).max()
    }

    fn process_notification(notification: &Notification) {
        Self::debug_github_notification(notification);
        if let Err(e) = Self::show_desktop_notification(notification) {
            error!("failed to show desktop notification: {:?}", e);
        }
    }

    // For now, we are using a simple file to store the last seen timestamp. In the future, probably a db.
    fn get_last_seen_timestamp() -> Option<DateTime<Utc>> {
        fs::read_to_string("last_seen.txt")
            .ok()
            .and_then(|s| DateTime::parse_from_rfc3339(s.trim()).ok())
            .map(|dt| dt.with_timezone(&Utc))
    }

    fn write_last_seen_timestamp(ts: &DateTime<Utc>) {
        match fs::File::create("last_seen.txt") {
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

    fn debug_github_notification(notification: &Notification) {
        #[derive(Serialize)]
        struct MinimalRepo {
            name: String,
            full_name: String,
        }
        #[derive(Serialize)]
        struct NotificationWithTrimmedRepo<'a> {
            #[serde(flatten)]
            #[serde(with = "trimmed_notification")]
            notification: &'a octocrab::models::activity::Notification,
            repository: MinimalRepo,
        }
        mod trimmed_notification {
            use serde::ser::{SerializeStruct, Serializer};
            pub fn serialize<S>(
                notification: &octocrab::models::activity::Notification,
                s: S,
            ) -> Result<S::Ok, S::Error>
            where
                S: Serializer,
            {
                let mut state = s.serialize_struct("Notification", 7)?;
                state.serialize_field("id", &notification.id)?;
                state.serialize_field("unread", &notification.unread)?;
                state.serialize_field("reason", &notification.reason)?;
                state.serialize_field("updated_at", &notification.updated_at)?;
                state.serialize_field("last_read_at", &notification.last_read_at)?;
                state.serialize_field("subject", &notification.subject)?;
                // repository intentionally omitted
                state.serialize_field("url", &notification.url)?;
                state.end()
            }
        }
        let minimal = NotificationWithTrimmedRepo {
            notification,
            repository: MinimalRepo {
                name: notification.repository.name.clone(),
                full_name: notification
                    .repository
                    .full_name
                    .as_deref()
                    .unwrap_or_default()
                    .to_string(),
            },
        };
        let json = match serde_json::to_string(&minimal) {
            Ok(json) => json,
            Err(e) => {
                debug!("Failed to serialize notification: {}", e);
                return;
            }
        };
        debug!("JSON: {}", json);
    }
}
