use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LibraryItem {
    pub id: String,
    pub name: String,
    pub path: String,
    pub width: u32,
    pub height: u32,
    pub size_bytes: u64,
    pub created: i64,
    pub kind: String,
}

const IMAGE_EXT: [&str; 5] = ["png", "jpg", "jpeg", "webp", "bmp"];
const VIDEO_EXT: [&str; 4] = ["mp4", "mkv", "webm", "gif"];

fn extension(path: &Path) -> String {
    path.extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default()
}

pub fn scan(dir: &Path) -> Vec<LibraryItem> {
    let mut items: Vec<LibraryItem> = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return items;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let ext = extension(&path);
        // Poster frames and other helper files are not library items.
        let file_name = entry.file_name().to_string_lossy().to_string();
        if file_name.starts_with('.') || file_name.contains(".thumb.") || file_name.contains("SnapPro_segment") {
            continue;
        }
        let kind = if IMAGE_EXT.contains(&ext.as_str()) {
            "image"
        } else if VIDEO_EXT.contains(&ext.as_str()) {
            "video"
        } else {
            continue;
        };
        let metadata = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        let created = metadata
            .created()
            .or_else(|_| metadata.modified())
            .map(|t| {
                t.duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis() as i64)
                    .unwrap_or(0)
            })
            .unwrap_or(0);

        let (width, height) = if kind == "image" {
            image::image_dimensions(&path).unwrap_or((0, 0))
        } else {
            (0, 0)
        };

        let name = path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();

        items.push(LibraryItem {
            id: path.to_string_lossy().to_string(),
            name,
            path: path.to_string_lossy().to_string(),
            width,
            height,
            size_bytes: metadata.len(),
            created,
            kind: kind.to_string(),
        });
    }
    items.sort_by(|a, b| b.created.cmp(&a.created));
    items
}

pub fn delete(path: &Path) -> anyhow::Result<()> {
    if path.exists() {
        std::fs::remove_file(path)?;
    }
    Ok(())
}

pub fn export(src: &Path, dest: &Path) -> anyhow::Result<()> {
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::copy(src, dest)?;
    Ok(())
}

pub fn rename(src: &Path, new_name: &str) -> anyhow::Result<PathBuf> {
    let clean = new_name.replace(['/', '\\', ':', '*', '?', '"', '<', '>', '|'], "_");
    let ext = src.extension().map(|e| e.to_string_lossy().to_string());
    let file_name = match ext {
        Some(e) if !clean.to_lowercase().ends_with(&format!(".{}", e.to_lowercase())) => {
            format!("{}.{}", clean, e)
        }
        _ => clean,
    };
    let dest = src.with_file_name(file_name);
    if dest == src {
        return Ok(dest);
    }
    // Never overwrite another file: pick a free name instead.
    let dest = unique_path(dest);
    std::fs::rename(src, &dest)?;
    Ok(dest)
}
/// `name.png` -> `name (2).png` -> `name (3).png` ... until the path is free.
pub fn unique_path(path: PathBuf) -> PathBuf {
    if !path.exists() {
        return path;
    }
    let stem = path
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    let ext = path.extension().map(|e| e.to_string_lossy().to_string());
    for n in 2..10_000 {
        let name = match &ext {
            Some(e) => format!("{stem} ({n}).{e}"),
            None => format!("{stem} ({n})"),
        };
        let candidate = path.with_file_name(name);
        if !candidate.exists() {
            return candidate;
        }
    }
    path
}

/// Small cached preview of a library item (JPEG, `max_width` wide). Loading the
/// full-size file for every grid cell made the history panel slow and heavy.
pub fn thumbnail(path: &Path, max_width: u32) -> anyhow::Result<PathBuf> {
    use std::hash::{Hash, Hasher};
    let meta = std::fs::metadata(path)?;
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    path.hash(&mut hasher);
    meta.len().hash(&mut hasher);
    if let Ok(modified) = meta.modified() {
        modified.hash(&mut hasher);
    }
    max_width.hash(&mut hasher);
    let dir = crate::util::thumbs_dir();
    std::fs::create_dir_all(&dir)?;
    let target = dir.join(format!("{:016x}.jpg", hasher.finish()));
    if target.exists() {
        return Ok(target);
    }

    let ext = extension(path);
    if VIDEO_EXT.contains(&ext.as_str()) {
        crate::recorder::extract_frame(path, &target)?;
        return Ok(target);
    }

    let image = image::open(path)?.to_rgba8();
    let scale = (max_width as f32 / image.width().max(1) as f32).min(1.0);
    let w = ((image.width() as f32 * scale).round() as u32).max(1);
    let h = ((image.height() as f32 * scale).round() as u32).max(1);
    let small = image::imageops::resize(&image, w, h, image::imageops::FilterType::Triangle);
    let rgb = crate::util::flatten_on_white(&small);
    let file = std::fs::File::create(&target)?;
    let mut writer = std::io::BufWriter::new(file);
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut writer, 78).encode_image(&rgb)?;
    Ok(target)
}

/// Remove cached thumbnails whose source is long gone and stale temp captures.
pub fn cleanup_caches() {
    let day = std::time::Duration::from_secs(24 * 3600);
    let sweep = |dir: PathBuf, max_age: std::time::Duration| {
        if let Ok(entries) = std::fs::read_dir(dir) {
            for entry in entries.flatten() {
                let old = entry
                    .metadata()
                    .and_then(|m| m.modified())
                    .ok()
                    .and_then(|t| t.elapsed().ok())
                    .map(|age| age > max_age)
                    .unwrap_or(false);
                if old && entry.path().is_file() {
                    let _ = std::fs::remove_file(entry.path());
                }
            }
        }
    };
    sweep(crate::util::temp_capture_dir(), day);
    sweep(crate::util::temp_capture_dir().join("segments"), day * 7);
    sweep(crate::util::thumbs_dir(), day * 60);
}
