use chrono::{DateTime, Utc};

pub struct PullRequestDetails {
    pub pr_number: u64,
    pub state: PullRequestState,
    pub comments: Vec<PullRequestComment>,
}

pub struct PullRequestComment {
    pub created_at: Option<DateTime<Utc>>,
    pub user: String,
    pub action: String,
    pub body: String,
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
