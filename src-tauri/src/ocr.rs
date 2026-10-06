use std::path::Path;

use serde::Serialize;

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct OcrResult {
    pub text: String,
    pub language: String,
    pub words: usize,
    pub engine: String,
}

/// Languages SnapPro offers for OCR (tesseract language packs).
pub fn available_languages() -> Vec<String> {
    let mut langs = vec!["eng".to_string()];
    if let Some(tesseract) = crate::util::find_tesseract() {
        if let Some(data) = crate::util::tesseract_tessdata(&tesseract) {
            if let Ok(entries) = std::fs::read_dir(data) {
                for entry in entries.flatten() {
                    let name = entry.file_name().to_string_lossy().to_string();
                    if let Some(code) = name.strip_suffix(".traineddata") {
                        if code != "eng" {
                            langs.push(code.to_string());
                        }
                    }
                }
            }
            langs.sort();
        }
    }
    langs
}

fn parse_tessdata_languages(text: &str) -> Option<String> {
    let mut in_list = false;
    for line in text.lines() {
        if line.contains("List of available languages") {
            in_list = true;
            continue;
        }
        if in_list {
            if line.trim().is_empty() {
                break;
            }
            return Some(line.trim().to_string());
        }
    }
    None
}

/// Run OCR on an image file using the tesseract CLI.
pub fn ocr_image(path: &Path, language: &str) -> anyhow::Result<OcrResult> {
    let tesseract = crate::util::find_tesseract().ok_or_else(|| {
        anyhow::anyhow!("tesseract was not found. Install Tesseract OCR to use this feature.")
    })?;
    if !path.exists() {
        anyhow::bail!("image not found: {}", path.display());
    }

    let mut cmd = crate::util::hidden_command(&tesseract);
    cmd.arg(path)
        .arg("stdout")
        .arg("-l")
        .arg(language)
        .arg("--psm")
        .arg("3");
    if let Some(data) = crate::util::tesseract_tessdata(&tesseract) {
        cmd.env("TESSDATA_PREFIX", data);
    }
    let out = cmd.output()?;
    let text = String::from_utf8_lossy(&out.stdout).to_string();
    let err = String::from_utf8_lossy(&out.stderr).to_string();

    if !out.status.success() && text.trim().is_empty() {
        let hint = parse_tessdata_languages(&err).unwrap_or_default();
        if err.contains("Failed loading language") {
            anyhow::bail!(
                "language pack '{}' is missing. Installed languages: {}",
                language,
                if hint.is_empty() { "eng".to_string() } else { hint }
            );
        }
        anyhow::bail!("OCR failed: {}", err.trim());
    }

    let words = text.split_whitespace().count();
    Ok(OcrResult {
        text,
        language: language.to_string(),
        words,
        engine: "tesseract".to_string(),
    })
}