use crate::github_client::GithubClient;
use crate::models::{
    CommentAction, GithubUser, PullRequestComment, PullRequestDetails, PullRequestState,
};
use crate::notification_debug::debug_github_notification;
use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use notify_rust::{Hint, Notification as DesktopNotification};
use octocrab::{Page, models::activity::Notification};
use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::time::{Duration, sleep};
use tracing::{debug, error, info};
use url::Url;

const POLL_INTERVAL_SECS: u64 = 10;
const LAST_SEEN_FILE: &str = "last_seen.txt";

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
                    error!("Failed to fetch notifications: {}", e);
                    sleep(Duration::from_secs(POLL_INTERVAL_SECS)).await;
                    continue;
                }
            };
            let max_seen = self
                .process_notifications(notifications.clone(), last_seen)
                .await;
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

    async fn process_notifications(
        &self,
        notifications: Page<Notification>,
        since: Option<DateTime<Utc>>,
    ) -> Option<DateTime<Utc>> {
        for notification in &notifications.items {
            if let Err(e) = self.process_notification(notification, since).await {
                error!("Failed to process notification: {}", e);
            }
        }

        // return max updated_at
        notifications.items.into_iter().map(|n| n.updated_at).max()
    }

    async fn process_notification(
        &self,
        notification: &Notification,
        since: Option<DateTime<Utc>>,
    ) -> Result<()> {
        debug_github_notification(notification);
        match &notification.subject.r#type[..] {
            "PullRequest" => {
                let pr = self.get_pr_details(notification, since).await?;
                let pr_author_avatar_local_uri =
                    Self::get_avatar(&pr.pr_author.login, &pr.pr_author.avatar_url)
                        .await
                        .unwrap_or_else(|e| {
                            error!("Failed to fetch avatar for {}: {}", pr.pr_author.login, e);
                            String::new()
                        });

                let mut body = String::new();
                body.push_str(&format!(
                    "<img src=\"{}\"/> [{}] {} ({})\n<b> </b>\n",
                    pr_author_avatar_local_uri,
                    notification.repository.name,
                    notification.subject.title,
                    pr.state.as_str()
                ));

                for comment in pr.comments {
                    let (login, avatar_url) = comment
                        .user
                        .as_ref()
                        .map(|u| (u.login.clone(), u.avatar_url.clone()))
                        .unwrap_or_default();

                    let avatar_local_uri = Self::get_avatar(&login, &avatar_url)
                        .await
                        .unwrap_or_else(|e| {
                            error!("Failed to fetch avatar for {}: {}", login, e);
                            String::new()
                        });

                    body.push_str(&format!(
                        "<img src=\"{}\"/> <b>{}</b> {} {}\n\n",
                        avatar_local_uri,
                        login,
                        comment.action.as_emoji(),
                        comment.body
                    ));
                }

                let icon = pr
                    .state
                    .icon_path()
                    .is_empty()
                    .then(String::new)
                    .unwrap_or_else(|| Self::resolve_image_path(pr.state.icon_path()));

                Self::show_desktop_notification("", &body, &icon)?;
            }
            _ => {
                let title = format!(
                    "[{}] {}",
                    notification.repository.name, notification.subject.title
                );
                let body = format!(
                    "Type: {}\nReason: {}",
                    notification.subject.r#type, notification.reason
                );

                Self::show_desktop_notification(&title, &body, "")?;
            }
        }
        Ok(())
    }

    pub async fn get_pr_details(
        &self,
        notification: &Notification,
        since: Option<DateTime<Utc>>,
    ) -> Result<PullRequestDetails> {
        let owner = notification
            .repository
            .owner
            .as_ref()
            .map(|o| o.login.clone())
            .context("repository owner is missing")?;

        let repo = notification.repository.name.clone();

        let pr_number = notification
            .subject
            .url
            .as_ref()
            .context("notification has no subject URL")?
            .path_segments()
            .context("invalid URL path segments")?
            .skip_while(|seg| *seg != "pulls")
            .nth(1)
            .context("could not find pull request number in URL")?
            .parse::<u64>()
            .context("pull request number was not a valid u64")?;

        let pr = self
            .github_client
            .get_pull_request(&owner, &repo, pr_number)
            .await
            .context("failed to fetch pull request details from GitHub")?;

        let state = if pr.merged.unwrap_or(false) {
            PullRequestState::Merged
        } else if pr.draft.unwrap_or(false) {
            PullRequestState::Draft
        } else if pr.state == Some(octocrab::models::IssueState::Closed) {
            PullRequestState::Closed
        } else if pr.state == Some(octocrab::models::IssueState::Open) {
            PullRequestState::Open
        } else {
            PullRequestState::Unknown
        };

        let mut comments: Vec<PullRequestComment> = Vec::new();

        comments.extend(
            self.github_client
                .get_pr_comments(&owner, &repo, pr_number)
                .await
                .context("failed to fetch pull request comments")?
                .items
                .into_iter()
                .filter(|comment| since.is_none_or(|since| comment.created_at > since))
                .map(|comment| PullRequestComment {
                    user: comment.user.map(GithubUser::from),
                    body: comment.body,
                    created_at: Some(comment.created_at),
                    action: CommentAction::Comment,
                })
                .collect::<Vec<_>>(),
        );

        comments.extend(
            self.github_client
                .get_reviews(owner.clone(), repo.clone(), pr_number)
                .await
                .context("failed to fetch pull request reviews")?
                .items
                .into_iter()
                .filter(|review| {
                    since.is_none_or(|since| {
                        review
                            .submitted_at
                            .is_some_and(|submitted_at| submitted_at > since)
                    })
                })
                .map(|review| PullRequestComment {
                    user: review.user.map(GithubUser::from),
                    body: review.body.as_deref().unwrap_or("").to_string(),
                    created_at: review.submitted_at,
                    action: review
                        .state
                        .map_or(CommentAction::Unknown, CommentAction::from),
                })
                .collect::<Vec<_>>(),
        );

        comments.sort_by_key(|f| f.created_at);

        let pr_author = match pr.user {
            Some(user) => GithubUser::from(*user),
            None => GithubUser {
                login: "unknown".to_string(),
                avatar_url: String::default(),
            },
        };

        Ok(PullRequestDetails {
            pr_number,
            pr_author,
            state,
            comments,
        })
    }

    fn resolve_image_path(relative_path: &str) -> String {
        let base_path = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
        base_path
            .join(relative_path)
            .to_str()
            .unwrap_or("")
            .to_string()
    }

    fn show_desktop_notification(
        title: &str,
        body: &str,
        icon: &str,
    ) -> std::result::Result<(), notify_rust::error::Error> {
        info!("New github notification: {} - {}", title, body);

        let desktop_notification_result = DesktopNotification::new()
            .summary(title)
            .body(body)
            .appname("octopulse")
            .icon(icon)
            .urgency(notify_rust::Urgency::Normal)
            .hint(Hint::DesktopEntry("org.mozilla.firefox".to_string()))
            .timeout(0)
            .show();

        match desktop_notification_result {
            Ok(_) => Ok(()),
            Err(e) => {
                error!("Failed to show desktop notification: {}", e);
                Err(e)
            }
        }
    }

    // For now, we are using a simple file to store the last seen timestamp. In the future, probably a db.
    fn get_last_seen_timestamp() -> Option<DateTime<Utc>> {
        fs::read_to_string(LAST_SEEN_FILE)
            .ok()
            .and_then(|s| DateTime::parse_from_rfc3339(s.trim()).ok())
            .map(|dt| dt.with_timezone(&Utc))
    }

    fn write_last_seen_timestamp(ts: &DateTime<Utc>) {
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

    /// downloads the resized image if not cached and returns a `file:///…` URI.
    async fn get_avatar(login: &str, avatar_url: &str) -> anyhow::Result<String> {
        let size = 18;
        let tmp_file =
            std::env::temp_dir().join(format!("octopulse-avatar-{}-{}.png", login, size));

        if tmp_file.exists() {
            debug!("Avatar file already exists: {}", tmp_file.display());
            return Ok(format!("file://{}", tmp_file.display()));
        }

        let mut url = Url::parse(avatar_url)?;
        url.query_pairs_mut().append_pair("s", &size.to_string());

        debug!(
            "Avatar file does not exist: {} Downloading avatar from: {}",
            tmp_file.display(),
            url
        );
        let resp = reqwest::get(url.as_str()).await?;
        let bytes = resp.bytes().await?;
        std::fs::write(&tmp_file, &bytes)?;

        Ok(format!("file://{}", tmp_file.display()))
    }
}
