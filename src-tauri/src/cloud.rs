use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct UploadResult {
    pub url: String,
    pub delete_url: Option<String>,
    pub provider: String,
}

fn mime_for(path: &Path) -> &'static str {
    match path
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default()
        .as_str()
    {
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "bmp" => "image/bmp",
        _ => "image/png",
    }
}

/// Upload an image to Imgur's anonymous API.
pub fn upload_imgur(path: &Path, client_id: &str) -> anyhow::Result<UploadResult> {
    let bytes = std::fs::read(path)?;
    let file_name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "snappro.png".to_string());

    let boundary = format!("----SnapProBoundary{}", uuid::Uuid::new_v4().simple());
    let mut body: Vec<u8> = Vec::new();
    body.extend_from_slice(format!("--{}\r\n", boundary).as_bytes());
    body.extend_from_slice(
        format!(
            "Content-Disposition: form-data; name=\"image\"; filename=\"{}\"\r\n",
            file_name
        )
        .as_bytes(),
    );
    body.extend_from_slice(format!("Content-Type: {}\r\n\r\n", mime_for(path)).as_bytes());
    body.extend_from_slice(&bytes);
    body.extend_from_slice(format!("\r\n--{}--\r\n", boundary).as_bytes());

    let response = ureq::post("https://api.imgur.com/3/image")
        .header("Authorization", &format!("Client-ID {}", client_id))
        .header(
            "Content-Type",
            &format!("multipart/form-data; boundary={}", boundary),
        )
        .send(&body[..])
        .map_err(|e| anyhow::anyhow!(e.to_string()))?;

    let text = response
        .into_body()
        .read_to_string()
        .map_err(|e| anyhow::anyhow!(e.to_string()))?;
    let json: serde_json::Value = serde_json::from_str(&text)?;
    let link = json
        .get("data")
        .and_then(|d| d.get("link"))
        .and_then(|l| l.as_str())
        .ok_or_else(|| {
            let message = json
                .get("data")
                .and_then(|d| d.get("error"))
                .and_then(|e| e.as_str())
                .unwrap_or("Imgur upload failed");
            anyhow::anyhow!(message.to_string())
        })?;

    Ok(UploadResult {
        url: link.to_string(),
        delete_url: json
            .get("data")
            .and_then(|d| d.get("deletehash"))
            .and_then(|d| d.as_str())
            .map(|h| format!("https://imgur.com/delete/{}", h)),
        provider: "imgur".to_string(),
    })
}

/// Upload to a user provided HTTP endpoint (simple PUT/POST of the raw bytes).
pub fn upload_custom(path: &Path, endpoint: &str, token: &str) -> anyhow::Result<UploadResult> {
    if endpoint.trim().is_empty() {
        anyhow::bail!("no upload endpoint configured");
    }
    let bytes = std::fs::read(path)?;
    let mut request = ureq::put(endpoint)
        .header("Content-Type", mime_for(path))
        .header("X-Filename", path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default().as_str());
    if !token.trim().is_empty() {
        request = request.header("Authorization", &format!("Bearer {}", token));
    }
    let response = request
        .send(&bytes[..])
        .map_err(|e| anyhow::anyhow!(e.to_string()))?;
    let url = response
        .into_body()
        .read_to_string()
        .unwrap_or_default()
        .trim()
        .to_string();
    Ok(UploadResult {
        url: if url.starts_with("http") {
            url
        } else {
            endpoint.to_string()
        },
        delete_url: None,
        provider: "custom".to_string(),
    })
}

pub fn upload_dir() -> PathBuf {
    crate::util::app_data_dir().join("uploads")
}

// ---------------------------------------------------------------------------
// Amazon S3 (AWS Signature Version 4)
// ---------------------------------------------------------------------------

/// Percent-encode a single path segment the way AWS expects it in a canonical URI.
fn uri_encode(value: &str, encode_slash: bool) -> String {
    let mut out = String::new();
    for byte in value.bytes() {
        let safe = byte.is_ascii_alphanumeric()
            || byte == b'-'
            || byte == b'_'
            || byte == b'.'
            || byte == b'~'
            || (byte == b'/' && !encode_slash);
        if safe {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{:02X}", byte));
        }
    }
    out
}

fn hmac_sha256(key: &[u8], data: &[u8]) -> Vec<u8> {
    use hmac::{Hmac, Mac};
    let mut mac = Hmac::<sha2::Sha256>::new_from_slice(key).expect("hmac accepts any key length");
    mac.update(data);
    mac.finalize().into_bytes().to_vec()
}

fn sha256_hex(data: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(data);
    hex::encode(hasher.finalize())
}

/// Upload an image to an S3 bucket using a signed PUT request.
pub fn upload_s3(
    path: &Path,
    bucket: &str,
    region: &str,
    access_key: &str,
    secret_key: &str,
    prefix: &str,
) -> anyhow::Result<UploadResult> {
    if bucket.trim().is_empty() || access_key.trim().is_empty() || secret_key.trim().is_empty() {
        anyhow::bail!("bucket, access key and secret key are all required for S3 uploads");
    }
    let region = if region.trim().is_empty() { "us-east-1" } else { region.trim() };

    let bytes = std::fs::read(path)?;
    let file_name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "snappro.png".to_string());
    let clean_prefix = prefix.trim_matches('/');
    let key = if clean_prefix.is_empty() {
        format!("{}_{}", uuid::Uuid::new_v4().simple(), file_name)
    } else {
        format!("{}/{}_{}", clean_prefix, uuid::Uuid::new_v4().simple(), file_name)
    };

    let host = format!("{}.s3.{}.amazonaws.com", bucket, region);
    let canonical_uri = format!("/{}", uri_encode(&key, false));
    let payload_hash = sha256_hex(&bytes);

    let now = chrono::Utc::now();
    let amz_date = now.format("%Y%m%dT%H%M%SZ").to_string();
    let date_stamp = now.format("%Y%m%d").to_string();

    let canonical_headers = format!(
        "content-type:{}\nhost:{}\nx-amz-content-sha256:{}\nx-amz-date:{}\n",
        mime_for(path),
        host,
        payload_hash,
        amz_date
    );
    let signed_headers = "content-type;host;x-amz-content-sha256;x-amz-date";
    let canonical_request = format!(
        "PUT\n{}\n\n{}\n{}\n{}",
        canonical_uri, canonical_headers, signed_headers, payload_hash
    );

    let scope = format!("{}/{}/s3/aws4_request", date_stamp, region);
    let string_to_sign = format!(
        "AWS4-HMAC-SHA256\n{}\n{}\n{}",
        amz_date,
        scope,
        sha256_hex(canonical_request.as_bytes())
    );

    let k_date = hmac_sha256(format!("AWS4{}", secret_key).as_bytes(), date_stamp.as_bytes());
    let k_region = hmac_sha256(&k_date, region.as_bytes());
    let k_service = hmac_sha256(&k_region, b"s3");
    let k_signing = hmac_sha256(&k_service, b"aws4_request");
    let signature = hex::encode(hmac_sha256(&k_signing, string_to_sign.as_bytes()));

    let authorization = format!(
        "AWS4-HMAC-SHA256 Credential={}/{}, SignedHeaders={}, Signature={}",
        access_key, scope, signed_headers, signature
    );

    let url = format!("https://{}{}", host, canonical_uri);
    let response = ureq::put(&url)
        .header("Content-Type", mime_for(path))
        .header("x-amz-content-sha256", &payload_hash)
        .header("x-amz-date", &amz_date)
        .header("Authorization", &authorization)
        .send(&bytes[..])
        .map_err(|e| anyhow::anyhow!(e.to_string()))?;

    let status = response.status();
    let code = status.as_u16();
    if !(200..300).contains(&code) {
        anyhow::bail!("S3 upload failed with status {}", code);
    }

    Ok(UploadResult {
        url: url.clone(),
        delete_url: None,
        provider: "s3".to_string(),
    })
}

// ---------------------------------------------------------------------------
// Google Drive (OAuth 2.0 access token)
// ---------------------------------------------------------------------------

/// Upload an image to Google Drive and make it readable by anyone with the link.
/// The caller supplies an OAuth 2.0 access token (see README for the flow).
pub fn upload_gdrive(path: &Path, access_token: &str) -> anyhow::Result<UploadResult> {
    if access_token.trim().is_empty() {
        anyhow::bail!("a Google OAuth access token is required");
    }
    let bytes = std::fs::read(path)?;
    let file_name = path
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| "snappro.png".to_string());

    let boundary = format!("----SnapProDrive{}", uuid::Uuid::new_v4().simple());
    let metadata = serde_json::json!({
        "name": file_name,
        "mimeType": mime_for(path),
    })
    .to_string();

    let mut body: Vec<u8> = Vec::new();
    body.extend_from_slice(format!("--{}\r\n", boundary).as_bytes());
    body.extend_from_slice(b"Content-Type: application/json; charset=UTF-8\r\n\r\n");
    body.extend_from_slice(metadata.as_bytes());
    body.extend_from_slice(format!("\r\n--{}\r\n", boundary).as_bytes());
    body.extend_from_slice(
        format!("Content-Type: {}\r\n\r\n", mime_for(path)).as_bytes(),
    );
    body.extend_from_slice(&bytes);
    body.extend_from_slice(format!("\r\n--{}--\r\n", boundary).as_bytes());

    let response = ureq::post("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink")
        .header("Authorization", &format!("Bearer {}", access_token.trim()))
        .header(
            "Content-Type",
            &format!("multipart/related; boundary={}", boundary),
        )
        .send(&body[..])
        .map_err(|e| anyhow::anyhow!(e.to_string()))?;

    let text = response
        .into_body()
        .read_to_string()
        .map_err(|e| anyhow::anyhow!(e.to_string()))?;
    let json: serde_json::Value = serde_json::from_str(&text)?;
    let file_id = json
        .get("id")
        .and_then(|v| v.as_str())
        .ok_or_else(|| {
            let message = json
                .get("error")
                .and_then(|e| e.get("message"))
                .and_then(|m| m.as_str())
                .unwrap_or("Google Drive upload failed");
            anyhow::anyhow!(message.to_string())
        })?
        .to_string();

    // Share it so the returned link works for other people.
    let _ = ureq::post(&format!(
        "https://www.googleapis.com/drive/v3/files/{}/permissions",
        file_id
    ))
    .header("Authorization", &format!("Bearer {}", access_token.trim()))
    .header("Content-Type", "application/json")
    .send(r#"{"role":"reader","type":"anyone"}"#);

    Ok(UploadResult {
        url: json
            .get("webViewLink")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .unwrap_or_else(|| format!("https://drive.google.com/file/d/{}/view", file_id)),
        delete_url: Some(format!("https://drive.google.com/file/d/{}/view", file_id)),
        provider: "gdrive".to_string(),
    })
}