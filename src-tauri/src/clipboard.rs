use base64::{engine::general_purpose::STANDARD as B64, Engine};
use tauri::AppHandle;
use tauri_plugin_clipboard_manager::ClipboardExt;

/// Copy an image (given as a data URL) to the system clipboard.
pub fn write_image(app: &AppHandle, data_url: &str) -> anyhow::Result<()> {
    let payload = data_url
        .split_once(',')
        .map(|(_, p)| p)
        .ok_or_else(|| anyhow::anyhow!("invalid image data"))?;
    let bytes = B64
        .decode(payload)
        .map_err(|e| anyhow::anyhow!(e.to_string()))?;
    let image = image::load_from_memory(&bytes)?.to_rgba8();
    let (width, height) = image.dimensions();
    let rgba = image.into_raw();
    let clipboard_image = tauri::image::Image::new_owned(rgba, width, height);
    app.clipboard()
        .write_image(&clipboard_image)
        .map_err(|e| anyhow::anyhow!(e.to_string()))
}

pub fn write_text(app: &AppHandle, text: &str) -> anyhow::Result<()> {
    app.clipboard()
        .write_text(text.to_string())
        .map_err(|e| anyhow::anyhow!(e.to_string()))
}

pub fn read_text(app: &AppHandle) -> anyhow::Result<String> {
    app.clipboard()
        .read_text()
        .map_err(|e| anyhow::anyhow!(e.to_string()))
}