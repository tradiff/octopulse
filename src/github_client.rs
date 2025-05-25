use octocrab::{Octocrab, models::activity::Notification};

pub struct GithubClient {
    pub octocrab: Octocrab,
}

impl GithubClient {
    pub fn new(token: &str) -> Result<Self, octocrab::Error> {
        let octocrab = Octocrab::builder().personal_token(token).build()?;
        Ok(GithubClient { octocrab })
    }

    // Endpoint docs: https://docs.github.com/en/rest/activity/notifications#list-notifications-for-the-authenticated-user
    pub async fn get_participating_notifications(
        &self,
        since: Option<&chrono::DateTime<chrono::Utc>>,
    ) -> Result<octocrab::Page<Notification>, octocrab::Error> {
        let mut req = self
            .octocrab
            .activity()
            .notifications()
            .list()
            .participating(true);
        if let Some(since) = since {
            req = req.since(*since);
        }
        req.send().await
    }
}
