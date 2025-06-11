use crate::models::{
    CommentAction, GithubUser, PullRequestComment, PullRequestDetails, PullRequestState,
};
use anyhow::{Context, Result};
use chrono::DateTime;
use octocrab::{
    Octocrab,
    models::{activity::Notification, pulls::PullRequest},
};

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

    pub async fn get_pr_details(
        &self,
        notification: &Notification,
        since: Option<DateTime<chrono::Utc>>,
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

        let author = match pr.user {
            Some(user) => GithubUser::from(*user),
            None => GithubUser {
                login: "unknown".to_string(),
                avatar_url: String::default(),
            },
        };

        let mut comments: Vec<PullRequestComment> = Vec::new();

        comments.extend(
            self.get_pr_comments(&owner, &repo, pr_number)
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
            self.get_issue_comments(&owner, &repo, pr_number)
                .await
                .context("failed to fetch issue comments")?
                .items
                .into_iter()
                .filter(|comment| since.is_none_or(|since| comment.created_at > since))
                .map(|comment| PullRequestComment {
                    user: Some(GithubUser::from(comment.user)),
                    body: comment.body.unwrap_or_default(),
                    created_at: Some(comment.created_at),
                    action: CommentAction::Comment,
                })
                .collect::<Vec<_>>(),
        );

        comments.extend(
            self.get_reviews(owner.clone(), repo.clone(), pr_number)
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

        let html_url = format!("https://github.com/{}/{}/pull/{}", owner, repo, pr_number);

        Ok(PullRequestDetails {
            author,
            state,
            comments,
            html_url,
        })
    }

    async fn get_pull_request(
        &self,
        owner: &str,
        repo: &str,
        pr_number: u64,
    ) -> Result<PullRequest, octocrab::Error> {
        self.octocrab.pulls(owner, repo).get(pr_number).await
    }

    async fn get_pr_comments(
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

    // Gets comments on an issue, which can include PR bot comments
    async fn get_issue_comments(
        &self,
        owner: &str,
        repo: &str,
        issue_number: u64,
    ) -> Result<octocrab::Page<octocrab::models::issues::Comment>, octocrab::Error> {
        self.octocrab
            .issues(owner, repo)
            .list_comments(issue_number)
            .send()
            .await
    }

    async fn get_reviews(
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

    pub async fn get_current_user(&self) -> Result<GithubUser, octocrab::Error> {
        self.octocrab.current().user().await.map(GithubUser::from)
    }
}
