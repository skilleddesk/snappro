use std::path::PathBuf;

use serde::Serialize;
use xcap::Window;

use crate::capture::{r, CaptureResult};

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct WindowInfo {
    pub id: u32,
    pub title: String,
    pub app_name: String,
    pub width: u32,
    pub height: u32,
    pub x: i32,
    pub y: i32,
    pub focused: bool,
    pub minimized: bool,
}

fn is_snappro(title: &str) -> bool {
    title.to_lowercase().contains("snappro")
}

/// Screen rectangle of a window, used as the ffmpeg capture area in
/// "record a single window" mode.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct WindowBounds {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub title: String,
}

pub fn list_windows() -> anyhow::Result<Vec<WindowInfo>> {
    let windows = r(Window::all())?;
    let mut out = Vec::new();
    for w in windows {
        let title = w.title().unwrap_or_default();
        if title.trim().is_empty() || is_snappro(&title) {
            continue;
        }
        let minimized = w.is_minimized().unwrap_or(false);
        if minimized {
            continue;
        }
        out.push(WindowInfo {
            id: w.id().unwrap_or(0),
            title,
            app_name: w.app_name().unwrap_or_default(),
            width: w.width().unwrap_or(0),
            height: w.height().unwrap_or(0),
            x: w.x().unwrap_or(0),
            y: w.y().unwrap_or(0),
            focused: w.is_focused().unwrap_or(false),
            minimized,
        });
    }
    Ok(out)
}

/// Capture the currently focused window (falls back to the largest visible window).
pub fn capture_active_window(format: &str, dir: PathBuf, window_id: Option<u32>) -> anyhow::Result<CaptureResult> {
    let windows = r(Window::all())?;
    let mut candidates: Vec<_> = windows
        .into_iter()
        .filter(|w| {
            let title = w.title().unwrap_or_default();
            !title.trim().is_empty() && !is_snappro(&title) && !w.is_minimized().unwrap_or(true)
        })
        .collect();

    if candidates.is_empty() {
        anyhow::bail!("no capturable window found");
    }

    let target_index = if let Some(id) = window_id {
        candidates
            .iter()
            .position(|w| w.id().unwrap_or(0) == id)
            .unwrap_or(0)
    } else {
        candidates
            .iter()
            .position(|w| w.is_focused().unwrap_or(false))
            .unwrap_or_else(|| {
                let mut best = 0usize;
                let mut best_area = 0u64;
                for (i, w) in candidates.iter().enumerate() {
                    let area = w.width().unwrap_or(0) as u64 * w.height().unwrap_or(0) as u64;
                    if area > best_area {
                        best_area = area;
                        best = i;
                    }
                }
                best
            })
    };

    let window = candidates.swap_remove(target_index);
    let title = window.title().unwrap_or_else(|_| "window".to_string());
    let image = r(window.capture_image())?;
    crate::capture::full::save_rgba(image, "Window", format, dir, "window", title)
}

fn find_window(window_id: u32) -> anyhow::Result<xcap::Window> {
    let windows = r(Window::all())?;
    windows
        .into_iter()
        .find(|w| w.id().unwrap_or(0) == window_id)
        .ok_or_else(|| anyhow::anyhow!("window {window_id} is gone"))
}

/// Screen rectangle of a window. Used to record one window as a fixed region.
pub fn window_bounds(window_id: u32) -> anyhow::Result<WindowBounds> {
    let window = find_window(window_id)?;
    let width = window.width().unwrap_or(0);
    let height = window.height().unwrap_or(0);
    if width == 0 || height == 0 {
        anyhow::bail!("that window is minimised or has no size yet");
    }
    Ok(WindowBounds {
        x: window.x().unwrap_or(0),
        y: window.y().unwrap_or(0),
        width,
        height,
        title: window.title().unwrap_or_else(|_| "window".to_string()),
    })
}

/// Grab the live pixels of a window and shrink them to a small temp PNG.
pub fn window_thumbnail(window_id: u32, max_width: u32) -> anyhow::Result<PathBuf> {
    let window = find_window(window_id)?;
    let image = r(window.capture_image())?;
    let (width, height) = (image.width(), image.height());
    if width == 0 || height == 0 {
        anyhow::bail!("that window has nothing to show");
    }
    let scale = (max_width as f32 / width as f32).min(1.0);
    let target_w = ((width as f32 * scale).round() as u32).max(1);
    let target_h = ((height as f32 * scale).round() as u32).max(1);
    let thumb = image::imageops::resize(
        &image,
        target_w,
        target_h,
        image::imageops::FilterType::Triangle,
    );
    let dir = crate::util::thumbs_dir();
    std::fs::create_dir_all(&dir)?;
    let path = dir.join(format!("win-{window_id}.png"));
    thumb.save(&path)?;
    Ok(path)
}