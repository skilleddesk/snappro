use tauri::AppHandle;
use tauri_plugin_notification::NotificationExt;

/// Show a desktop notification (Windows/macOS play their own sound with it).
pub fn notify(app: &AppHandle, title: &str, body: &str) {
    let _ = app.notification().builder().title(title).body(body).show();
}

/// Feedback after a successful capture.
pub fn capture_done(app: &AppHandle, message: &str) {
    notify(app, "SnapPro", message);
}