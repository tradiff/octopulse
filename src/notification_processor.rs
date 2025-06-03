use crate::avatar_cache::AvatarCache;
use crate::desktop_notifier::DesktopNotifier;
use crate::github_client::GithubClient;
use crate::models::{CommentAction, Sound};
use anyhow::Result;
use chrono::{DateTime, Utc};
use octocrab::Page;
use octocrab::models::activity::Notification;
use std::sync::Arc;
use tracing::error;

pub struct NotificationProcessor;

impl NotificationProcessor {
    pub async fn process_notifications(
        github_client: &Arc<GithubClient>,
        notifications: Page<Notification>,
        since: Option<DateTime<Utc>>,
        current_user_login: &str,
    ) -> Option<DateTime<Utc>> {
        let avatar_cache = AvatarCache::new();

        for notification in &notifications.items {
            if let Err(e) = Self::process_notification(
                github_client,
                &avatar_cache,
                notification,
                since,
                current_user_login,
            )
            .await
            {
                error!("Failed to process notification: {}", e);
            }
        }

        notifications.items.into_iter().map(|n| n.updated_at).max()
    }

    async fn process_notification(
        github_client: &Arc<GithubClient>,
        avatar_cache: &AvatarCache,
        notification: &Notification,
        since: Option<DateTime<Utc>>,
        current_user_login: &str,
    ) -> Result<()> {
        match &notification.subject.r#type[..] {
            "PullRequest" => {
                let pr = github_client.get_pr_details(notification, since).await?;
                ensure_avatars(avatar_cache, &pr).await?;

                let approved: bool = pr
                    .comments
                    .iter()
                    .any(|c| matches!(c.action, CommentAction::ReviewApproved));

                let sound = if approved {
                    Some(Sound::Approved)
                } else {
                    Some(Sound::Comment)
                };

                DesktopNotifier::notify_pull_request(
                    &pr,
                    notification,
                    avatar_cache,
                    current_user_login,
                    sound,
                )
            }
            _ => DesktopNotifier::notify_generic(notification),
        }
    }
}

async fn ensure_avatars(
    avatar_cache: &AvatarCache,
    pr: &crate::models::PullRequestDetails,
) -> Result<(), anyhow::Error> {
    avatar_cache
        .ensure_avatar(&pr.author.login, &pr.author.avatar_url)
        .await?;
    Ok(for comment in &pr.comments {
        if let Some(user) = &comment.user {
            avatar_cache
                .ensure_avatar(&user.login, &user.avatar_url)
                .await?;
        }
    })
}
