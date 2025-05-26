use octocrab::{Octocrab, models::activity::Notification, models::pulls::PullRequest};

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

    pub async fn get_pull_request(
        &self,
        owner: &str,
        repo: &str,
        pr_number: u64,
    ) -> Result<PullRequest, octocrab::Error> {
        self.octocrab.pulls(owner, repo).get(pr_number).await
    }

    pub async fn get_pr_comments(
        &self,
        owner: &str,
        repo: &str,
        pr_number: u64,
    ) -> Result<octocrab::Page<octocrab::models::pulls::Comment>, octocrab::Error> {
        self.octocrab
            .pulls(owner, repo)
            .list_comments(Some(pr_number))
            .send()
            .await
    }

    pub async fn get_reviews(
        &self,
        owner: String,
        repo: String,
        pr_number: u64,
    ) -> Result<octocrab::Page<octocrab::models::pulls::Review>, octocrab::Error> {
        self.octocrab
            .pulls(owner, repo)
            .list_reviews(pr_number)
            .send()
            .await
    }
}
