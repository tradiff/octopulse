use chrono::{DateTime, Utc};
use octocrab::models::{Author, pulls::ReviewState};

pub struct PullRequestDetails {
    pub author: GithubUser,
    pub state: PullRequestState,
    pub comments: Vec<PullRequestComment>,
    pub html_url: String,
}

pub struct PullRequestComment {
    pub created_at: Option<DateTime<Utc>>,
    pub user: Option<GithubUser>,
    pub action: CommentAction,
    pub body: String,
}

pub struct GithubUser {
    pub login: String,
    pub avatar_url: String,
}

impl From<Author> for GithubUser {
    fn from(author: Author) -> Self {
        GithubUser {
            login: author.login,
            avatar_url: author.avatar_url.to_string(),
        }
    }
}

pub enum PullRequestState {
    Merged,
    Draft,
    Closed,
    Open,
    Unknown,
}

impl PullRequestState {
    pub fn as_str(&self) -> &str {
        match self {
            PullRequestState::Merged => "merged",
            PullRequestState::Draft => "draft",
            PullRequestState::Closed => "closed",
            PullRequestState::Open => "open",
            PullRequestState::Unknown => "unknown",
        }
    }

    pub fn icon_path(&self) -> &str {
        match self {
            PullRequestState::Merged => "media/pull-request-merged.svg",
            PullRequestState::Draft => "media/pull-request-draft.svg",
            PullRequestState::Closed => "media/pull-request-closed.svg",
            PullRequestState::Open => "media/pull-request-open.svg",
            PullRequestState::Unknown => "",
        }
    }
}

pub enum CommentAction {
    Comment,
    ReviewApproved,
    ReviewChangesRequested,
    ReviewDismissed,
    Unknown,
}

pub enum Sound {
    Comment,
    Approved,
}

impl CommentAction {
    pub fn as_emoji(&self) -> &str {
        match self {
            CommentAction::Comment => "💬",
            CommentAction::ReviewApproved => "✅",
            CommentAction::ReviewChangesRequested => "❗",
            CommentAction::ReviewDismissed => "🚫",
            CommentAction::Unknown => "❓",
        }
    }
}

impl From<ReviewState> for CommentAction {
    fn from(review_state: ReviewState) -> Self {
        match review_state {
            ReviewState::Approved => CommentAction::ReviewApproved,
            ReviewState::ChangesRequested => CommentAction::ReviewChangesRequested,
            ReviewState::Dismissed => CommentAction::ReviewDismissed,
            ReviewState::Commented => CommentAction::Comment,
            _ => CommentAction::Unknown,
        }
    }
}

impl std::fmt::Display for CommentAction {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CommentAction::Comment => write!(f, "comment"),
            CommentAction::ReviewApproved => write!(f, "approved"),
            CommentAction::ReviewChangesRequested => write!(f, "changes requested"),
            CommentAction::ReviewDismissed => write!(f, "dismissed"),
            CommentAction::Unknown => write!(f, "unknown action"),
        }
    }
}
