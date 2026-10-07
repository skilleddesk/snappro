pub mod full;
pub mod region;
pub mod scrolling;
#[cfg(target_os = "linux")]
pub mod wayland_scroll;
pub mod window;

use serde::{Deserialize, Serialize};

/// Generic helper: turn any xcap error (or other Display error) into an anyhow error.
pub(crate) fn r<T, E: std::fmt::Display>(res: Result<T, E>) -> anyhow::Result<T> {
    res.map_err(|e| anyhow::anyhow!(e.to_string()))
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CaptureResult {
    pub id: String,
    pub path: String,
    pub width: u32,
    pub height: u32,
    pub timestamp: i64,
    pub mode: String,
    pub size_bytes: u64,
    pub monitor: String,
    /// True when "Auto save" is off and the file still lives in the temp folder.
    #[serde(default)]
    pub temporary: bool,
}

impl CaptureResult {
    pub fn new(
        id: String,
        path: String,
        width: u32,
        height: u32,
        mode: &str,
        size_bytes: u64,
        monitor: String,
    ) -> Self {
        Self {
            id,
            path,
            width,
            height,
            timestamp: chrono::Utc::now().timestamp_millis(),
            mode: mode.to_string(),
            size_bytes,
            monitor,
            temporary: false,
        }
    }
}