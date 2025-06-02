use std::fs::File;
use std::io::BufReader;
use std::path::PathBuf;

use crate::{
    avatar_cache::AvatarCache,
    models::{PullRequestDetails, Sound},
};
use notify_rust::{Hint, Notification as DesktopNotification};
use octocrab::models::activity::Notification;
use rodio::{Decoder, OutputStream, Sink};
use tracing::{debug, error, info, warn};

pub struct DesktopNotifier;

impl DesktopNotifier {
    pub fn notify_pull_request(
        pr: &PullRequestDetails,
        notification: &Notification,
        avatar_cache: &AvatarCache,
        current_user_login: &str,
        sound: Option<Sound>,
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

            if user_login == current_user_login {
                continue;
            }

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
                Self::truncate_string(&comment.body)
            ));
        }

        let icon = pr.state.icon_path();
        debug!("Using icon: {} for state:{}", icon, pr.state.as_str());

        let result = Self::show_desktop_notification("", &body, icon);
        if let Some(sound) = sound {
            let sound_result = match sound {
                Sound::Comment => Self::play_sound("media/comment.wav"),
                Sound::Approved => Self::play_sound("media/approved.wav"),
            };
            if let Err(e) = sound_result {
                warn!("Failed to play sound: {}", e);
            }
        }
        result
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

        Self::play_notification_sound();
        Self::show_desktop_notification(&title, &body, "")
    }

    fn show_desktop_notification(title: &str, body: &str, icon: &str) -> anyhow::Result<()> {
        info!("New github notification: {} - {}", title, body);
        let icon = if icon.is_empty() {
            ""
        } else {
            &Self::resolve_media_path(icon)
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

    fn play_notification_sound() {
        std::thread::spawn(|| match Self::play_sound("media/approved.wav") {
            Ok(_) => debug!("Successfully played notification sound"),
            Err(e) => warn!("Failed to play notification sound: {}", e),
        });
    }

    fn play_sound(sound_file: &str) -> anyhow::Result<()> {
        let sound_path = Self::resolve_media_path(sound_file);
        let (_stream, stream_handle) = OutputStream::try_default()?;
        let file = File::open(&sound_path)?;
        let source = Decoder::new(BufReader::new(file))?;
        let sink = Sink::try_new(&stream_handle)?;
        sink.append(source);
        sink.sleep_until_end();

        Ok(())
    }

    fn resolve_media_path(relative_path: &str) -> String {
        let base_path = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
        base_path
            .join(relative_path)
            .to_str()
            .unwrap_or("")
            .to_string()
    }

    fn truncate_string(s: &str) -> String {
        const MAX_LENGTH: usize = 100;
        if s.len() > MAX_LENGTH {
            format!("{}…", &s[..MAX_LENGTH])
        } else {
            s.to_string()
        }
    }
}
