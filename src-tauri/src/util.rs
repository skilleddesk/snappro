use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use chrono::Local;
use image::RgbaImage;

/// Build a `Command` that never opens a console window.
///
/// On Windows every `Command::new` would flash a black `cmd` window in front of
/// the user's work. Every process SnapPro starts (ffmpeg, tesseract, explorer)
/// goes through this helper so nothing pops up.
pub fn hidden_command(program: impl AsRef<std::ffi::OsStr>) -> Command {
    let mut cmd = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        const DETACHED_PROCESS: u32 = 0x0000_0008;
        cmd.creation_flags(CREATE_NO_WINDOW | DETACHED_PROCESS);
    }
    cmd.stdin(Stdio::null());
    cmd
}

/// Root folder where SnapPro stores captures: `<Pictures>/SnapPro`
pub fn snappro_dir() -> PathBuf {
    let base = dirs::picture_dir().unwrap_or_else(|| {
        let home = std::env::var("USERPROFILE")
            .or_else(|_| std::env::var("HOME"))
            .unwrap_or_else(|_| ".".to_string());
        PathBuf::from(home).join("Pictures")
    });
    base.join("SnapPro")
}

/// Where SnapPro keeps its own working files (logs, caches, temporary captures,
/// plugins). It lives in the system's per-user app-data folder, never inside the
/// folders the user chose for pictures, videos and PDFs.
pub fn app_data_dir() -> PathBuf {
    dirs::data_local_dir()
        .or_else(dirs::data_dir)
        .unwrap_or_else(std::env::temp_dir)
        .join("SnapPro")
        .join("data")
}

/// Folder for captures taken while "Auto save" is off.
pub fn temp_capture_dir() -> PathBuf {
    app_data_dir().join("temp")
}

/// Cache folder for library thumbnails.
pub fn thumbs_dir() -> PathBuf {
    app_data_dir().join("thumbs")
}

pub fn logs_dir() -> PathBuf {
    app_data_dir().join("logs")
}

/// Frozen desktop picture used by the region selector.
pub fn session_dir() -> PathBuf {
    app_data_dir().join("session")
}

pub fn plugins_dir() -> PathBuf {
    app_data_dir().join("plugins")
}

/// Earlier versions scattered working files inside the picture folder (log files,
/// .temp, .thumbs, Session, Plugins). Move what is worth keeping and delete the rest.
pub fn migrate_legacy_files(old_root: &Path) {
    if !old_root.is_dir() {
        return;
    }
    for name in ["snappro.log", "snappro.old.log", "ffmpeg.log", ".temp", ".thumbs", "Session", "Uploads"] {
        let path = old_root.join(name);
        if path.is_dir() {
            let _ = std::fs::remove_dir_all(&path);
        } else if path.is_file() {
            let _ = std::fs::remove_file(&path);
        }
    }
    // User-installed plugin manifests move to the new place; the folder is then removed if empty.
    let old_plugins = old_root.join("Plugins");
    if old_plugins.is_dir() {
        let new_plugins = plugins_dir();
        let _ = std::fs::create_dir_all(&new_plugins);
        if let Ok(entries) = std::fs::read_dir(&old_plugins) {
            for entry in entries.flatten() {
                let target = new_plugins.join(entry.file_name());
                if !target.exists() {
                    let _ = std::fs::rename(entry.path(), target);
                }
            }
        }
        let _ = std::fs::remove_dir_all(&old_plugins);
    }
}

pub fn ensure_dir(dir: &Path) -> anyhow::Result<()> {
    std::fs::create_dir_all(dir)?;
    Ok(())
}

pub fn timestamp_name(prefix: &str, ext: &str) -> String {
    format!(
        "{}_{}.{}",
        prefix,
        Local::now().format("%Y-%m-%d_%H-%M-%S%.3f"),
        ext
    )
}

/// Composite an RGBA image over white so formats without alpha (JPEG, PDF) do
/// not turn transparent pixels black.
pub fn flatten_on_white(image: &RgbaImage) -> image::RgbImage {
    let mut out = image::RgbImage::new(image.width(), image.height());
    for (x, y, px) in image.enumerate_pixels() {
        let a = px.0[3] as u32;
        let blend = |c: u8| (((c as u32) * a + 255 * (255 - a)) / 255) as u8;
        out.put_pixel(
            x,
            y,
            image::Rgb([blend(px.0[0]), blend(px.0[1]), blend(px.0[2])]),
        );
    }
    out
}

/// Save an RGBA image into `dir` with the given format, returning (id, path, size, width, height).
pub fn store_image(
    image: &RgbaImage,
    dir: &Path,
    mode: &str,
    format: &str,
) -> anyhow::Result<(String, String, u64, u32, u32)> {
    ensure_dir(dir)?;
    let id = uuid::Uuid::new_v4().to_string();
    let ext = match format {
        "jpg" | "jpeg" => "jpg",
        "webp" => "webp",
        _ => "png",
    };
    let name = timestamp_name(&format!("SnapPro_{}", mode), ext);
    let path = dir.join(name);

    match ext {
        "jpg" => {
            let rgb = flatten_on_white(image);
            let file = std::fs::File::create(&path)?;
            let mut writer = std::io::BufWriter::new(file);
            let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut writer, 92);
            encoder.encode_image(&rgb)?;
        }
        "webp" => {
            let file = std::fs::File::create(&path)?;
            let writer = std::io::BufWriter::new(file);
            image::codecs::webp::WebPEncoder::new_lossless(writer)
                .encode(
                    image.as_raw(),
                    image.width(),
                    image.height(),
                    image::ExtendedColorType::Rgba8,
                )
                .map_err(|e| anyhow::anyhow!(e.to_string()))?;
        }
        _ => {
            image.save(&path)?;
        }
    }

    let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    Ok((
        id,
        path.to_string_lossy().to_string(),
        size,
        image.width(),
        image.height(),
    ))
}

/// Places a GUI app does not see on `PATH`: Homebrew on macOS, winget links,
/// Chocolatey, Scoop, or a copy shipped next to SnapPro.
fn extra_tool_dirs() -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            out.push(parent.to_path_buf());
            out.push(parent.join("bin"));
            out.push(parent.join("resources"));
        }
    }
    for fixed in [
        "/opt/homebrew/bin",
        "/usr/local/bin",
        "/usr/bin",
        "/snap/bin",
        "C:/ffmpeg/bin",
        "C:/Program Files/ffmpeg/bin",
        "C:/ProgramData/chocolatey/bin",
        "C:/Program Files/Tesseract-OCR",
        "C:/Program Files (x86)/Tesseract-OCR",
    ] {
        out.push(PathBuf::from(fixed));
    }
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        let winget = PathBuf::from(local).join("Microsoft").join("WinGet");
        out.push(winget.join("Links"));
        if let Ok(entries) = std::fs::read_dir(winget.join("Packages")) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().to_lowercase();
                if name.contains("ffmpeg") || name.contains("tesseract") {
                    out.push(entry.path());
                    if let Ok(inner) = std::fs::read_dir(entry.path()) {
                        for sub in inner.flatten() {
                            out.push(sub.path().join("bin"));
                            out.push(sub.path());
                        }
                    }
                }
            }
        }
    }
    if let Ok(home) = std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")) {
        out.push(PathBuf::from(home).join("scoop").join("shims"));
    }
    out
}

fn find_tool(name: &str, version_flag: &str) -> Option<PathBuf> {
    if let Ok(out) = hidden_command(name)
        .arg(version_flag)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .output()
    {
        if out.status.success() {
            return Some(PathBuf::from(name));
        }
    }
    let file = if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_string()
    };
    extra_tool_dirs()
        .into_iter()
        .map(|dir| dir.join(&file))
        .find(|p| p.is_file())
}

/// Locate the ffmpeg executable (PATH first, then common install locations).
pub fn find_ffmpeg() -> Option<PathBuf> {
    find_tool("ffmpeg", "-version")
}

/// Locate the tesseract executable.
pub fn find_tesseract() -> Option<PathBuf> {
    find_tool("tesseract", "--version")
}

/// Folder holding the `*.traineddata` language packs.
pub fn tesseract_tessdata(tesseract: &Path) -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(prefix) = std::env::var("TESSDATA_PREFIX") {
        let prefix = PathBuf::from(prefix);
        candidates.push(prefix.join("tessdata"));
        candidates.push(prefix);
    }
    if let Some(parent) = tesseract.parent() {
        candidates.push(parent.join("tessdata"));
        // Homebrew: <prefix>/bin/tesseract -> <prefix>/share/tessdata
        if let Some(root) = parent.parent() {
            candidates.push(root.join("share").join("tessdata"));
        }
    }
    for fixed in [
        "/usr/share/tesseract-ocr/5/tessdata",
        "/usr/share/tesseract-ocr/4.00/tessdata",
        "/usr/share/tessdata",
        "/usr/local/share/tessdata",
        "/opt/homebrew/share/tessdata",
    ] {
        candidates.push(PathBuf::from(fixed));
    }
    candidates
        .into_iter()
        .find(|dir| dir.is_dir() && dir.join("eng.traineddata").exists())
        .or_else(|| {
            tesseract
                .parent()
                .map(|p| p.join("tessdata"))
                .filter(|d| d.is_dir())
        })
}
