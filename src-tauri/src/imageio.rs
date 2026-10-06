use std::path::{Path, PathBuf};

use base64::{engine::general_purpose::STANDARD as B64, Engine};

/// Read an image file and return it as a `data:` URL for the webview.
pub fn read_data_url(path: &Path) -> anyhow::Result<String> {
    let bytes = std::fs::read(path)?;
    let ext = path
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_else(|| "png".to_string());
    let mime = match ext.as_str() {
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "gif" => "image/gif",
        "mp4" => "video/mp4",
        "mkv" => "video/x-matroska",
        "webm" => "video/webm",
        _ => "image/png",
    };
    Ok(format!("data:{};base64,{}", mime, B64.encode(bytes)))
}

/// Save a base64 data URL (produced by the editor canvas) back to a file.
pub fn save_data_url(data_url: &str, target: &Path) -> anyhow::Result<u64> {
    let payload = data_url
        .split_once(',')
        .map(|(_, p)| p)
        .ok_or_else(|| anyhow::anyhow!("invalid image data"))?;
    let bytes = B64
        .decode(payload)
        .map_err(|e| anyhow::anyhow!(e.to_string()))?;
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)?;
    }

    let ext = target
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        // Re-encode so converting between PNG and JPEG really changes the format.
        "jpg" | "jpeg" => {
            let img = crate::util::flatten_on_white(&image::load_from_memory(&bytes)?.to_rgba8());
            let file = std::fs::File::create(target)?;
            let mut writer = std::io::BufWriter::new(file);
            let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut writer, 92);
            encoder.encode_image(&img)?;
        }
        "png" | "webp" | "bmp" => {
            // The webview may hand over a different format than the file name asks
            // for (WebKit cannot encode WebP and sends PNG), so re-encode unless the
            // bytes already match.
            let wanted = match ext.as_str() {
                "png" => image::ImageFormat::Png,
                "webp" => image::ImageFormat::WebP,
                _ => image::ImageFormat::Bmp,
            };
            if image::guess_format(&bytes).ok() == Some(wanted) {
                std::fs::write(target, &bytes)?;
            } else {
                let img = image::load_from_memory(&bytes)?;
                match wanted {
                    image::ImageFormat::WebP => {
                        let rgba = img.to_rgba8();
                        let file = std::fs::File::create(target)?;
                        image::codecs::webp::WebPEncoder::new_lossless(std::io::BufWriter::new(file))
                            .encode(
                                rgba.as_raw(),
                                rgba.width(),
                                rgba.height(),
                                image::ExtendedColorType::Rgba8,
                            )
                            .map_err(|e| anyhow::anyhow!(e.to_string()))?;
                    }
                    other => img.save_with_format(target, other)?,
                }
            }
        }
        _ => {
            let img = image::load_from_memory(&bytes)?;
            img.save(target)?;
        }
    }
    Ok(std::fs::metadata(target).map(|m| m.len()).unwrap_or(0))
}

/// Build a unique file name inside `dir` for an exported image.
pub fn export_name(dir: &Path, stem: &str, ext: &str) -> PathBuf {
    crate::util::ensure_dir(dir).ok();
    dir.join(format!(
        "{}_{}.{}",
        stem,
        chrono::Local::now().format("%Y-%m-%d_%H-%M-%S"),
        ext
    ))
}