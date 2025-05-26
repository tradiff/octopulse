use octocrab::models::activity::Notification;
use serde::Serialize;
use tracing::debug;

#[derive(Serialize)]
struct MinimalRepo {
    name: String,
    full_name: String,
}

#[derive(Serialize)]
struct NotificationWithTrimmedRepo<'a> {
    #[serde(flatten)]
    #[serde(with = "trimmed_notification")]
    notification: &'a Notification,
    repository: MinimalRepo,
}

mod trimmed_notification {
    use serde::ser::{SerializeStruct, Serializer};
    use octocrab::models::activity::Notification;

    pub fn serialize<S>(
        notification: &Notification,
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
        state.serialize_field("url", &notification.url)?;
        state.end()
    }
}

pub fn debug_github_notification(notification: &Notification) {
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
