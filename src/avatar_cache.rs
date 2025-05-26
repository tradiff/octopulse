use anyhow::Result;
use image::{ImageFormat, ImageReader};
use std::fs;
use std::path::PathBuf;
use std::time::Duration;
use tracing::debug;
use url::Url;

pub struct AvatarCache;

impl AvatarCache {
    const SIZE: u32 = 18;
    const MAX_CACHE_DAYS: u64 = 1;
    const MAX_CACHE_AGE: Duration = Duration::from_secs(Self::MAX_CACHE_DAYS * 24 * 60 * 60);

    pub fn new() -> Self {
        Self {}
    }

    fn get_avatar_local_path(&self, login: &str) -> PathBuf {
        std::env::temp_dir().join(format!("octopulse-avatar-{}-{}.png", login, Self::SIZE))
    }

    pub fn get_avatar_local_uri(&self, login: &str) -> Result<String> {
        let avatar_path = self.get_avatar_local_path(login);
        Self::file_uri_from_path(&avatar_path)
    }

    pub async fn ensure_avatar(&self, login: &str, avatar_url: &str) -> Result<String> {
        let avatar_path = self.get_avatar_local_path(login);

        if avatar_path.exists() {
            if let Ok(metadata) = fs::metadata(&avatar_path) {
                if let Ok(modified) = metadata.modified() {
                    if let Ok(elapsed) = modified.elapsed() {
                        if elapsed < Self::MAX_CACHE_AGE {
                            return self.get_avatar_local_uri(login);
                        }
                    }
                }
            }
        }

        self.download_avatar(&avatar_path, avatar_url).await?;
        self.get_avatar_local_uri(login)
    }

    async fn download_avatar(&self, path: &PathBuf, avatar_url: &str) -> Result<()> {
        let mut url = Url::parse(avatar_url)?;
        url.query_pairs_mut()
            .append_pair("s", &Self::SIZE.to_string());

        debug!("Downloading avatar from: {}", url);
        let resp = reqwest::get(url.as_str()).await?;
        let bytes = resp.bytes().await?;

        let img = ImageReader::new(std::io::Cursor::new(bytes))
            .with_guessed_format()?
            .decode()?
            .resize(
                Self::SIZE,
                Self::SIZE,
                image::imageops::FilterType::Lanczos3,
            );

        let mut file_writer = std::fs::File::create(path)?;
        img.write_to(&mut file_writer, ImageFormat::Png)?;

        Ok(())
    }

    fn file_uri_from_path(path: &PathBuf) -> Result<String> {
        Url::from_file_path(path)
            .map(|url| url.to_string())
            .map_err(|_| anyhow::anyhow!("Failed to create file uri for path: {}", path.display()))
    }
}
