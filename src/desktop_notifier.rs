use std::path::PathBuf;

use crate::{avatar_cache::AvatarCache, models::PullRequestDetails};
use notify_rust::{Hint, Notification as DesktopNotification};
use octocrab::models::activity::Notification;
use tracing::{debug, error, info};

pub struct DesktopNotifier;

impl DesktopNotifier {
    pub fn notify_pull_request(
        pr: &PullRequestDetails,
        notification: &Notification,
        avatar_cache: &AvatarCache,
    ) -> anyhow::Result<()> {
        let pr_author_avatar_local_uri = avatar_cache
            .get_avatar_local_uri(pr.author.login.as_str())
            .unwrap_or_default();

        let mut body = String::new();
        body.push_str(&format!(
            "<img src=\"{}\"/> [{}] {} ({})\n<b> </b>\n",
            pr_author_avatar_local_uri,
            notification.repository.name,
            notification.subject.title,
            pr.state.as_str()
        ));

        for comment in &pr.comments {
            let user_login = comment
                .user
                .as_ref()
                .map(|u| u.login.clone())
                .unwrap_or_else(|| "unknown".to_string());

            let avatar_local_uri = avatar_cache
                .get_avatar_local_uri(user_login.as_str())
                .unwrap_or_default();

            body.push_str(&format!(
                "<img src=\"{}\"/> <b>{}</b> {} {}\n\n",
                avatar_local_uri,
                comment
                    .user
                    .as_ref()
                    .map(|u| u.login.clone())
                    .unwrap_or_default(),
                comment.action.as_emoji(),
                comment.body
            ));
        }

        let icon = pr.state.icon_path();
        debug!("Using icon: {} for state:{}", icon, pr.state.as_str());

        Self::show_desktop_notification("", &body, icon)
    }

    pub fn notify_generic(notification: &Notification) -> anyhow::Result<()> {
        let title = format!(
            "[{}] {}",
            notification.repository.name, notification.subject.title
        );
        let body = format!(
            "Type: {}\nReason: {}",
            notification.subject.r#type, notification.reason
        );

        Self::show_desktop_notification(&title, &body, "")
    }

    fn show_desktop_notification(title: &str, body: &str, icon: &str) -> anyhow::Result<()> {
        info!("New github notification: {} - {}", title, body);
        let icon = if icon.is_empty() {
            ""
        } else {
            &Self::resolve_image_path(icon)
        };

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
                Err(anyhow::anyhow!(e))
            }
        }
    }

    fn resolve_image_path(relative_path: &str) -> String {
        let base_path = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
        base_path
            .join(relative_path)
            .to_str()
            .unwrap_or("")
            .to_string()
    }
}
