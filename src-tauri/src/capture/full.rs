use std::path::PathBuf;

use image::RgbaImage;
use xcap::Monitor;

use crate::capture::{r, CaptureResult};
use crate::util::{ensure_dir, store_image, timestamp_name};

/// Pick a monitor: `Some(index)` picks by index, `None` picks the primary one.
pub fn select_monitor(index: Option<usize>) -> anyhow::Result<Monitor> {
    let monitors = r(Monitor::all())?;
    if monitors.is_empty() {
        anyhow::bail!("no monitor found");
    }
    if let Some(i) = index {
        if let Some(m) = monitors.get(i) {
            return Ok(m.clone());
        }
    }
    let primary = monitors
        .iter()
        .find(|m| m.is_primary().unwrap_or(false))
        .cloned();
    Ok(primary.unwrap_or_else(|| monitors[0].clone()))
}

pub fn monitor_at(x: i32, y: i32, fallback: Option<usize>) -> anyhow::Result<Monitor> {
    match Monitor::from_point(x, y) {
        Ok(m) => Ok(m),
        Err(_) => select_monitor(fallback),
    }
}

pub fn monitor_label(m: &Monitor) -> String {
    m.friendly_name()
        .or_else(|_| m.name())
        .unwrap_or_else(|_| "display".to_string())
}

/// Union of monitor rectangles, as `(x, y, width, height)`.
///
/// Kept separate from `virtual_bounds` so the arithmetic can be tested without
/// a real display: monitors may sit left of, above or right of the primary
/// one, so the origin can be negative.
pub fn union_bounds(monitors: &[(i32, i32, u32, u32)]) -> Option<(i32, i32, u32, u32)> {
    if monitors.is_empty() {
        return None;
    }
    let mut min_x = i32::MAX;
    let mut min_y = i32::MAX;
    let mut max_x = i32::MIN;
    let mut max_y = i32::MIN;
    for &(x, y, w, h) in monitors {
        min_x = min_x.min(x);
        min_y = min_y.min(y);
        max_x = max_x.max(x + w as i32);
        max_y = max_y.max(y + h as i32);
    }
    if max_x <= min_x || max_y <= min_y {
        return None;
    }
    Some((min_x, min_y, (max_x - min_x) as u32, (max_y - min_y) as u32))
}

/// Bounding box of the whole virtual desktop, in physical pixels.
pub fn virtual_bounds() -> anyhow::Result<(i32, i32, u32, u32)> {
    let monitors = r(Monitor::all())?;
    let rects: Vec<(i32, i32, u32, u32)> = monitors
        .iter()
        .map(|m| {
            (
                m.x().unwrap_or(0),
                m.y().unwrap_or(0),
                m.width().unwrap_or(0),
                m.height().unwrap_or(0),
            )
        })
        .collect();
    union_bounds(&rects).ok_or_else(|| anyhow::anyhow!("display size is unknown"))
}

/// Stitch every monitor into one image, laid out on the virtual desktop grid.
pub fn capture_all_monitors(format: &str, dir: PathBuf) -> anyhow::Result<CaptureResult> {
    let monitors = r(Monitor::all())?;
    if monitors.is_empty() {
        anyhow::bail!("no monitor found");
    }
    let (canvas, _, _) = capture_virtual_raw()?;
    save_rgba(canvas, "AllMonitors", format, dir, "full", "all displays".into())
}

/// Capture the whole screen of the selected monitor and store it as an image file.
pub fn capture_full_screen(index: Option<usize>, format: &str, dir: PathBuf) -> anyhow::Result<CaptureResult> {
    let monitor = select_monitor(index)?;
    let image: RgbaImage = monitor_image(&monitor)?;
    let (id, path, size, width, height) = store_image(&image, &dir, "Screen", format)?;
    Ok(CaptureResult::new(
        id,
        path,
        width,
        height,
        "full",
        size,
        monitor_label(&monitor),
    ))
}

/// Capture a rectangle given in global (virtual desktop) physical coordinates.
pub fn capture_region_global(
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    format: &str,
    dir: PathBuf,
) -> anyhow::Result<CaptureResult> {
    // The rectangle may straddle several monitors, so it is assembled from every
    // display it touches instead of being clamped to the first one.
    let image = capture_rect_raw(x, y, width, height)?;
    let label = monitor_at(x, y, None)
        .map(|m| monitor_label(&m))
        .unwrap_or_else(|_| "display".to_string());
    save_rgba(image, "Region", format, dir, "region", label)
}

/// Intersection of two rectangles `(x, y, w, h)`, or `None` when they do not overlap.
pub fn intersect_rect(
    a: (i32, i32, u32, u32),
    b: (i32, i32, u32, u32),
) -> Option<(i32, i32, u32, u32)> {
    let x0 = a.0.max(b.0);
    let y0 = a.1.max(b.1);
    let x1 = (a.0 + a.2 as i32).min(b.0 + b.2 as i32);
    let y1 = (a.1 + a.3 as i32).min(b.1 + b.3 as i32);
    if x1 <= x0 || y1 <= y0 {
        return None;
    }
    Some((x0, y0, (x1 - x0) as u32, (y1 - y0) as u32))
}

/// Grab an arbitrary rectangle of the virtual desktop (physical pixels, global
/// coordinates), stitching it together from every monitor it overlaps.
pub fn capture_rect_raw(x: i32, y: i32, width: u32, height: u32) -> anyhow::Result<RgbaImage> {
    if width == 0 || height == 0 {
        anyhow::bail!("selected region is empty");
    }
    if let Some(image) = portal_rect((x, y, width, height))? {
        return Ok(image);
    }
    let monitors = r(Monitor::all())?;
    let mut canvas = RgbaImage::new(width, height);
    let mut any = false;
    for m in &monitors {
        let rect = (
            m.x().unwrap_or(0),
            m.y().unwrap_or(0),
            m.width().unwrap_or(0),
            m.height().unwrap_or(0),
        );
        let Some((ix, iy, iw, ih)) = intersect_rect((x, y, width, height), rect) else {
            continue;
        };
        let piece = r(m.capture_region((ix - rect.0) as u32, (iy - rect.1) as u32, iw, ih))?;
        image::imageops::overlay(&mut canvas, &piece, (ix - x) as i64, (iy - y) as i64);
        any = true;
    }
    if !any {
        anyhow::bail!("selected region is outside the display");
    }
    Ok(canvas)
}

/// Snapshot of the whole virtual desktop together with its origin.
pub fn capture_virtual_raw() -> anyhow::Result<(RgbaImage, i32, i32)> {
    let (vx, vy, vw, vh) = virtual_bounds()?;
    Ok((capture_rect_raw(vx, vy, vw, vh)?, vx, vy))
}

pub fn save_rgba(
    image: RgbaImage,
    prefix: &str,
    format: &str,
    dir: PathBuf,
    mode: &str,
    monitor: String,
) -> anyhow::Result<CaptureResult> {
    ensure_dir(&dir)?;
    let (id, path, size, width, height) = store_image(&image, &dir, prefix, format)?;
    Ok(CaptureResult::new(id, path, width, height, mode, size, monitor))
}

/// Capture a region as an in-memory image (no file written) — used by the stitcher.
pub fn capture_region_raw(x: i32, y: i32, width: u32, height: u32) -> anyhow::Result<RgbaImage> {
    capture_rect_raw(x, y, width, height)
}

/// Small helper used by the colour picker: capture a 1x1 pixel at a global point.
pub fn pixel_at(x: i32, y: i32) -> anyhow::Result<(u8, u8, u8, u8)> {
    if let Some(image) = portal_rect((x, y, 1, 1))? {
        let c = image.get_pixel(0, 0).0;
        return Ok((c[0], c[1], c[2], c[3]));
    }
    let monitor = monitor_at(x, y, None)?;
    let rx = (x - monitor.x().unwrap_or(0)).max(0) as u32;
    let ry = (y - monitor.y().unwrap_or(0)).max(0) as u32;
    let image = r(monitor.capture_region(rx, ry, 1, 1))?;
    let px = image.get_pixel(0, 0);
    let c = px.0;
    Ok((c[0], c[1], c[2], c[3]))
}

/// The whole picture of one monitor.
pub fn monitor_image(monitor: &Monitor) -> anyhow::Result<RgbaImage> {
    let rect = (
        monitor.x().unwrap_or(0),
        monitor.y().unwrap_or(0),
        monitor.width().unwrap_or(0),
        monitor.height().unwrap_or(0),
    );
    if let Some(image) = portal_rect(rect)? {
        return Ok(image);
    }
    r(monitor.capture_image())
}

/// Wayland: programs may not read the screen, so one picture of the whole
/// desktop is asked from the desktop portal and `rect` is cut out of it.
/// (xcap asks the portal once per monitor and ignores the monitor's offset,
/// which put the wrong part of the desktop into multi-monitor shots.)
/// `None` everywhere else.
#[cfg(target_os = "linux")]
fn portal_rect(rect: (i32, i32, u32, u32)) -> anyhow::Result<Option<RgbaImage>> {
    if !crate::portal::is_wayland() {
        return Ok(None);
    }
    let desktop = virtual_bounds()?;
    let picture = crate::portal::screenshot(false)?;
    crop_desktop(&picture, desktop, rect).map(Some)
}

#[cfg(not(target_os = "linux"))]
fn portal_rect(_rect: (i32, i32, u32, u32)) -> anyhow::Result<Option<RgbaImage>> {
    Ok(None)
}

/// Cut `rect` (virtual desktop coordinates) out of `picture`, a picture of the
/// whole `desktop` rectangle. The picture may have more pixels than the layout
/// (HiDPI); the result keeps that full resolution.
pub fn crop_desktop(
    picture: &RgbaImage,
    desktop: (i32, i32, u32, u32),
    rect: (i32, i32, u32, u32),
) -> anyhow::Result<RgbaImage> {
    let (dx, dy, dw, dh) = desktop;
    if dw == 0 || dh == 0 || picture.width() == 0 || picture.height() == 0 {
        anyhow::bail!("display size is unknown");
    }
    let Some((ix, iy, iw, ih)) = intersect_rect(rect, desktop) else {
        anyhow::bail!("selected region is outside the display");
    };
    let sx = picture.width() as f64 / dw as f64;
    let sy = picture.height() as f64 / dh as f64;
    let scale = |v: f64, s: f64| (v * s).round().max(0.0) as u32;
    let px = scale((ix - dx) as f64, sx).min(picture.width() - 1);
    let py = scale((iy - dy) as f64, sy).min(picture.height() - 1);
    let pw = scale(iw as f64, sx).clamp(1, picture.width() - px);
    let ph = scale(ih as f64, sy).clamp(1, picture.height() - py);
    let piece = image::imageops::crop_imm(picture, px, py, pw, ph).to_image();
    if (ix, iy, iw, ih) == rect {
        return Ok(piece);
    }
    // Partly off screen: keep the requested size, the missing part stays transparent.
    let mut canvas = RgbaImage::new(scale(rect.2 as f64, sx).max(1), scale(rect.3 as f64, sy).max(1));
    image::imageops::overlay(
        &mut canvas,
        &piece,
        scale((ix - rect.0) as f64, sx) as i64,
        scale((iy - rect.1) as f64, sy) as i64,
    );
    Ok(canvas)
}

pub fn temp_png_name() -> String {
    timestamp_name("temp", "png")
}