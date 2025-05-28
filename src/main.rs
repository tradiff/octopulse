#![deny(clippy::unwrap_used)]
#![deny(clippy::expect_used)]
#![deny(clippy::panic)]
#![deny(unused_must_use)]

mod avatar_cache;
mod desktop_notifier;
mod github_client;
mod github_notification_poller;
mod models;
mod notification_processor;
mod timestamp_manager;

use crate::github_client::GithubClient;
use crate::github_notification_poller::GithubNotificationPoller;
use std::sync::Arc;
use tokio::task;
use tracing_subscriber::filter::LevelFilter;
use tracing_subscriber::{fmt, prelude::*};

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), octocrab::Error> {
    let (stdout_appender, _guard) = tracing_appender::non_blocking(std::io::stdout());
    let stdout_layer = fmt::Layer::default()
        .with_writer(stdout_appender)
        .with_filter(LevelFilter::DEBUG);
    let file_layer = fmt::Layer::default()
        .with_writer(tracing_appender::rolling::daily("logs", "app.log"))
        .with_filter(LevelFilter::DEBUG);

    tracing_subscriber::registry()
        .with(stdout_layer)
        .with(file_layer)
        .init();

    let token = match std::env::var("GITHUB_TOKEN") {
        Ok(token) => token,
        Err(_) => {
            eprintln!("GITHUB_TOKEN environment variable not set");
            std::process::exit(1);
        }
    };
    let github_client = Arc::new(GithubClient::new(&token)?);

    let poller = GithubNotificationPoller::new(github_client.clone()).await;
    let poller_handle = task::spawn(async move {
        poller.run().await;
    });

    // todo: other things here

    poller_handle.await.ok();
    Ok(())
}
