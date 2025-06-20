use crate::github_client::GithubClient;
use crate::notification_processor::NotificationProcessor;
use crate::timestamp_manager::TimestampManager;
use std::sync::Arc;
use tokio::time::{Duration, sleep};
use tracing::{debug, error};

const POLL_INTERVAL_SECS: u64 = 10;

pub struct GithubNotificationPoller {
    github_client: Arc<GithubClient>,
    current_user_login: String,
}

impl GithubNotificationPoller {
    pub async fn new(github_client: Arc<GithubClient>) -> Self {
        let mut poller = Self {
            github_client,
            current_user_login: String::new(),
        };
        poller.initialize_current_user().await;
        poller
    }

    pub async fn initialize_current_user(&mut self) {
        match self.github_client.get_current_user().await {
            Ok(user) => self.current_user_login = user.login,
            Err(e) => error!("Failed to fetch current user: {}", e),
        }
    }

    pub async fn run(&self) {
        loop {
            debug!("Fetching notifications...");
            let last_seen = TimestampManager::get_last_seen_timestamp()
                // Add a few seconds becuase github's API can be a bit flaky and will send events updated before the
                // request time, resulting in endless duplicates being returned.
                .map(|ts| ts + chrono::Duration::seconds(3));
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
                &self.current_user_login,
            )
            .await;
            if let Some(ts) = max_seen {
                debug!("Updating last seen timestamp to {}", ts);
                TimestampManager::write_last_seen_timestamp(&ts);
            }

            debug!("Fetched {} notifications", notifications.items.len());
            sleep(Duration::from_secs(POLL_INTERVAL_SECS)).await;
        }
    }
}
