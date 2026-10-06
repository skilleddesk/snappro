use std::path::PathBuf;
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};

use crate::capture::CaptureResult;
use crate::recorder::{RecordOptions, RecordingStatus, RegionRect};

pub static LAST_CAPTURE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Set by the Esc shortcut while a scrolling capture is running.
static SCROLL_STOP: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Path the editor window should show.
///
/// The window is a separate webview: when it is opened for the first time its
/// listener is not registered yet, so a one-shot event can be missed and the
/// window would sit on "Waiting for an image". Storing the path here lets the
/// window ask for it when it is ready, which makes opening reliable.
pub static PENDING_EDITOR_PATH: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);

/// Last capture, so a freshly opened preview window can ask for it instead of
/// relying on an event it may not have been listening for yet.
pub static LAST_CAPTURE_RESULT: std::sync::Mutex<Option<CaptureResult>> =
    std::sync::Mutex::new(None);

#[tauri::command]
pub fn last_capture() -> Option<CaptureResult> {
    LAST_CAPTURE_RESULT.lock().ok().and_then(|c| c.clone())
}

#[tauri::command]
pub fn pending_editor_path() -> Option<String> {
    PENDING_EDITOR_PATH.lock().ok().and_then(|p| p.clone())
}

/// Information about the screen snapshot used by the region selector overlay.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SelectorInfo {
    pub path: String,
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub scale: f64,
    pub monitor: String,
    pub mode: String,
    /// Whether the main window was on screen before the selector opened, so it is
    /// brought back only then (a hotkey capture from the tray must not pop it up).
    #[serde(default)]
    pub restore_main: bool,
}

/// Index of the monitor the mouse pointer is on (physical pixels, like xcap).
fn cursor_monitor_index(app: &AppHandle) -> Option<usize> {
    let pos = app.cursor_position().ok()?;
    let monitors = xcap::Monitor::all().ok()?;
    monitors.iter().position(|m| {
        let (x, y) = (m.x().unwrap_or(0) as f64, m.y().unwrap_or(0) as f64);
        let (w, h) = (m.width().unwrap_or(0) as f64, m.height().unwrap_or(0) as f64);
        pos.x >= x && pos.y >= y && pos.x < x + w && pos.y < y + h
    })
}

/// The session info plus the frozen picture of the desktop it was built from. Region
/// captures are cut out of that picture: grabbing the live screen again while the
/// overlay was still fading out put a ghost copy of the overlay into the result.
pub struct SelectorState(
    pub std::sync::Mutex<Option<SelectorInfo>>,
    pub std::sync::Mutex<Option<image::RgbaImage>>,
);

impl Default for SelectorState {
    fn default() -> Self {
        Self(std::sync::Mutex::new(None), std::sync::Mutex::new(None))
    }
}

#[tauri::command]
pub fn region_backdrop_info(state: tauri::State<'_, SelectorState>) -> Result<SelectorInfo, String> {
    state
        .0
        .lock()
        .unwrap()
        .clone()
        .ok_or_else(|| "no region session is active".to_string())
}

fn dir_from(settings: &crate::settings::Settings) -> PathBuf {
    PathBuf::from(&settings.save_dir)
}

/// Where recordings go (falls back to the picture folder).
fn video_dir_from(settings: &crate::settings::Settings) -> PathBuf {
    if settings.video_dir.trim().is_empty() {
        dir_from(settings)
    } else {
        PathBuf::from(&settings.video_dir)
    }
}

/// Where PDFs and exported copies go (falls back to the picture folder).
fn export_dir_from(settings: &crate::settings::Settings) -> PathBuf {
    if settings.export_dir.trim().is_empty() {
        dir_from(settings)
    } else {
        PathBuf::from(&settings.export_dir)
    }
}

/// Where a fresh capture is written: the library folder, or a temp folder when
/// "Auto save" is off (the preview then offers an explicit Save).
fn capture_dir(settings: &crate::settings::Settings) -> PathBuf {
    if settings.auto_save {
        dir_from(settings)
    } else {
        crate::util::temp_capture_dir()
    }
}

fn emit(app: &AppHandle, event: &str, payload: impl Serialize + Clone) {
    let _ = app.emit(event, payload);
}

fn show_window(app: &AppHandle, label: &str) {
    if let Some(window) = app.get_webview_window(label) {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// Bring a window back without stealing focus from whatever the user is doing.
///
/// Capture used to call `show_window` afterwards, which raised and focused the
/// main window on top of the app being photographed - it looked as if taking a
/// screenshot jumped the app back to its default page.
fn show_window_passive(app: &AppHandle, label: &str) {
    if let Some(window) = app.get_webview_window(label) {
        let _ = window.show();
    }
}

fn hide_window(app: &AppHandle, label: &str) {
    if let Some(window) = app.get_webview_window(label) {
        let _ = window.hide();
    }
}

fn hide_main(app: &AppHandle) {
    // Give the compositor a moment so SnapPro itself is not in the shot.
    std::thread::sleep(std::time::Duration::from_millis(90));
    hide_window(app, "main");
    std::thread::sleep(std::time::Duration::from_millis(170));
}

fn window_visible(app: &AppHandle, label: &str) -> bool {
    app.get_webview_window(label)
        .and_then(|window| window.is_visible().ok())
        .unwrap_or(false)
}

/// Hide the main window for the shot and report whether it *was* visible, so the
/// capture flow can put it back afterwards. Without this the window stayed
/// hidden for good and a capture looked like it did nothing at all.
fn hide_main_tracked(app: &AppHandle) -> bool {
    let was_visible = window_visible(app, "main");
    hide_main(app);
    was_visible
}

fn restore_main(app: &AppHandle, was_visible: bool) {
    if was_visible {
        show_window_passive(app, "main");
    }
}

fn after_capture(app: &AppHandle, result: &CaptureResult) -> CaptureResult {
    let settings = crate::settings::load(app);
    let mut result = result.clone();
    result.temporary = !settings.auto_save;

    if settings.auto_copy {
        if let Ok(url) = crate::imageio::read_data_url(std::path::Path::new(&result.path)) {
            let _ = crate::clipboard::write_image(app, &url);
        }
    }

    // "AI OCR caption": read the text out of the screenshot and add it to the
    // file name so captures become searchable.
    if settings.auto_ocr_caption {
        if let Ok(ocr) = crate::ocr::ocr_image(std::path::Path::new(&result.path), "eng") {
            if let Some(name) = caption_from_text(&ocr.text) {
                let source = PathBuf::from(&result.path);
                if let Ok(renamed) = crate::history::rename(&source, &format!("{} - {}", name, timestamp_suffix())) {
                    result.path = renamed.to_string_lossy().to_string();
                }
                let _ = crate::clipboard::write_text(app, &ocr.text);
            }
        }
    }

    if settings.play_sound {
        crate::feedback::capture_done(app, "Screenshot saved");
    }
    emit(app, "capture://complete", result.clone());
    if let Ok(mut last) = LAST_CAPTURE_RESULT.lock() {
        *last = Some(result.clone());
    }
    if settings.open_preview {
        place_preview(app);
        show_window_passive(app, "preview");
        emit(app, "preview://image", result.clone());
    }
    result
}

/// Centre the recorder bar at the top of the primary display, out of the way.
fn place_recorder(app: &AppHandle) {
    let Some(window) = app.get_webview_window("recorder") else {
        return;
    };
    // On the display the pointer is on, so with two screens it opens where you are working.
    let under_cursor = app.cursor_position().ok().and_then(|pos| {
        app.available_monitors().ok()?.into_iter().find(|m| {
            let p = m.position();
            let s = m.size();
            pos.x >= p.x as f64 && pos.y >= p.y as f64 && pos.x < (p.x + s.width as i32) as f64 && pos.y < (p.y + s.height as i32) as f64
        })
    });
    let Some(monitor) = under_cursor.or_else(|| app.primary_monitor().ok().flatten()) else {
        return;
    };
    let Ok(size) = window.outer_size() else {
        return;
    };
    let x = monitor.position().x + (monitor.size().width as i32 - size.width as i32) / 2;
    let y = monitor.position().y + (12.0 * monitor.scale_factor()) as i32;
    let _ = window.set_position(tauri::PhysicalPosition::new(x, y));
}

/// Park the preview in the bottom-right corner of the primary display, where it
/// does not cover what was just captured.
fn place_preview(app: &AppHandle) {
    let Some(window) = app.get_webview_window("preview") else {
        return;
    };
    let Ok(Some(monitor)) = app.primary_monitor() else {
        return;
    };
    let Ok(size) = window.outer_size() else {
        return;
    };
    let margin = (24.0 * monitor.scale_factor()) as i32;
    let x = monitor.position().x + monitor.size().width as i32 - size.width as i32 - margin;
    let y = monitor.position().y + monitor.size().height as i32 - size.height as i32 - margin * 2;
    let _ = window.set_position(tauri::PhysicalPosition::new(x.max(0), y.max(0)));
}

/// Map the stored `monitor` setting onto a monitor index for xcap.
fn resolve_monitor(settings: &crate::settings::Settings, fallback: Option<usize>) -> Option<usize> {
    match settings.monitor.as_str() {
        "primary" | "" => fallback,
        other => other.parse::<usize>().ok().or(fallback),
    }
}

/// Turn recognised text into a short, file-name friendly caption.
fn caption_from_text(text: &str) -> Option<String> {
    let line = text
        .lines()
        .map(|l| l.trim())
        .find(|l| l.chars().filter(|c| c.is_alphanumeric()).count() >= 3)?;
    let cleaned: String = line
        .chars()
        .filter(|c| c.is_alphanumeric() || *c == ' ' || *c == '-' || *c == '_')
        .collect();
    let trimmed = cleaned.trim();
    if trimmed.is_empty() {
        return None;
    }
    Some(trimmed.chars().take(48).collect())
}

fn timestamp_suffix() -> String {
    chrono::Local::now().format("%Y-%m-%d_%H-%M-%S").to_string()
}

// ---------------------------------------------------------------------------
// Capture commands
// ---------------------------------------------------------------------------

/// Capture every display at once, stitched on the virtual desktop grid.
#[tauri::command]
pub async fn capture_all_monitors(app: AppHandle) -> Result<CaptureResult, String> {
    let settings = crate::settings::load(&app);
    let dir = capture_dir(&settings);
    let format = settings.format.clone();
    let was_visible = hide_main_tracked(&app);

    let outcome = tauri::async_runtime::spawn_blocking(move || {
        crate::capture::full::capture_all_monitors(&format, dir)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string());

    restore_main(&app, was_visible);
    let result = outcome?;

    Ok(after_capture(&app, &result))
}

#[tauri::command]
pub async fn capture_full_screen(app: AppHandle, monitor: Option<usize>) -> Result<CaptureResult, String> {
    let settings = crate::settings::load(&app);
    let dir = capture_dir(&settings);
    let format = settings.format.clone();
    // An explicit monitor from the UI wins; otherwise the Settings choice is
    // used, and only then the primary display.
    let index = monitor.or_else(|| resolve_monitor(&settings, None));
    let was_visible = hide_main_tracked(&app);

    let outcome = tauri::async_runtime::spawn_blocking(move || {
        crate::capture::full::capture_full_screen(index, &format, dir)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string());

    restore_main(&app, was_visible);
    let result = outcome?;

    Ok(after_capture(&app, &result))
}

/// Cut a rectangle (global physical pixels) out of the frozen desktop picture of the
/// current selector session, when it holds one that fully contains the rectangle.
fn crop_from_backdrop(app: &AppHandle, x: i32, y: i32, w: u32, h: u32) -> Option<image::RgbaImage> {
    let state = app.try_state::<SelectorState>()?;
    let info = state.0.lock().ok()?.clone()?;
    let guard = state.1.lock().ok()?;
    let picture = guard.as_ref()?;
    let lx = x - info.x;
    let ly = y - info.y;
    if lx < 0 || ly < 0 || w == 0 || h == 0 {
        return None;
    }
    if lx as u32 + w > picture.width() || ly as u32 + h > picture.height() {
        return None;
    }
    Some(image::imageops::crop_imm(picture, lx as u32, ly as u32, w, h).to_image())
}

#[tauri::command]
pub async fn capture_region(
    app: AppHandle,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
) -> Result<CaptureResult, String> {
    let settings = crate::settings::load(&app);
    let dir = capture_dir(&settings);
    let format = settings.format.clone();
    hide_window(&app, "region");
    let handle = app.clone();
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        if let Some(shot) = crop_from_backdrop(&handle, x, y, width, height) {
            return crate::capture::full::save_rgba(shot, "Region", &format, dir, "region", "region".into());
        }
        // No frozen picture (a direct call): wait for the overlay to be gone, then grab the screen.
        std::thread::sleep(std::time::Duration::from_millis(260));
        crate::capture::full::capture_region_global(x, y, width, height, &format, dir)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string());

    let result = outcome?;
    Ok(after_capture(&app, &result))
}

#[tauri::command]
pub async fn capture_freehand(app: AppHandle, points: Vec<(f32, f32)>) -> Result<CaptureResult, String> {
    let settings = crate::settings::load(&app);
    let dir = capture_dir(&settings);
    let format = settings.format.clone();
    hide_window(&app, "region");

    // The overlay session knows which part of the desktop it covered; the
    // points are in global coordinates relative to that area.
    let handle = app.clone();
    let area = app
        .try_state::<SelectorState>()
        .and_then(|state| state.0.lock().ok().and_then(|info| info.clone()));
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        let (ox, oy, w, h) = match area {
            Some(info) => (info.x, info.y, info.width, info.height),
            None => crate::capture::full::virtual_bounds()?,
        };
        let frozen = handle
            .try_state::<SelectorState>()
            .and_then(|state| state.1.lock().ok().and_then(|guard| guard.clone()));
        let backdrop = match frozen {
            Some(picture) if picture.width() == w && picture.height() == h => picture,
            _ => {
                std::thread::sleep(std::time::Duration::from_millis(260));
                crate::capture::full::capture_rect_raw(ox, oy, w, h)?
            }
        };
        let local: Vec<(f32, f32)> = points
            .iter()
            .map(|(x, y)| (x - ox as f32, y - oy as f32))
            .collect();
        let image = crate::capture::region::crop_freehand(&backdrop, &local)?;
        crate::capture::full::save_rgba(image, "Region", &format, dir, "freehand", "freehand".into())
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string());

    let result = outcome?;
    Ok(after_capture(&app, &result))
}

#[tauri::command]
pub async fn capture_window(app: AppHandle, window_id: Option<u32>) -> Result<CaptureResult, String> {
    let settings = crate::settings::load(&app);
    let dir = capture_dir(&settings);
    let format = settings.format.clone();
    let was_visible = hide_main_tracked(&app);

    let outcome = tauri::async_runtime::spawn_blocking(move || {
        crate::capture::window::capture_active_window(&format, dir, window_id)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string());

    restore_main(&app, was_visible);
    let result = outcome?;

    Ok(after_capture(&app, &result))
}

#[tauri::command]
pub async fn capture_scrolling(
    app: AppHandle,
    x: i32,
    y: i32,
    width: u32,
    height: u32,
    max_frames: Option<u32>,
    scroll_amount: Option<i32>,
    delay_ms: Option<u64>,
) -> Result<CaptureResult, String> {
    let settings = crate::settings::load(&app);
    let dir = capture_dir(&settings);
    let format = settings.format.clone();

    // The overlay must not swallow the wheel events we synthesise, but hiding it
    // left the user staring at their desktop with no idea anything was running.
    // Making it click-through keeps the progress readout visible instead.
    if let Some(window) = app.get_webview_window("region") {
        let _ = window.set_ignore_cursor_events(true);
    }
    emit(&app, "scrolling://started", ());
    // Give the overlay time to clear its frozen backdrop: anything it still draws
    // over the region would end up in every captured frame.
    std::thread::sleep(std::time::Duration::from_millis(450));

    // Esc ends the capture early and keeps the frames collected so far.
    SCROLL_STOP.store(false, std::sync::atomic::Ordering::SeqCst);
    #[cfg(desktop)]
    {
        use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
        let _ = app.global_shortcut().on_shortcut("Escape", |_app, _sc, event| {
            if event.state() == ShortcutState::Pressed {
                SCROLL_STOP.store(true, std::sync::atomic::Ordering::SeqCst);
            }
        });
    }

    // Live progress for the panel: scrolling capture can take a while and a
    // frozen looking UI made people think it had hung.
    let progress_app = app.clone();
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        let report = |done: u32, total: u32| {
            emit(&progress_app, "scrolling://progress", serde_json::json!({ "done": done, "total": total }));
        };
        crate::capture::scrolling::capture_scrolling(
            x,
            y,
            width,
            height,
            max_frames.unwrap_or(60),
            scroll_amount.unwrap_or(0),
            delay_ms.unwrap_or(350),
            &format,
            dir,
            Some(&report),
            Some(&|| SCROLL_STOP.load(std::sync::atomic::Ordering::SeqCst)),
        )
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string());

    #[cfg(desktop)]
    {
        let settings = crate::settings::load(&app);
        let _ = crate::settings::apply_shortcuts(&app, &settings);
    }
    // Put the overlay back to normal and close it before showing the main window.
    if let Some(window) = app.get_webview_window("region") {
        let _ = window.set_ignore_cursor_events(false);
    }
    hide_window(&app, "region");
    if selector_restores_main(&app) {
        show_window_passive(&app, "main");
    }
    let result = outcome?;
    Ok(after_capture(&app, &result))
}

/// Capture with a countdown, letting the user prepare their screen first.
#[tauri::command]
pub async fn capture_delayed(app: AppHandle, seconds: Option<u64>) -> Result<CaptureResult, String> {
    let settings = crate::settings::load(&app);
    let delay = seconds.unwrap_or(settings.delay_secs).clamp(1, 60);
    // The countdown runs with the window still visible so it can show the
    // remaining seconds; it is hidden only just before the shot.
    tauri::async_runtime::spawn_blocking(move || {
        std::thread::sleep(std::time::Duration::from_secs(delay));
    })
    .await
    .map_err(|e| e.to_string())?;

    let dir = capture_dir(&settings);
    let format = settings.format.clone();
    let index = resolve_monitor(&settings, None);
    let was_visible = hide_main_tracked(&app);
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        crate::capture::full::capture_full_screen(index, &format, dir)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string());

    restore_main(&app, was_visible);
    let result = outcome?;

    Ok(after_capture(&app, &result))
}

/// Open the region selection overlay: grabs the desktop, shows it full screen
/// and lets the user drag the area with the mouse. `mode` is "region",
/// "scrolling" or "freehand" and is carried in the selector info so the overlay
/// knows which tool to arm (it runs in its own webview, with its own store).
#[tauri::command]
pub async fn start_region_selector(
    app: AppHandle,
    mode: Option<String>,
    monitor: Option<usize>,
    all: Option<bool>,
) -> Result<(), String> {
    // With several displays the selector opens on the one the pointer is on; the
    // buttons in its bar switch to another display or to all of them.
    let monitor = match monitor {
        Some(index) => Some(index),
        None if all.unwrap_or(false) => None,
        None => cursor_monitor_index(&app).filter(|_| xcap::Monitor::all().map(|m| m.len() > 1).unwrap_or(false)),
    };
    // SnapPro's own windows must not be in the frozen picture, so they go first.
    let restore_main = window_visible(&app, "main");
    let had_windows = restore_main || window_visible(&app, "preview") || window_visible(&app, "recorder");
    hide_window(&app, "main");
    hide_window(&app, "preview");
    hide_window(&app, "recorder");
    // Switching display reopens the selector: its own window must not be photographed either.
    let overlay_was_up = window_visible(&app, "region");
    hide_window(&app, "region");
    let had_windows = had_windows || overlay_was_up;
    if had_windows {
        std::thread::sleep(std::time::Duration::from_millis(220));
    }

    let snapshot = tauri::async_runtime::spawn_blocking(move || {
        crate::capture::region::overlay_backdrop(monitor)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())?;

    let (image, monitor_label, ox, oy, width, height) = snapshot;
    let dir = crate::util::session_dir();
    crate::util::ensure_dir(&dir).map_err(|e| e.to_string())?;
    let backdrop_path = dir.join("overlay.png");
    image.save(&backdrop_path).map_err(|e| e.to_string())?;
    if let Some(state) = app.try_state::<SelectorState>() {
        if let Ok(mut frozen) = state.1.lock() {
            *frozen = if mode.as_deref() == Some("scrolling") { None } else { Some(image) };
        }
    }

    let Some(window) = app.get_webview_window("region") else {
        return Err("region window is missing".into());
    };
    // A virtual-desktop overlay spans every monitor, so it is placed over the
    // union of all screens and sized to match - not just the primary display.
    let bounds = if monitor.is_none() {
        crate::capture::full::virtual_bounds().unwrap_or((ox, oy, width, height))
    } else {
        (ox, oy, width, height)
    };
    let (vx, vy, vw, vh) = bounds;
    let _ = window.set_position(tauri::PhysicalPosition::new(vx, vy));
    let _ = window.set_size(tauri::PhysicalSize::new(vw, vh));
    window.show().map_err(|e| e.to_string())?;
    let _ = window.set_focus();

    let scale = window.scale_factor().unwrap_or(1.0);
    let info = SelectorInfo {
        path: backdrop_path.to_string_lossy().to_string(),
        x: vx,
        y: vy,
        width: vw,
        height: vh,
        scale,
        monitor: monitor_label.clone(),
        mode: mode.unwrap_or_else(|| "region".into()),
        restore_main,
    };
    if let Some(state) = app.try_state::<SelectorState>() {
        *state.0.lock().unwrap() = Some(info.clone());
    }

    emit(&app, "region://backdrop", info);
    Ok(())
}

#[tauri::command]
pub fn cancel_region_selector(app: AppHandle) {
    hide_window(&app, "region");
    if let Some(state) = app.try_state::<SelectorState>() {
        if let Ok(mut frozen) = state.1.lock() {
            *frozen = None;
        }
    }
    // Recorder selections go back to the recorder bar, everything else to the main window.
    let recorder_mode = app
        .try_state::<SelectorState>()
        .and_then(|state| state.0.lock().ok().and_then(|info| info.as_ref().map(|i| i.mode.starts_with("rec"))))
        .unwrap_or(false);
    if recorder_mode {
        place_recorder(&app);
        show_window(&app, "recorder");
    } else if selector_restores_main(&app) {
        show_window_passive(&app, "main");
    }
}

fn selector_restores_main(app: &AppHandle) -> bool {
    app.try_state::<SelectorState>()
        .and_then(|state| state.0.lock().ok().and_then(|info| info.as_ref().map(|i| i.restore_main)))
        .unwrap_or(true)
}

#[tauri::command]
pub fn list_windows() -> Result<Vec<crate::capture::window::WindowInfo>, String> {
    crate::capture::window::list_windows().map_err(|e| e.to_string())
}

/// Small JPEG thumbnail of a window, as a data URL.
///
/// The recorder source picker shows these so people can see *which* window they
/// are about to record instead of guessing from a title.
#[tauri::command]
pub async fn window_thumbnail(window_id: u32, max_width: Option<u32>) -> Result<String, String> {
    let width = max_width.unwrap_or(320).clamp(80, 900);
    let path = tauri::async_runtime::spawn_blocking(move || {
        crate::capture::window::window_thumbnail(window_id, width)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())?;
    crate::imageio::read_data_url(&path).map_err(|e| e.to_string())
}

/// Rect (x, y, width, height) of a window in screen coordinates.
///
/// Recording a single window as a fixed region is far more reliable than asking
/// ffmpeg to match a title: titles change, several windows share one, and
/// `gdigrab title=` silently records the whole desktop when it fails.
#[tauri::command]
pub fn window_bounds(window_id: u32) -> Result<crate::capture::window::WindowBounds, String> {
    crate::capture::window::window_bounds(window_id).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Recording commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn list_devices() -> crate::recorder::Devices {
    crate::recorder::list_devices()
}

#[tauri::command]
pub fn recording_status(state: tauri::State<'_, crate::recorder::RecorderState>) -> RecordingStatus {
    let inner = state.inner.lock().unwrap();
    inner.status()
}

fn segment_path(ext: &str) -> Result<PathBuf, String> {
    let dir = crate::util::temp_capture_dir().join("segments");
    crate::util::ensure_dir(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join(crate::util::timestamp_name("SnapPro_segment", ext)))
}

fn normalise_format(format: &str) -> &'static str {
    match format {
        "gif" => "gif",
        "mkv" => "mkv",
        _ => "mp4",
    }
}

fn is_blank(value: &Option<String>) -> bool {
    value.as_deref().map_or(true, |d| d.trim().is_empty())
}

/// Turn UI-level options into something ffmpeg can act on: resolve the chosen
/// display into a rectangle, fill in default devices and fix up coordinates.
fn prepare_options(mut options: RecordOptions) -> Result<RecordOptions, String> {
    options.format = normalise_format(&options.format).to_string();

    #[cfg(not(target_os = "macos"))]
    if options.mode == "screen" && options.region.is_none() {
        // gdigrab/x11grab capture the whole virtual desktop unless told otherwise,
        // so "Display 2" has to become that display's rectangle.
        if let Ok(monitors) = xcap::Monitor::all() {
            if monitors.len() > 1 {
                let chosen = options
                    .monitor
                    .and_then(|i| monitors.get(i))
                    .or_else(|| monitors.iter().find(|m| m.is_primary().unwrap_or(false)));
                if let Some(m) = chosen {
                    options.region = Some(RegionRect {
                        x: m.x().unwrap_or(0),
                        y: m.y().unwrap_or(0),
                        width: m.width().unwrap_or(0),
                        height: m.height().unwrap_or(0),
                    });
                }
            }
        }
    }

    #[cfg(target_os = "macos")]
    if let Some(region) = options.region.clone().filter(|r| r.width > 0 && r.height > 0) {
        // avfoundation captures one screen in pixels: make the region relative
        // to that screen and scale points to Retina pixels.
        if let Ok(monitors) = xcap::Monitor::all() {
            let index = monitors.iter().position(|m| {
                let (mx, my) = (m.x().unwrap_or(0), m.y().unwrap_or(0));
                let (mw, mh) = (m.width().unwrap_or(0) as i32, m.height().unwrap_or(0) as i32);
                region.x >= mx && region.y >= my && region.x < mx + mw && region.y < my + mh
            });
            if let Some(i) = index {
                let m = &monitors[i];
                let scale = m.scale_factor().unwrap_or(1.0) as f64;
                options.monitor = Some(i);
                options.region = Some(RegionRect {
                    x: ((region.x - m.x().unwrap_or(0)) as f64 * scale) as i32,
                    y: ((region.y - m.y().unwrap_or(0)) as f64 * scale) as i32,
                    width: (region.width as f64 * scale) as u32,
                    height: (region.height as f64 * scale) as u32,
                });
            }
        }
    }

    let needs_mic = options.audio && is_blank(&options.audio_device);
    let needs_cam = options.webcam && is_blank(&options.camera_device);
    let needs_system = options.system_audio && is_blank(&options.system_audio_device);
    if needs_mic || needs_cam || needs_system {
        let devices = crate::recorder::list_devices();
        if needs_system {
            options.system_audio_device = Some(devices.loopback.first().cloned().ok_or_else(|| {
                "No system-sound source was found. On Windows enable \"Stereo Mix\" (Sound settings > Recording), on macOS install BlackHole, on Linux use a PulseAudio monitor. Or turn system sound off.".to_string()
            })?);
        }
        if needs_mic {
            options.audio_device = Some(devices.microphones.first().cloned().ok_or_else(|| {
                "No microphone was found. Plug one in or turn the microphone off.".to_string()
            })?);
        }
        if needs_cam {
            options.camera_device = Some(devices.cameras.first().cloned().ok_or_else(|| {
                "No camera was found. Plug one in or turn the camera off.".to_string()
            })?);
        }
    }
    Ok(options)
}

#[tauri::command]
pub async fn start_recording(
    app: AppHandle,
    state: tauri::State<'_, crate::recorder::RecorderState>,
    options: RecordOptions,
) -> Result<RecordingStatus, String> {
    {
        let mut inner = state.inner.lock().unwrap();
        if inner.is_active() {
            return Err("A recording is already in progress".into());
        }
        // Claimed before the slow part so a double click cannot start two takes.
        inner.starting = true;
    }

    let outcome = start_recording_inner(&app, &state, options).await;
    if outcome.is_err() {
        state.inner.lock().unwrap().starting = false;
    }
    outcome
}

async fn start_recording_inner(
    app: &AppHandle,
    state: &tauri::State<'_, crate::recorder::RecorderState>,
    options: RecordOptions,
) -> Result<RecordingStatus, String> {
    let settings = crate::settings::load(app);
    let dir = video_dir_from(&settings);
    crate::util::ensure_dir(&dir).map_err(|e| format!("Cannot use the video folder {}: {e}", dir.display()))?;

    let options = prepare_options(options)?;
    // Get our own windows out of the picture before the first frame is grabbed.
    hide_window(app, "main");
    hide_window(app, "region");
    std::thread::sleep(std::time::Duration::from_millis(300));
    let final_output = dir.join(crate::util::timestamp_name("SnapPro_Recording", &options.format));
    // Always record to Matroska first: it survives a crash or a forced stop, and
    // is remuxed into MP4 (or converted to GIF) when the take ends.
    let segment = segment_path("mkv")?;

    let opts = options.clone();
    let segment_clone = segment.clone();
    let child = tauri::async_runtime::spawn_blocking(move || {
        crate::recorder::spawn_recording(&segment_clone, &opts)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())?;

    {
        let mut inner = state.inner.lock().unwrap();
        inner.child = Some(child);
        inner.active_segment = Some(segment);
        inner.segments.clear();
        inner.final_output = Some(final_output);
        inner.started_at = Some(chrono::Utc::now().timestamp_millis());
        inner.paused = false;
        inner.starting = false;
        inner.accumulated_ms = 0;
        inner.format = options.format.clone();
        inner.options = Some(options);
    }

    hide_window(app, "main");
    let status = state.inner.lock().unwrap().status();
    show_window(app, "recorder");
    emit(app, "recording://started", status.clone());
    Ok(status)
}

#[tauri::command]
pub async fn pause_recording(
    app: AppHandle,
    state: tauri::State<'_, crate::recorder::RecorderState>,
) -> Result<RecordingStatus, String> {
    let child = {
        let mut inner = state.inner.lock().unwrap();
        if inner.started_at.is_none() && !inner.paused {
            return Err("not recording".into());
        }
        if inner.paused {
            return Ok(inner.status());
        }
        // Remember how long we recorded, then close the running segment.
        let elapsed = inner.elapsed_ms();
        inner.accumulated_ms = elapsed;
        inner.paused = true;
        inner.started_at = None;
        inner.child.take()
    };

    // Stopping ffmpeg needs to wait for it to flush the file, so do it off-thread.
    if let Some(mut child) = child {
        tauri::async_runtime::spawn_blocking(move || {
            let _ = crate::recorder::stop_child(&mut child);
        })
        .await
        .map_err(|e| e.to_string())?;
    }

    {
        let mut inner = state.inner.lock().unwrap();
        if let Some(active) = inner.active_segment.take() {
            if active.exists() {
                inner.segments.push(active);
            }
        }
    }

    let status = state.inner.lock().unwrap().status();
    emit(&app, "recording://paused", status.clone());
    Ok(status)
}

#[tauri::command]
pub async fn resume_recording(
    app: AppHandle,
    state: tauri::State<'_, crate::recorder::RecorderState>,
) -> Result<RecordingStatus, String> {
    let (segment, opts) = {
        let inner = state.inner.lock().unwrap();
        if !inner.paused {
            return if inner.started_at.is_some() {
                Ok(inner.status())
            } else {
                Err("not recording".into())
            };
        }
        (segment_path("mkv")?, inner.options.clone().unwrap_or_default())
    };

    let segment_clone = segment.clone();
    let child = tauri::async_runtime::spawn_blocking(move || {
        crate::recorder::spawn_recording(&segment_clone, &opts)
    })
    .await
    .map_err(|e| e.to_string())?
    // Still paused if ffmpeg could not start again, so nothing is lost.
    .map_err(|e| e.to_string())?;

    {
        let mut inner = state.inner.lock().unwrap();
        inner.child = Some(child);
        inner.active_segment = Some(segment);
        inner.paused = false;
        inner.started_at = Some(chrono::Utc::now().timestamp_millis());
    }

    let status = state.inner.lock().unwrap().status();
    emit(&app, "recording://resumed", status.clone());
    Ok(status)
}

#[tauri::command]
pub async fn stop_recording(
    app: AppHandle,
    state: tauri::State<'_, crate::recorder::RecorderState>,
) -> Result<RecordingStatus, String> {
    let (child, output, format, fps, options) = {
        let mut inner = state.inner.lock().unwrap();
        if !inner.is_active() {
            return Err("not recording".into());
        }
        let output = inner
            .final_output
            .clone()
            .ok_or_else(|| "no output file".to_string())?;
        let fps = inner.options.as_ref().map(|o| o.fps).unwrap_or(30);
        inner.paused = false;
        inner.started_at = None;
        (inner.child.take(), output, inner.format.clone(), fps, inner.options.clone().unwrap_or_default())
    };

    // Close the running ffmpeg segment on a worker thread: it needs a moment to flush.
    if let Some(mut child) = child {
        tauri::async_runtime::spawn_blocking(move || {
            let _ = crate::recorder::stop_child(&mut child);
        })
        .await
        .map_err(|e| e.to_string())?;
    }

    let segments = {
        let mut inner = state.inner.lock().unwrap();
        let mut segments = std::mem::take(&mut inner.segments);
        if let Some(active) = inner.active_segment.take() {
            if active.exists() {
                segments.push(active);
            }
        }
        inner.accumulated_ms = 0;
        inner.final_output = None;
        inner.options = None;
        segments
    };

    let output_clone = output.clone();
    let format_clone = format.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        // Lay the camera pictures over the screen, then join the pieces.
        let segments = crate::recorder::compose_cameras(&segments, &options);
        crate::recorder::finalize_recording(&segments, &output_clone, &format_clone, fps)
    })
    .await
    .map_err(|e| e.to_string())?;

    hide_window(&app, "recorder");
    show_window_passive(&app, "main");
    let final_path = match result {
        Ok(path) => path,
        Err(err) => {
            crate::settings::log_line(&format!("finishing the recording failed: {}", err));
            return Err(err.to_string());
        }
    };

    let size = std::fs::metadata(&final_path).map(|m| m.len()).unwrap_or(0);
    emit(
        &app,
        "recording://stopped",
        serde_json::json!({
            "id": uuid::Uuid::new_v4().to_string(),
            "path": final_path.to_string_lossy(),
            "sizeBytes": size,
            "format": format,
        }),
    );
    emit(&app, "library://changed", serde_json::json!({}));
    Ok(RecordingStatus {
        recording: false,
        paused: false,
        started_at: None,
        output: Some(final_path.to_string_lossy().to_string()),
        elapsed_ms: 0,
        segments: 0,
        format,
        source: None,
        quality: None,
    })
}

// ---------------------------------------------------------------------------
// Editing / exporting
// ---------------------------------------------------------------------------

/// Composite the flattened canvas over a copy of the original file.
/// The browser sends the final flattened image; we write it where asked.
#[tauri::command]
pub fn save_edited_image(
    app: AppHandle,
    data_url: String,
    _source: Option<String>,
    target_path: Option<String>,
) -> Result<serde_json::Value, String> {
    let settings = crate::settings::load(&app);
    let dir = dir_from(&settings);
    let target = match target_path {
        Some(path) if !path.is_empty() => PathBuf::from(path),
        _ => {
            let ext = if settings.format == "jpg" {
                "jpg".to_string()
            } else {
                settings.format.clone()
            };
            crate::imageio::export_name(&dir, "SnapPro_Edited", &ext)
        }
    };

    let size = crate::imageio::save_data_url(&data_url, &target).map_err(|e| e.to_string())?;
    let (width, height) = image::image_dimensions(&target).unwrap_or((0, 0));

    Ok(serde_json::json!({
        "id": uuid::Uuid::new_v4().to_string(),
        "path": target.to_string_lossy(),
        "name": target.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default(),
        "width": width,
        "height": height,
        "sizeBytes": size,
    }))
}

/// Overwrite an existing file with edited content (Ctrl+S in the editor).
#[tauri::command]
pub fn overwrite_image(app: AppHandle, data_url: String, path: String) -> Result<serde_json::Value, String> {
    let settings = crate::settings::load(&app);
    let target = PathBuf::from(&path);
    let size = crate::imageio::save_data_url(&data_url, &target).map_err(|e| e.to_string())?;
    let (width, height) = image::image_dimensions(&target).unwrap_or((0, 0));
    emit(
        &app,
        "library://changed",
        serde_json::json!({ "path": path }),
    );
    Ok(serde_json::json!({
        "path": target.to_string_lossy(),
        "sizeBytes": size,
        "width": width,
        "height": height,
        "format": settings.format,
    }))
}

#[tauri::command]
pub fn export_image(
    app: AppHandle,
    data_url: String,
    target_path: Option<String>,
    format: Option<String>,
) -> Result<String, String> {
    let settings = crate::settings::load(&app);
    let dir = export_dir_from(&settings);
    let ext = format.unwrap_or(settings.format);
    let target = match target_path {
        Some(path) if !path.is_empty() => PathBuf::from(path),
        _ => crate::imageio::export_name(&dir, "SnapPro_Export", &ext),
    };
    crate::imageio::save_data_url(&data_url, &target).map_err(|e| e.to_string())?;
    emit(&app, "library://changed", serde_json::json!({}));
    Ok(target.to_string_lossy().to_string())
}

#[tauri::command]
pub fn read_image_data(path: String) -> Result<String, String> {
    crate::imageio::read_data_url(std::path::Path::new(&path)).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn export_pdf(
    app: AppHandle,
    paths: Vec<String>,
    target_path: Option<String>,
    options: Option<crate::pdf::PdfOptions>,
) -> Result<String, String> {
    let settings = crate::settings::load(&app);
    let dir = export_dir_from(&settings);
    let target = match target_path {
        Some(path) if !path.is_empty() => PathBuf::from(path),
        _ => dir.join(crate::util::timestamp_name("SnapPro", "pdf")),
    };
    let images: Vec<PathBuf> = paths.into_iter().map(PathBuf::from).collect();
    let options = options.unwrap_or_default();
    crate::pdf::images_to_pdf_with(&images, &target, &options).map_err(|e| e.to_string())?;
    emit(&app, "library://changed", serde_json::json!({}));
    Ok(target.to_string_lossy().to_string())
}

/// PDF straight from the editor canvas (no stray picture is left behind).
#[tauri::command]
pub fn export_pdf_data(
    app: AppHandle,
    data_url: String,
    target_path: Option<String>,
    options: Option<crate::pdf::PdfOptions>,
) -> Result<String, String> {
    let temp = crate::util::temp_capture_dir().join(crate::util::timestamp_name("pdf_source", "png"));
    crate::util::ensure_dir(temp.parent().unwrap()).map_err(|e| e.to_string())?;
    crate::imageio::save_data_url(&data_url, &temp).map_err(|e| e.to_string())?;
    let result = export_pdf(app, vec![temp.to_string_lossy().to_string()], target_path, options);
    let _ = std::fs::remove_file(&temp);
    result
}

/// Page layout without writing a file, so the dialog can show the pages.
#[tauri::command]
pub fn pdf_plan(sizes: Vec<(u32, u32)>, options: crate::pdf::PdfOptions) -> serde_json::Value {
    let pages = crate::pdf::plan_pages(&sizes, &options);
    serde_json::json!(pages
        .iter()
        .map(|p| serde_json::json!({
            "width": p.width,
            "height": p.height,
            "tiles": p.tiles.iter().map(|t| serde_json::json!({
                "source": t.source, "crop": t.crop, "rect": t.rect,
                "dpi": if t.rect.2 > 0.0 { t.crop.2 as f32 / (t.rect.2 / 72.0) } else { 0.0 },
            })).collect::<Vec<_>>(),
        }))
        .collect::<Vec<_>>())
}

/// Drives / mount points the user can pick as a save location.
#[tauri::command]
pub fn list_drives() -> Vec<serde_json::Value> {
    let mut out = Vec::new();
    #[cfg(windows)]
    for letter in b'A'..=b'Z' {
        let root = format!("{}:\\", letter as char);
        if std::path::Path::new(&root).exists() {
            out.push(serde_json::json!({ "path": root, "label": format!("{}:", letter as char) }));
        }
    }
    #[cfg(not(windows))]
    {
        out.push(serde_json::json!({ "path": "/", "label": "/" }));
        for base in ["/Volumes", "/media", "/run/media", "/mnt"] {
            if let Ok(entries) = std::fs::read_dir(base) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    if path.is_dir() {
                        // /media/<user>/<disk> on Linux
                        if base == "/media" || base == "/run/media" {
                            if let Ok(inner) = std::fs::read_dir(&path) {
                                for disk in inner.flatten().filter(|d| d.path().is_dir()) {
                                    let p = disk.path();
                                    out.push(serde_json::json!({ "path": p.to_string_lossy(), "label": disk.file_name().to_string_lossy() }));
                                }
                            }
                            continue;
                        }
                        out.push(serde_json::json!({ "path": path.to_string_lossy(), "label": entry.file_name().to_string_lossy() }));
                    }
                }
            }
        }
    }
    out
}

fn check_folder(label: &str, dir: &str) -> Result<(), String> {
    if dir.trim().is_empty() {
        return Ok(());
    }
    let path = PathBuf::from(dir);
    std::fs::create_dir_all(&path).map_err(|e| format!("{} folder \"{}\" cannot be created: {}", label, dir, e))?;
    let probe = path.join(".snappro-write-test");
    std::fs::write(&probe, b"x").map_err(|e| format!("{} folder \"{}\" is not writable: {}", label, dir, e))?;
    let _ = std::fs::remove_file(probe);
    Ok(())
}

// ---------------------------------------------------------------------------
// Library
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn library_list(app: AppHandle) -> Vec<crate::history::LibraryItem> {
    let settings = crate::settings::load(&app);
    let mut dirs = vec![dir_from(&settings), video_dir_from(&settings), export_dir_from(&settings)];
    dirs.sort();
    dirs.dedup();
    let mut items: Vec<_> = dirs.iter().flat_map(|d| crate::history::scan(d)).collect();
    items.sort_by(|a, b| b.created.cmp(&a.created));
    items
}

#[tauri::command]
pub fn library_delete(path: String) -> Result<(), String> {
    crate::history::delete(std::path::Path::new(&path)).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn library_rename(path: String, new_name: String) -> Result<String, String> {
    let result = crate::history::rename(std::path::Path::new(&path), &new_name).map_err(|e| e.to_string())?;
    Ok(result.to_string_lossy().to_string())
}

#[tauri::command]
pub fn library_export(app: AppHandle, path: String, target_dir: Option<String>) -> Result<String, String> {
    let settings = crate::settings::load(&app);
    let source = PathBuf::from(&path);
    let dir = target_dir
        .map(PathBuf::from)
        .unwrap_or_else(|| dir_from(&settings));
    let name = source
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "copy.png".to_string());
    let dest = dir.join(name);
    crate::history::export(&source, &dest).map_err(|e| e.to_string())?;
    Ok(dest.to_string_lossy().to_string())
}

#[tauri::command]
pub fn library_reveal(path: String) -> Result<(), String> {
    crate::shell_open::reveal(std::path::Path::new(&path)).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn open_path(app: AppHandle, path: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_path(path, None::<&str>)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub fn open_folder(path: String) -> Result<(), String> {
    crate::shell_open::open_folder(std::path::Path::new(&path)).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// OCR
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn ocr_image(path: String, language: Option<String>) -> Result<crate::ocr::OcrResult, String> {
    let lang = language.unwrap_or_else(|| "eng".to_string());
    tauri::async_runtime::spawn_blocking(move || {
        crate::ocr::ocr_image(std::path::Path::new(&path), &lang)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())
}

/// OCR the capture and put the text on the clipboard in one step.
#[tauri::command]
pub async fn ocr_and_copy(
    app: AppHandle,
    path: String,
    language: Option<String>,
) -> Result<crate::ocr::OcrResult, String> {
    let result = ocr_image(path, language).await?;
    crate::clipboard::write_text(&app, &result.text).map_err(|e| e.to_string())?;
    Ok(result)
}

#[tauri::command]
pub fn ocr_languages() -> Vec<String> {
    crate::ocr::available_languages()
}

// ---------------------------------------------------------------------------
// AI
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn ai_remove_background(
    app: AppHandle,
    path: String,
    tolerance: Option<f32>,
) -> Result<serde_json::Value, String> {
    let source = PathBuf::from(&path);
    let tolerance = tolerance.unwrap_or(38.0);
    let result = tauri::async_runtime::spawn_blocking(move || -> anyhow::Result<(String, u64)> {
        let image = image::open(&source)?.to_rgba8();
        let processed = crate::ai::remove_background(&image, tolerance, true);
        crate::ai::save_result(processed, &source, "nobg")
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())?;

    emit(&app, "library://changed", serde_json::json!({}));
    Ok(serde_json::json!({ "path": result.0, "sizeBytes": result.1 }))
}

#[tauri::command]
pub async fn ai_blur_faces(
    app: AppHandle,
    path: String,
    strength: Option<f32>,
) -> Result<serde_json::Value, String> {
    let source = PathBuf::from(&path);
    let strength = strength.unwrap_or(14.0);
    let result = tauri::async_runtime::spawn_blocking(move || -> anyhow::Result<(String, u64)> {
        let image = image::open(&source)?.to_rgba8();
        let processed = crate::ai::blur_faces(&image, strength);
        crate::ai::save_result(processed, &source, "privacy")
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())?;

    emit(&app, "library://changed", serde_json::json!({}));
    Ok(serde_json::json!({ "path": result.0, "sizeBytes": result.1 }))
}

#[tauri::command]
pub async fn ai_auto_enhance(app: AppHandle, path: String) -> Result<serde_json::Value, String> {
    let source = PathBuf::from(&path);
    let result = tauri::async_runtime::spawn_blocking(move || -> anyhow::Result<(String, u64)> {
        let image = image::open(&source)?.to_rgba8();
        let processed = crate::ai::auto_enhance(&image);
        crate::ai::save_result(processed, &source, "enhanced")
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())?;

    emit(&app, "library://changed", serde_json::json!({}));
    Ok(serde_json::json!({ "path": result.0, "sizeBytes": result.1 }))
}

// ---------------------------------------------------------------------------
// Cloud
// ---------------------------------------------------------------------------

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadArgs {
    pub path: String,
    pub provider: Option<String>,
    pub client_id: Option<String>,
    pub endpoint: Option<String>,
    pub token: Option<String>,
    pub bucket: Option<String>,
    pub region: Option<String>,
    pub access_key: Option<String>,
    pub secret_key: Option<String>,
    pub prefix: Option<String>,
}

#[tauri::command]
pub async fn upload_image(app: AppHandle, args: UploadArgs) -> Result<crate::cloud::UploadResult, String> {
    let settings = crate::settings::load(&app);
    let path = PathBuf::from(&args.path);
    let provider = args.provider.unwrap_or_else(|| "imgur".to_string());
    let client_id = args
        .client_id
        .filter(|s| !s.trim().is_empty())
        .unwrap_or(settings.imgur_client_id);
    let endpoint = args.endpoint.unwrap_or_default();
    let token = args.token.unwrap_or_default();
    let bucket = args.bucket.unwrap_or_default();
    let region = args.region.unwrap_or_else(|| settings.s3_region.clone());
    let access_key = args.access_key.filter(|s| !s.trim().is_empty()).unwrap_or(settings.s3_access_key.clone());
    let secret_key = args.secret_key.filter(|s| !s.trim().is_empty()).unwrap_or(settings.s3_secret_key.clone());
    let prefix = args.prefix.unwrap_or_else(|| settings.s3_prefix.clone());

    let result = tauri::async_runtime::spawn_blocking(move || match provider.as_str() {
        "custom" => crate::cloud::upload_custom(&path, &endpoint, &token),
        "s3" => crate::cloud::upload_s3(
            &path, &bucket, &region, &access_key, &secret_key, &prefix,
        ),
        "gdrive" => crate::cloud::upload_gdrive(&path, &token),
        _ => crate::cloud::upload_imgur(&path, &client_id),
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())?;

    Ok(result)
}

/// OCR a capture and copy the text straight to the clipboard — the plan's
/// "extract text in one click" shortcut.
#[tauri::command]
pub async fn copy_text_to_clipboard(app: AppHandle, text: String) -> Result<(), String> {
    crate::clipboard::write_text(&app, &text).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Plugins
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn plugins_list() -> Vec<crate::plugins::PluginManifest> {
    crate::plugins::list_plugins()
}

#[tauri::command]
pub fn plugin_install(path: String) -> Result<crate::plugins::PluginManifest, String> {
    crate::plugins::install_plugin(std::path::Path::new(&path)).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn plugin_remove(id: String) -> Result<(), String> {
    crate::plugins::remove_plugin(&id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn plugin_open_folder() -> Result<(), String> {
    crate::plugins::open_plugin_folder().map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn get_settings(app: AppHandle) -> crate::settings::Settings {
    crate::settings::load(&app)
}

/// Apply the "start with the system" toggle for real.
///
/// The setting existed in the UI but nothing consumed it, so the switch was
/// dead. Each platform has its own autostart mechanism, so all three are
/// implemented instead of only Windows.
pub fn apply_launch_at_startup(enabled: bool) -> Result<(), String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let exe = exe.to_string_lossy().to_string();

    #[cfg(target_os = "windows")]
    {
        const KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
        if enabled {
            // The value is quoted so an install path with spaces still launches.
            use std::os::windows::process::CommandExt;
            let out = crate::util::hidden_command("reg")
                .raw_arg(format!(
                    "add \"{KEY}\" /v SnapPro /t REG_SZ /d \"\\\"{exe}\\\"\" /f"
                ))
                .output()
                .map_err(|e| e.to_string())?;
            if !out.status.success() {
                return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
            }
        } else {
            // A missing value is not an error here: turning the switch off twice
            // should simply succeed.
            let _ = crate::util::hidden_command("reg")
                .args(["delete", KEY, "/v", "SnapPro", "/f"])
                .output();
        }
        return Ok(());
    }

    #[cfg(target_os = "linux")]
    {
        let dir = dirs::config_dir()
            .ok_or_else(|| "config dir is unavailable".to_string())?
            .join("autostart");
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let file = dir.join("snappro.desktop");
        if enabled {
            let entry = format!(
                "[Desktop Entry]\nType=Application\nName=SnapPro\nExec={}\nX-GNOME-Autostart-enabled=true\n",
                exe
            );
            std::fs::write(&file, entry).map_err(|e| e.to_string())?;
        } else if file.exists() {
            std::fs::remove_file(&file).map_err(|e| e.to_string())?;
        }
        return Ok(());
    }

    #[cfg(target_os = "macos")]
    {
        let dir = dirs::home_dir()
            .ok_or_else(|| "home dir is unavailable".to_string())?
            .join("Library/LaunchAgents");
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let file = dir.join("com.snappro.desktop.plist");
        if enabled {
            let plist = format!(
                "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n<plist version=\"1.0\"><dict><key>Label</key><string>com.snappro.desktop</string><key>ProgramArguments</key><array><string>{}</string></array><key>RunAtLoad</key><true/></dict></plist>\n",
                exe
            );
            std::fs::write(&file, plist).map_err(|e| e.to_string())?;
        } else if file.exists() {
            std::fs::remove_file(&file).map_err(|e| e.to_string())?;
        }
        return Ok(());
    }

    #[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "macos")))]
    {
        let _ = (enabled, exe);
        Err("unsupported platform".into())
    }
}

#[tauri::command]
pub fn save_settings(app: AppHandle, settings: crate::settings::Settings) -> Result<Vec<String>, String> {
    let previous = crate::settings::load(&app);
    check_folder("Picture", &settings.save_dir)?;
    check_folder("Video", &settings.video_dir)?;
    check_folder("Export", &settings.export_dir)?;
    crate::settings::save(&app, &settings).map_err(|e| e.to_string())?;
    // Shortcuts that could not be registered (taken by another app, or typed
    // wrongly) are reported back so the UI can say so.
    #[cfg(desktop)]
    let failed = crate::settings::apply_shortcuts(&app, &settings);
    #[cfg(not(desktop))]
    let failed: Vec<String> = Vec::new();
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_always_on_top(settings.always_on_top);
        let _ = window.set_skip_taskbar(settings.mini_mode);
    }
    if previous.launch_at_startup != settings.launch_at_startup {
        if let Err(err) = apply_launch_at_startup(settings.launch_at_startup) {
            crate::settings::log_line(&format!("autostart failed: {}", err));
            return Err(err);
        }
    }
    emit(&app, "settings://changed", settings);
    Ok(failed)
}

#[tauri::command]
pub fn check_dependencies() -> serde_json::Value {
    let ffmpeg = crate::util::find_ffmpeg();
    let tesseract = crate::util::find_tesseract();
    serde_json::json!({
        "ffmpeg": ffmpeg.as_ref().map(|p| p.to_string_lossy().to_string()),
        "tesseract": tesseract.as_ref().map(|p| p.to_string_lossy().to_string()),
        "ocrLanguages": crate::ocr::available_languages(),
        "platform": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "appVersion": env!("CARGO_PKG_VERSION"),
        "recordingBlocker": crate::recorder::session_blocker(),
    })
}

/// Report how many pixels the virtual desktop covers — shown in Settings.
#[tauri::command]
pub fn desktop_info() -> Result<serde_json::Value, String> {
    let monitors = xcap::Monitor::all().map_err(|e| e.to_string())?;
    let width = monitors.iter().map(|m| m.width().unwrap_or(0)).max().unwrap_or(0);
    let height = monitors.iter().map(|m| m.height().unwrap_or(0)).map(|h| h as i32).max().unwrap_or(0);
    Ok(serde_json::json!({
        "count": monitors.len(),
        "width": width,
        "height": height,
        "scaleFactor": monitors.first().and_then(|m| m.scale_factor().ok()).unwrap_or(1.0),
    }))
}

#[tauri::command]
pub fn pick_color(x: i32, y: i32) -> Result<serde_json::Value, String> {
    let (r, g, b, a) = crate::capture::full::pixel_at(x, y).map_err(|e| e.to_string())?;
    let hex = format!("#{:02X}{:02X}{:02X}", r, g, b);
    Ok(serde_json::json!({ "r": r, "g": g, "b": b, "a": a, "hex": hex }))
}

#[tauri::command]
pub fn beep(app: AppHandle) {
    crate::feedback::capture_done(&app, "SnapPro is ready");
}

#[tauri::command]
pub async fn copy_image_file(app: AppHandle, path: String) -> Result<(), String> {
    let data = crate::imageio::read_data_url(std::path::Path::new(&path)).map_err(|e| e.to_string())?;
    crate::clipboard::write_image(&app, &data).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Hotkey / tray actions shared with the UI
// ---------------------------------------------------------------------------

pub fn hotkey_action(app: AppHandle, index: usize) {
    let handle = app.clone();
    std::thread::spawn(move || {
        let settings = crate::settings::load(&handle);
        let dir = capture_dir(&settings);
        let format = settings.format.clone();
        let session_overlay = crate::util::session_dir().join("overlay.png");

        let result = match index {
            0 => {
                // Full screen (honouring the monitor chosen in Settings).
                let index = resolve_monitor(&settings, None);
                let was_visible = hide_main_tracked(&handle);
                let shot = crate::capture::full::capture_full_screen(index, &format, dir);
                restore_main(&handle, was_visible);
                shot
            }
            5 => {
                // Every display at once.
                let was_visible = hide_main_tracked(&handle);
                let shot = crate::capture::full::capture_all_monitors(&format, dir);
                restore_main(&handle, was_visible);
                shot
            }
            1 => {
                // Active window.
                let was_visible = hide_main_tracked(&handle);
                let shot = crate::capture::window::capture_active_window(&format, dir, None);
                restore_main(&handle, was_visible);
                shot
            }
            2 | 3 | 6 | 7 | 8 => {
                // Region (2), scrolling (3), OCR (6), fixed size (7) and colour
                // picker (8) all need the picker overlay; it reports back with an
                // event, so there is nothing to return here.
                let mode = match index {
                    3 => "scrolling",
                    6 => "ocr",
                    7 => "fixed",
                    8 => "pick",
                    _ => "region",
                };
                let inner = handle.clone();
                let target = resolve_monitor(&settings, None);
                tauri::async_runtime::spawn(async move {
                    if let Err(err) = start_region_selector(inner, Some(mode.into()), target, None).await {
                        crate::settings::log_line(&format!("region selector failed: {}", err));
                    }
                });
                return;
            }
            4 => {
                // Start / stop recording.
                crate::commands::toggle_recording_shortcut(&handle);
                return;
            }
            _ => {
                let was_visible = hide_main_tracked(&handle);
                let shot = crate::capture::full::capture_full_screen(None, &format, dir);
                restore_main(&handle, was_visible);
                shot
            }
        };

        match result {
            Ok(capture) => {
                if session_overlay.exists() {
                    let _ = std::fs::remove_file(&session_overlay);
                }
                after_capture(&handle, &capture);
            }
            Err(err) => {
                crate::settings::log_line(&format!("hotkey action failed: {}", err));
                // Nobody is watching a hotkey capture, so say what went wrong.
                crate::feedback::notify(&handle, "SnapPro", &format!("Capture failed: {}", err));
                emit(&handle, "capture://failed", err.to_string());
            }
        }
    });
}

/// Tray menu action: show the main window again.
pub fn focus_main(app: &AppHandle) {
    show_window(app, "main");
}

/// Bring the main window to the front (used by the floating recorder pill).
#[tauri::command]
pub fn focus_main_window(app: AppHandle) {
    focus_main(&app);
    hide_window(&app, "recorder");
}

/// Hotkey / tray action: start recording (asking the UI to open the recorder),
/// or stop it when a recording is already running.
pub fn toggle_recording_shortcut(app: &AppHandle) {
    let state = app.state::<crate::recorder::RecorderState>();
    let status = {
        let inner = state.inner.lock().unwrap();
        inner.status()
    };
    // A paused take is still a take: the shortcut stops it.
    if status.recording || status.paused {
        let handle = app.clone();
        tauri::async_runtime::spawn(async move {
            let state = handle.state::<crate::recorder::RecorderState>();
            let _ = stop_recording(handle.clone(), state).await;
        });
    } else {
        // Show the recorder pill itself. Emitting a nav event only worked if a
        // listener happened to be registered in a window that was already open,
        // so Ctrl+Shift+R looked dead; showing the window is deterministic.
        place_recorder(app);
        show_window(app, "recorder");
        emit(app, "nav://record", ());
    }
}

pub fn hide_all(app: &AppHandle) {
    for label in ["main", "recorder", "preview", "region", "editor"] {
        hide_window(app, label);
    }
}

#[tauri::command]
pub fn close_window(app: AppHandle, label: Option<String>) {
    let target = label.unwrap_or_else(|| "main".to_string());
    if let Some(window) = app.get_webview_window(&target) {
        let _ = window.hide();
    }
}

/// Largest logical size a window may have on the screen it is on (leaves room for the
/// taskbar / dock and a margin), so no window ever hangs off the edge of the display.
fn clamp_to_screen(window: &WebviewWindow, width: f64, height: f64) -> (f64, f64) {
    let monitor = window
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| window.primary_monitor().ok().flatten());
    match monitor {
        Some(m) => {
            let scale = m.scale_factor().max(0.5);
            let max_w = (m.size().width as f64 / scale - 24.0).max(320.0);
            let max_h = (m.size().height as f64 / scale - 96.0).max(320.0);
            (width.min(max_w), height.min(max_h))
        }
        None => (width, height),
    }
}

fn fit_window(window: &WebviewWindow, width: f64, height: f64, centre: bool) {
    let (w, h) = clamp_to_screen(window, width, height);
    let _ = window.set_size(tauri::LogicalSize::new(w, h));
    if centre {
        let _ = window.center();
    }
}

#[tauri::command]
pub fn open_editor(app: AppHandle, path: String) {
    if let Ok(mut pending) = PENDING_EDITOR_PATH.lock() {
        *pending = Some(path.clone());
    }
    if let Some(window) = app.get_webview_window("editor") {
        // Only size and centre it when it is opening, not while the user is working in it.
        if !window.is_visible().unwrap_or(false) {
            fit_window(&window, 1320.0, 840.0, true);
        }
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
    emit(&app, "editor://open", serde_json::json!({ "path": path }));
}

#[tauri::command]
pub fn window_action(window: WebviewWindow, action: String) -> Result<(), String> {
    match action.as_str() {
        "minimize" => window.minimize().map_err(|e| e.to_string()),
        "maximize" => {
            if window.is_maximized().unwrap_or(false) {
                window.unmaximize().map_err(|e| e.to_string())
            } else {
                window.maximize().map_err(|e| e.to_string())
            }
        }
        "close" => window.hide().map_err(|e| e.to_string()),
        "hide" => window.hide().map_err(|e| e.to_string()),
        "show" => window.show().map_err(|e| e.to_string()),
        _ => Ok(()),
    }
}

#[tauri::command]
pub fn set_always_on_top(app: AppHandle, label: Option<String>, value: bool) -> Result<(), String> {
    let target = label.unwrap_or_else(|| "main".to_string());
    if let Some(window) = app.get_webview_window(&target) {
        window.set_always_on_top(value).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn set_window_size(app: AppHandle, label: Option<String>, width: f64, height: f64) -> Result<(), String> {
    let target = label.unwrap_or_else(|| "main".to_string());
    if let Some(window) = app.get_webview_window(&target) {
        let (w, h) = clamp_to_screen(&window, width, height);
        window
            .set_size(tauri::LogicalSize::new(w, h))
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn get_monitors() -> Result<Vec<serde_json::Value>, String> {
    let monitors = xcap::Monitor::all().map_err(|e| e.to_string())?;
    let list = monitors
        .iter()
        .map(|m| {
            serde_json::json!({
                "id": m.id().unwrap_or(0),
                "name": m.friendly_name().or_else(|_| m.name()).unwrap_or_else(|_| "Display".into()),
                "x": m.x().unwrap_or(0),
                "y": m.y().unwrap_or(0),
                "width": m.width().unwrap_or(0),
                "height": m.height().unwrap_or(0),
                "scaleFactor": m.scale_factor().unwrap_or(1.0),
                "primary": m.is_primary().unwrap_or(false),
            })
        })
        .collect();
    Ok(list)
}

#[tauri::command]
pub fn quit_app(app: AppHandle) {
    app.exit(0);
}

#[tauri::command]
pub fn minimize_all(app: AppHandle) {
    hide_all(&app);
}

#[tauri::command]
pub fn reveal_item(path: String) -> Result<(), String> {
    crate::shell_open::reveal(std::path::Path::new(&path)).map_err(|e| e.to_string())
}

pub fn region_rect_from_value(x: i32, y: i32, width: u32, height: u32) -> RegionRect {
    RegionRect { x, y, width, height }
}
// ---------------------------------------------------------------------------
// Library thumbnails, temp captures, dependency installer, misc
// ---------------------------------------------------------------------------

/// JPEG preview of a library item as a data URL (cached on disk).
#[tauri::command]
pub async fn library_thumbnail(path: String, max_width: Option<u32>) -> Result<String, String> {
    let width = max_width.unwrap_or(240).clamp(64, 720);
    let thumb = tauri::async_runtime::spawn_blocking(move || {
        crate::history::thumbnail(std::path::Path::new(&path), width)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())?;
    crate::imageio::read_data_url(&thumb).map_err(|e| e.to_string())
}

/// Move a capture that was taken with "Auto save" off into the library folder.
#[tauri::command]
pub fn keep_capture(app: AppHandle, path: String) -> Result<String, String> {
    let settings = crate::settings::load(&app);
    let source = PathBuf::from(&path);
    let name = source
        .file_name()
        .ok_or_else(|| "invalid file".to_string())?
        .to_owned();
    let dir = dir_from(&settings);
    crate::util::ensure_dir(&dir).map_err(|e| e.to_string())?;
    let target = crate::history::unique_path(dir.join(name));
    if std::fs::rename(&source, &target).is_err() {
        // Different drives cannot be renamed across: copy and delete instead.
        std::fs::copy(&source, &target).map_err(|e| e.to_string())?;
        let _ = std::fs::remove_file(&source);
    }
    emit(&app, "library://changed", serde_json::json!({}));
    Ok(target.to_string_lossy().to_string())
}

/// Put an edited image (data URL) on the clipboard.
#[tauri::command]
pub fn copy_image_data(app: AppHandle, data_url: String) -> Result<(), String> {
    crate::clipboard::write_image(&app, &data_url).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn open_url(app: AppHandle, url: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("only web links can be opened".into());
    }
    app.opener().open_url(url, None::<&str>).map_err(|e| e.to_string())
}

/// Install ffmpeg or Tesseract with the system package manager.
///
/// Windows uses winget, macOS uses Homebrew, Linux asks for permission through
/// polkit and uses apt / dnf / pacman. The output tail is returned so the UI can
/// show what happened.
#[tauri::command]
pub async fn install_dependency(name: String) -> Result<String, String> {
    if name != "ffmpeg" && name != "tesseract" {
        return Err("unknown dependency".into());
    }
    tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        let (program, args): (String, Vec<String>) = installer_command(&name)?;
        let out = crate::util::hidden_command(&program)
            .args(&args)
            .output()
            .map_err(|e| format!("could not start {program}: {e}"))?;
        let text = format!(
            "{}{}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr)
        );
        let tail: String = text
            .lines()
            .rev()
            .take(8)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect::<Vec<_>>()
            .join("\n");
        crate::settings::log_line(&format!("install {name}: {}", out.status));
        if out.status.success() {
            Ok(tail)
        } else {
            Err(format!("The installer did not finish:\n{tail}"))
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

fn command_exists(name: &str) -> bool {
    crate::util::hidden_command(name)
        .arg("--version")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

fn installer_command(name: &str) -> Result<(String, Vec<String>), String> {
    let s = |v: &[&str]| v.iter().map(|x| x.to_string()).collect::<Vec<_>>();
    #[cfg(windows)]
    {
        let id = if name == "ffmpeg" { "Gyan.FFmpeg" } else { "UB-Mannheim.TesseractOCR" };
        return Ok((
            "winget".into(),
            s(&["install", "--id", id, "-e", "--silent", "--accept-source-agreements", "--accept-package-agreements"]),
        ));
    }
    #[cfg(target_os = "macos")]
    {
        let brew = if std::path::Path::new("/opt/homebrew/bin/brew").exists() {
            "/opt/homebrew/bin/brew"
        } else {
            "/usr/local/bin/brew"
        };
        let pkg: &[&str] = if name == "ffmpeg" { &["ffmpeg"] } else { &["tesseract", "tesseract-lang"] };
        let mut args = s(&["install"]);
        args.extend(pkg.iter().map(|p| p.to_string()));
        return Ok((brew.into(), args));
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let pkg = if name == "ffmpeg" { "ffmpeg" } else { "tesseract-ocr" };
        if command_exists("apt-get") {
            return Ok(("pkexec".into(), s(&["apt-get", "install", "-y", pkg])));
        }
        if command_exists("dnf") {
            let pkg = if name == "ffmpeg" { "ffmpeg" } else { "tesseract" };
            return Ok(("pkexec".into(), s(&["dnf", "install", "-y", pkg])));
        }
        if command_exists("pacman") {
            let pkg = if name == "ffmpeg" { "ffmpeg" } else { "tesseract" };
            return Ok(("pkexec".into(), s(&["pacman", "-S", "--noconfirm", pkg])));
        }
        return Err("No supported package manager found (apt, dnf or pacman).".into());
    }
    #[allow(unreachable_code)]
    {
        let _ = (name, command_exists("x"), s(&[]));
        Err("unsupported platform".into())
    }
}

/// Called when the app exits: stop a running ffmpeg and keep what was recorded.
pub fn shutdown_recording(app: &AppHandle) {
    let state = app.state::<crate::recorder::RecorderState>();
    let (child, segments, output, format, fps, options) = {
        let Ok(mut inner) = state.inner.lock() else {
            return;
        };
        if !inner.is_active() {
            return;
        }
        let mut segments = std::mem::take(&mut inner.segments);
        let child = inner.child.take();
        let active = inner.active_segment.take();
        if let Some(active) = active {
            segments.push(active);
        }
        (
            child,
            segments,
            inner.final_output.clone(),
            inner.format.clone(),
            inner.options.as_ref().map(|o| o.fps).unwrap_or(30),
            inner.options.clone().unwrap_or_default(),
        )
    };
    if let Some(mut child) = child {
        let _ = crate::recorder::stop_child(&mut child);
    }
    let segments: Vec<PathBuf> = segments.into_iter().filter(|s| s.exists()).collect();
    if let (Some(output), false) = (output, segments.is_empty()) {
        let segments = crate::recorder::compose_cameras(&segments, &options);
        let _ = crate::recorder::finalize_recording(&segments, &output, &format, fps);
    }
}

// ---------------------------------------------------------------------------
// Recorder hand-over: the setup panel lives in the main window, the countdown and
// the controls in the floating pill. The pill collects the pending request.
// ---------------------------------------------------------------------------

static PENDING_RECORD: std::sync::Mutex<Option<serde_json::Value>> = std::sync::Mutex::new(None);

/// Park a recording request (options + countdown) and bring up the pill.
#[tauri::command]
pub fn prepare_recording(app: AppHandle, request: serde_json::Value) -> Result<(), String> {
    if let Ok(mut pending) = PENDING_RECORD.lock() {
        *pending = Some(request);
    }
    // Windows that would end up in the video go away before the countdown.
    hide_window(&app, "main");
    hide_window(&app, "preview");
    place_recorder(&app);
    show_window(&app, "recorder");
    Ok(())
}

#[tauri::command]
pub fn take_pending_recording() -> Option<serde_json::Value> {
    PENDING_RECORD.lock().ok().and_then(|mut pending| pending.take())
}

/// Bring up the recorder bar (where you choose screen / window / area and start).
#[tauri::command]
pub fn show_recorder(app: AppHandle) {
    hide_window(&app, "main");
    hide_window(&app, "preview");
    place_recorder(&app);
    show_window(&app, "recorder");
}

/// Sound / camera switches that may change while a take is running.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordingChange {
    pub audio: Option<bool>,
    pub audio_device: Option<String>,
    pub system_audio: Option<bool>,
    pub webcam: Option<bool>,
}

/// Turn the microphone, computer sound or webcam on or off.
///
/// While recording this closes the current segment and starts the next one with
/// the new settings (a very short cut); while paused the change applies when the
/// recording resumes. Every segment has the same audio track layout, so they join.
#[tauri::command]
pub async fn reconfigure_recording(
    app: AppHandle,
    state: tauri::State<'_, crate::recorder::RecorderState>,
    change: RecordingChange,
) -> Result<RecordingStatus, String> {
    let (options, running) = {
        let inner = state.inner.lock().unwrap();
        if !inner.is_active() {
            return Err("not recording".into());
        }
        (inner.options.clone().unwrap_or_default(), inner.started_at.is_some())
    };
    let mut next = options;
    if let Some(value) = change.audio {
        next.audio = value;
    }
    if let Some(device) = change.audio_device {
        next.audio_device = Some(device);
    }
    if let Some(value) = change.system_audio {
        next.system_audio = value;
    }
    if let Some(value) = change.webcam {
        next.webcam = value;
    }
    // Resolves default devices and reports a missing one before anything is touched.
    let next = prepare_options(next)?;
    state.inner.lock().unwrap().options = Some(next);

    if running {
        pause_recording(app.clone(), state.clone()).await?;
        resume_recording(app, state).await
    } else {
        Ok(state.inner.lock().unwrap().status())
    }
}
