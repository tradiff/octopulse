use crate::github_client::GithubClient;
use crate::notification_processor::NotificationProcessor;
use crate::timestamp_manager::TimestampManager;
use std::sync::Arc;
use tokio::time::{Duration, sleep};
use tracing::{debug, error};

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
            let last_seen = TimestampManager::get_last_seen_timestamp();
            let notifications = match self
                .github_client
                .get_participating_notifications(last_seen.as_ref())
                .await
            {
                Ok(n) => n,
                Err(e) => {
                    error!("Failed to fetch notifications: {}", e);
                    sleep(Duration::from_secs(POLL_INTERVAL_SECS)).await;
                    continue;
                }
            };

            let max_seen = NotificationProcessor::process_notifications(
                &self.github_client,
                notifications.clone(),
                last_seen,
            )
            .await;
            if let Some(mut ts) = max_seen {
                ts += chrono::Duration::seconds(1);
                debug!("Updating last seen timestamp to {}", ts);
                TimestampManager::write_last_seen_timestamp(&ts);
            }

            debug!("Fetched {} notifications", notifications.items.len());
            sleep(Duration::from_secs(POLL_INTERVAL_SECS)).await;
        }
    }
}
