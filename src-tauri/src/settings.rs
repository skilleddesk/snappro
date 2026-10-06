use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    /// Where screenshots are saved. Any drive or folder.
    pub save_dir: String,
    /// Where recordings go (empty = same as `save_dir`).
    pub video_dir: String,
    /// Where exports (PDF, exported copies) go (empty = same as `save_dir`).
    pub export_dir: String,
    pub format: String,
    pub auto_copy: bool,
    pub auto_save: bool,
    pub open_preview: bool,
    pub monitor: String,
    pub delay_secs: u64,
    pub always_on_top: bool,
    pub mini_mode: bool,
    pub language: String,
    pub play_sound: bool,
    pub include_cursor: bool,
    pub imgur_client_id: String,
    pub s3_region: String,
    pub s3_access_key: String,
    pub s3_secret_key: String,
    pub s3_prefix: String,
    pub s3_bucket: String,
    pub auto_ocr_caption: bool,
    pub launch_at_startup: bool,
    pub shortcut_ocr: String,
    pub shortcuts: Vec<String>,
    // --- recording (the recorder panel reads these) ---
    pub recording_fps: u32,
    pub recording_audio: bool,
    pub recording_audio_device: Option<String>,
    pub recording_webcam: bool,
    pub recording_camera_device: Option<String>,
    pub recording_format: String,
    pub recording_quality: String,
    pub draw_mouse: bool,
    /// Remember the last recorder source so the panel can auto-select it.
    pub recording_mode: String,
    /// Size used by the "Fixed size" capture tool.
    pub fixed_width: u32,
    pub fixed_height: u32,
    // --- recorder setup (remembered between sessions) ---
    pub recording_monitor: Option<usize>,
    pub recording_region: Option<crate::recorder::RegionRect>,
    pub recording_system_audio: bool,
    pub recording_system_device: Option<String>,
    pub webcam_position: String,
    pub webcam_width: u32,
    /// Seconds counted down before a take starts (0 = start at once).
    pub recording_countdown: u32,
    /// Stop automatically after this many minutes (0 = never).
    pub recording_max_minutes: u32,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            save_dir: crate::util::snappro_dir().to_string_lossy().to_string(),
            video_dir: String::new(),
            export_dir: String::new(),
            format: "png".into(),
            auto_copy: true,
            auto_save: true,
            // Showing the preview after a capture is the difference between
            // "nothing happened" and a visible result, so it is on by default.
            open_preview: true,
            monitor: "primary".into(),
            delay_secs: 3,
            always_on_top: true,
            // Quick bar first: the compact strip with the few essential actions.
            mini_mode: true,
            language: "en".into(),
            include_cursor: true,
            // The UI default for the recording audio toggle must match what the
            // recorder pill sends when it starts a take.
            play_sound: true,
            imgur_client_id: "546c25a59c58ad7".into(),
            s3_region: "us-east-1".into(),
            s3_access_key: String::new(),
            s3_secret_key: String::new(),
            s3_prefix: "snappro".into(),
            s3_bucket: String::new(),
            auto_ocr_caption: false,
            launch_at_startup: false,
            shortcut_ocr: "CmdOrCtrl+Shift+O".into(),
            shortcuts: vec![
                "CmdOrCtrl+Shift+1".into(),
                "CmdOrCtrl+Shift+2".into(),
                "CmdOrCtrl+Shift+3".into(),
                "CmdOrCtrl+Shift+4".into(),
                "CmdOrCtrl+Shift+R".into(),
            ],
            recording_fps: 30,
            recording_audio: false,
            recording_audio_device: None,
            recording_webcam: false,
            recording_camera_device: None,
            recording_format: "mp4".into(),
            recording_quality: "balanced".into(),
            draw_mouse: true,
            recording_mode: "screen".into(),
            fixed_width: 1280,
            fixed_height: 720,
            recording_monitor: None,
            recording_region: None,
            recording_system_audio: false,
            recording_system_device: None,
            webcam_position: "br".into(),
            webcam_width: 320,
            recording_countdown: 3,
            recording_max_minutes: 0,
        }
    }
}

pub fn settings_path(app: &AppHandle) -> PathBuf {
    app.path()
        .app_config_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join("settings.json")
}

pub fn load(app: &AppHandle) -> Settings {
    let path = settings_path(app);
    match std::fs::read_to_string(&path) {
        Ok(text) => match serde_json::from_str(&text) {
            Ok(settings) => settings,
            Err(err) => {
                // Keep the unreadable file so a typo never silently wipes the user's setup.
                let _ = std::fs::copy(&path, path.with_extension("broken.json"));
                log_line(&format!("settings.json could not be read ({err}); using defaults"));
                Settings::default()
            }
        },
        Err(_) => Settings::default(),
    }
}

pub fn save(app: &AppHandle, settings: &Settings) -> anyhow::Result<()> {
    let path = settings_path(app);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    // Write to a temp file first so a crash mid-write cannot corrupt the settings.
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_string_pretty(settings)?)?;
    std::fs::rename(&tmp, &path)?;
    Ok(())
}

/// Map a shortcut slot onto the action id understood by `commands::hotkey_action`.
///
/// Slots are numbered the way the UI labels them - 1 Full, 2 Region, 3 Window,
/// 4 Scrolling, 5 Record - while `hotkey_action` groups by capture kind
/// (0 Full, 1 Window, 2 Region, 3 Scrolling, 4 Record). Passing the raw slot
/// index straight through made `Ctrl+Shift+2` capture a *window* instead of a
/// region, which is why the shortcuts did not match their labels.
pub fn shortcut_action(slot: usize) -> usize {
    match slot {
        0 => 0,
        1 => 2,
        2 => 1,
        3 => 3,
        other => other,
    }
}

/// Register (or re-register) the global shortcuts from the settings.
#[cfg(desktop)]
pub fn apply_shortcuts(app: &AppHandle, settings: &Settings) -> Vec<String> {
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

    let gs = app.global_shortcut();
    let _ = gs.unregister_all();
    let mut failed: Vec<String> = Vec::new();

    // Slots 0-4 are the capture shortcuts, the OCR shortcut is action 6.
    let mut entries: Vec<(String, usize)> = settings
        .shortcuts
        .iter()
        .enumerate()
        .map(|(slot, accel)| (accel.clone(), shortcut_action(slot)))
        .collect();
    entries.push((settings.shortcut_ocr.clone(), 6));

    // GNOME on Wayland: the desktop itself has to run the shortcuts.
    #[cfg(target_os = "linux")]
    if crate::gnome_shortcuts::wanted() {
        crate::gnome_shortcuts::apply(entries.clone());
    }

    for (accel, action) in entries {
        if accel.trim().is_empty() {
            continue;
        }
        if let Err(err) = gs.on_shortcut(accel.as_str(), move |app, _sc, event| {
            if event.state() != ShortcutState::Pressed {
                return;
            }
            crate::commands::hotkey_action(app.clone(), action);
        }) {
            log_line(&format!("shortcut {} failed: {}", accel, err));
            failed.push(accel);
        }
    }
    failed
}

pub fn log_line(msg: &str) {
    let dir = crate::util::logs_dir();
    let _ = std::fs::create_dir_all(&dir);
    use std::io::Write;
    // Keep the log small: start over once it passes 512 KB.
    if std::fs::metadata(dir.join("snappro.log")).map(|m| m.len()).unwrap_or(0) > 512 * 1024 {
        let _ = std::fs::rename(dir.join("snappro.log"), dir.join("snappro.old.log"));
    }
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("snappro.log"))
    {
        let _ = writeln!(
            file,
            "[{}] {}",
            chrono::Local::now().format("%Y-%m-%d %H:%M:%S"),
            msg
        );
    }
}