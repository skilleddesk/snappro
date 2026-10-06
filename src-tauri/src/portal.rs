//! XDG desktop portal calls (Linux). On Wayland a program may not read the screen
//! itself: screenshots and screen recordings are handed out by the portal.

use std::collections::HashMap;

use image::RgbaImage;
use serde::de::DeserializeOwned;
use zbus::blocking::{Connection, Proxy};
use zbus::zvariant::{DeserializeDict, DynamicType, Type, Value};

pub const DEST: &str = "org.freedesktop.portal.Desktop";
pub const PATH: &str = "/org/freedesktop/portal/desktop";

/// Error text when the person closed the portal dialog instead of allowing it.
pub const CANCELLED: &str = "cancelled";

/// True in a Wayland session, also when SnapPro's own windows run through XWayland.
pub fn is_wayland() -> bool {
    let session = std::env::var("XDG_SESSION_TYPE").unwrap_or_default();
    session.eq_ignore_ascii_case("wayland")
        || std::env::var_os("WAYLAND_DISPLAY").map(|v| !v.is_empty()).unwrap_or(false)
}

pub fn token() -> String {
    format!("snappro{}", uuid::Uuid::new_v4().simple())
}

/// D-Bus sender name in the form the portal uses inside object paths.
pub fn sender_id(conn: &Connection) -> anyhow::Result<String> {
    let name = conn
        .unique_name()
        .ok_or_else(|| anyhow::anyhow!("no D-Bus name"))?;
    Ok(name.trim_start_matches(':').replace('.', "_"))
}

/// Call a portal method that answers through a `Request` object and wait for
/// that answer. The `Response` signal is subscribed to *before* the call: a fast
/// answer (a non-interactive screenshot) otherwise arrives first and the wait
/// never ends.
pub fn request<B, R>(conn: &Connection, interface: &str, method: &str, body: &B, token: &str) -> anyhow::Result<R>
where
    B: serde::Serialize + DynamicType,
    R: DeserializeOwned + Type,
{
    let path = format!("{PATH}/request/{}/{}", sender_id(conn)?, token);
    let request = Proxy::new(conn, DEST, path.as_str(), "org.freedesktop.portal.Request")?;
    let mut responses = request.receive_signal("Response")?;
    let portal = Proxy::new(conn, DEST, PATH, interface)?;
    portal.call_method(method, body)?;
    let message = responses
        .next()
        .ok_or_else(|| anyhow::anyhow!("the desktop portal did not answer"))?;
    let (code, results): (u32, R) = message.body().deserialize()?;
    match code {
        0 => Ok(results),
        1 => anyhow::bail!(CANCELLED),
        _ => anyhow::bail!("the desktop portal refused the request"),
    }
}

#[derive(DeserializeDict, Type, Debug)]
#[zvariant(signature = "dict")]
struct ScreenshotResults {
    uri: Option<String>,
}

/// Local path of a `file://` URI.
pub fn uri_to_path(uri: &str) -> Option<std::path::PathBuf> {
    let rest = uri.strip_prefix("file://")?;
    let bytes = rest.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(value) = u8::from_str_radix(&rest[i + 1..i + 3], 16) {
                out.push(value);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    Some(std::path::PathBuf::from(String::from_utf8_lossy(&out).into_owned()))
}

/// Screenshot of the whole desktop (every monitor) through the portal.
///
/// `interactive` opens the desktop's own screenshot dialog, where the person
/// can pick a window or an area. The portal writes the picture into the
/// Pictures folder; it is read and removed again so no stray file is left there.
pub fn screenshot(interactive: bool) -> anyhow::Result<RgbaImage> {
    // One request at a time: GNOME leaves a second, overlapping one unanswered.
    static BUSY: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _turn = BUSY.lock().unwrap_or_else(|e| e.into_inner());
    let conn = Connection::session()?;
    let token = token();
    let mut options: HashMap<&str, Value> = HashMap::new();
    options.insert("handle_token", Value::from(token.as_str()));
    options.insert("interactive", Value::from(interactive));
    options.insert("modal", Value::from(false));
    let results: ScreenshotResults = request(
        &conn,
        "org.freedesktop.portal.Screenshot",
        "Screenshot",
        &("", options),
        &token,
    )
    .map_err(|e| {
        if e.to_string() == CANCELLED {
            anyhow::anyhow!("Screenshot cancelled")
        } else {
            anyhow::anyhow!("The desktop did not allow a screenshot: {e}")
        }
    })?;
    let path = results
        .uri
        .as_deref()
        .and_then(uri_to_path)
        .ok_or_else(|| anyhow::anyhow!("the desktop portal returned no picture"))?;
    let picture = image::open(&path).map(|img| img.to_rgba8());
    let _ = std::fs::remove_file(&path);
    Ok(picture?)
}
