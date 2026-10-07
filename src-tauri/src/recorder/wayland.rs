//! Screen recording on Wayland.
//!
//! ffmpeg's x11grab only sees black (or nothing) under Wayland, and recent
//! desktops (Ubuntu 25.10+, Fedora 43+) no longer offer an X11 session at all.
//! The screen is shared through the ScreenCast desktop portal instead: the
//! desktop asks the person once which screen or window to share, hands out a
//! PipeWire stream, GStreamer turns it into a steady-rate raw video stream and
//! ffmpeg reads that from its stdin and does everything else as before (sound,
//! camera, encoding, segments).
//!
//! One portal session lives for a whole take, so pause / resume does not ask
//! again; with the restore token the desktop does not ask again on later takes
//! either.

use std::collections::HashMap;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

use zbus::blocking::{Connection, Proxy};
use zbus::zvariant::{DeserializeDict, ObjectPath, OwnedObjectPath, OwnedValue, Type, Value};

use super::RegionRect;
use crate::portal::{request, token, CANCELLED, DEST, PATH};

const SCREENCAST: &str = "org.freedesktop.portal.ScreenCast";
const SOURCE_MONITOR: u32 = 1;
const SOURCE_WINDOW: u32 = 2;
const CURSOR_HIDDEN: u32 = 1;
const CURSOR_EMBEDDED: u32 = 2;

/// An open portal session and the PipeWire stream it shares.
struct Cast {
    conn: Connection,
    session: OwnedObjectPath,
    node: u32,
    /// Where the shared screen sits on the desktop and how large it is (layout units).
    position: Option<(i32, i32)>,
    size: Option<(i32, i32)>,
    source_type: u32,
    cursor: bool,
}

static CAST: Mutex<Option<Cast>> = Mutex::new(None);
/// The GStreamer process feeding the running ffmpeg segment.
static SOURCE: Mutex<Option<Child>> = Mutex::new(None);

#[derive(DeserializeDict, Type, Debug)]
#[zvariant(signature = "dict")]
struct SessionResults {
    session_handle: Option<String>,
}

#[derive(DeserializeDict, Type, Debug)]
#[zvariant(signature = "dict")]
struct StreamProps {
    position: Option<(i32, i32)>,
    size: Option<(i32, i32)>,
    source_type: Option<u32>,
}

#[derive(DeserializeDict, Type, Debug)]
#[zvariant(signature = "dict")]
struct StartResults {
    streams: Option<Vec<(u32, StreamProps)>>,
    restore_token: Option<String>,
}

fn restore_token_path(source_type: u32) -> std::path::PathBuf {
    crate::util::app_data_dir().join(format!("screencast-{source_type}.token"))
}

fn portal_error(what: &str, err: anyhow::Error) -> anyhow::Error {
    if err.to_string() == CANCELLED {
        anyhow::anyhow!("Screen sharing was cancelled, nothing is recorded.")
    } else {
        anyhow::anyhow!("The desktop did not allow screen recording ({what}): {err}")
    }
}

fn open_cast(source_type: u32, cursor: bool) -> anyhow::Result<Cast> {
    let conn = Connection::session()?;
    let portal = Proxy::new(&conn, DEST, PATH, SCREENCAST)?;

    let handle = token();
    let session_token = token();
    let mut options: HashMap<&str, Value> = HashMap::new();
    options.insert("handle_token", Value::from(handle.as_str()));
    options.insert("session_handle_token", Value::from(session_token.as_str()));
    let created: SessionResults = request(&conn, SCREENCAST, "CreateSession", &options, &handle)
        .map_err(|e| portal_error("session", e))?;
    let session = OwnedObjectPath::try_from(
        created
            .session_handle
            .ok_or_else(|| anyhow::anyhow!("the desktop portal opened no session"))?,
    )?;

    // Embed the pointer in the picture when asked and when the desktop can.
    let available: u32 = portal.get_property("AvailableCursorModes").unwrap_or(CURSOR_HIDDEN);
    let cursor_mode = if cursor && available & CURSOR_EMBEDDED != 0 {
        CURSOR_EMBEDDED
    } else {
        CURSOR_HIDDEN
    };
    let saved = std::fs::read_to_string(restore_token_path(source_type)).unwrap_or_default();
    let handle = token();
    let mut options: HashMap<&str, Value> = HashMap::new();
    options.insert("handle_token", Value::from(handle.as_str()));
    options.insert("types", Value::from(source_type));
    options.insert("multiple", Value::from(false));
    options.insert("cursor_mode", Value::from(cursor_mode));
    // 2 = keep the permission until it is revoked, so later takes do not ask again.
    options.insert("persist_mode", Value::from(2u32));
    if !saved.trim().is_empty() {
        options.insert("restore_token", Value::from(saved.trim()));
    }
    let path = ObjectPath::from(&session);
    let _: HashMap<String, OwnedValue> = request(&conn, SCREENCAST, "SelectSources", &(&path, options), &handle)
        .map_err(|e| portal_error("sources", e))?;

    let handle = token();
    let mut options: HashMap<&str, Value> = HashMap::new();
    options.insert("handle_token", Value::from(handle.as_str()));
    let started: StartResults = request(&conn, SCREENCAST, "Start", &(&path, "", options), &handle)
        .map_err(|e| portal_error("start", e))?;

    if let Some(token) = started.restore_token.as_deref().filter(|t| !t.is_empty()) {
        let _ = crate::util::ensure_dir(&crate::util::app_data_dir());
        let _ = std::fs::write(restore_token_path(source_type), token);
    }
    let (node, props) = started
        .streams
        .and_then(|streams| streams.into_iter().next())
        .ok_or_else(|| anyhow::anyhow!("the desktop shared no screen"))?;
    Ok(Cast {
        conn,
        session,
        node,
        position: props.position,
        size: props.size,
        source_type: props.source_type.unwrap_or(source_type),
        cursor,
    })
}

fn close_cast(cast: Cast) {
    crate::portal::close_session(&cast.conn, &cast.session);
}

/// End the portal session (the desktop's "sharing your screen" indicator goes away).
pub fn end_session() {
    stop_source();
    if let Some(cast) = CAST.lock().unwrap().take() {
        close_cast(cast);
    }
}

/// Ask GStreamer to finish (EOS), which closes ffmpeg's input so the segment is
/// finalised; ffmpeg cannot be sent `q` because its stdin carries the video.
pub fn stop_source() {
    if let Some(child) = SOURCE.lock().unwrap().take() {
        crate::portal::stop_gstreamer(child);
    }
}

/// ffmpeg crop filter that cuts `region` (desktop coordinates) out of the shared
/// screen at `position` / `size`. The stream may have more pixels than the layout
/// (HiDPI), so the crop is written relative to the input size.
pub fn crop_filter(region: &RegionRect, position: Option<(i32, i32)>, size: Option<(i32, i32)>) -> Option<String> {
    if region.width == 0 || region.height == 0 {
        return None;
    }
    let (sx, sy) = position.unwrap_or((0, 0));
    let Some((sw, sh)) = size.filter(|(w, h)| *w > 0 && *h > 0) else {
        return Some(format!(
            "crop={}:{}:{}:{}",
            region.width,
            region.height,
            (region.x - sx).max(0),
            (region.y - sy).max(0)
        ));
    };
    let screen = (sx, sy, sw as u32, sh as u32);
    let (x, y, w, h) = crate::capture::full::intersect_rect((region.x, region.y, region.width, region.height), screen)?;
    if (x, y, w, h) == screen {
        return None;
    }
    Some(format!(
        "crop=trunc(iw*{w}/{sw}):trunc(ih*{h}/{sh}):trunc(iw*{ox}/{sw}):trunc(ih*{oy}/{sh})",
        ox = x - sx,
        oy = y - sy
    ))
}

/// Make sure a portal session for this kind of source is open and start a
/// GStreamer process that writes the shared screen as YUV4MPEG to its stdout.
/// Returns that stdout (for ffmpeg's stdin) and the crop for `region`, if any.
pub fn start_source(window: bool, cursor: bool, fps: u32, region: Option<&RegionRect>) -> anyhow::Result<(Stdio, Option<String>)> {
    stop_source();
    let source_type = if window { SOURCE_WINDOW } else { SOURCE_MONITOR };
    let mut guard = CAST.lock().unwrap();
    let reusable = guard
        .as_ref()
        .map(|c| c.source_type == source_type && c.cursor == cursor)
        .unwrap_or(false);
    if !reusable {
        if let Some(old) = guard.take() {
            close_cast(old);
        }
        *guard = Some(open_cast(source_type, cursor)?);
    }
    let cast = guard.as_ref().expect("cast is open");

    let fps = fps.clamp(1, 120);
    let mut child = crate::portal::spawn_gstreamer(&cast.conn, &cast.session, &gst_args(cast.node, fps), "gstreamer.log")?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| anyhow::anyhow!("GStreamer gave no output"))?;
    let crop = if window || cast.source_type == SOURCE_WINDOW {
        None
    } else {
        region.and_then(|r| crop_filter(r, cast.position, cast.size))
    };
    *SOURCE.lock().unwrap() = Some(child);
    Ok((Stdio::from(stdout), crop))
}

/// gst-launch-1.0 pipeline: the PipeWire stream (fd 3) at a steady frame rate
/// (videorate repeats frames while the screen does not change) as YUV4MPEG on stdout.
pub fn gst_args(node: u32, fps: u32) -> Vec<String> {
    let keepalive = (1000 / fps.max(1)).max(10);
    [
        "-e".to_string(),
        "-q".into(),
        "pipewiresrc".into(),
        "fd=3".into(),
        format!("path={node}"),
        "do-timestamp=true".into(),
        "always-copy=true".into(),
        format!("keepalive-time={keepalive}"),
        "!".into(),
        "videorate".into(),
        "!".into(),
        format!("video/x-raw,framerate={fps}/1"),
        "!".into(),
        "videoconvert".into(),
        "!".into(),
        "video/x-raw,format=I420".into(),
        "!".into(),
        "y4menc".into(),
        "!".into(),
        "fdsink".into(),
        "fd=1".into(),
        "sync=false".into(),
    ]
    .into()
}

/// Why recording cannot work in this Wayland session, if anything is missing.
pub fn missing_parts() -> Option<String> {
    static CHECK: std::sync::OnceLock<Option<String>> = std::sync::OnceLock::new();
    CHECK
        .get_or_init(|| {
            let has = |element: &str| {
                Command::new("gst-inspect-1.0")
                    .arg(element)
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .status()
                    .map(|s| s.success())
                    .unwrap_or(false)
            };
            let missing: Vec<&str> = ["pipewiresrc", "videorate", "videoconvert", "y4menc"]
                .into_iter()
                .filter(|e| !has(e))
                .collect();
            if missing.is_empty() {
                return None;
            }
            Some(format!(
                "Screen recording on Wayland needs GStreamer with its PipeWire plugin (missing: {}). \
                 Install it with: sudo apt install gstreamer1.0-tools gstreamer1.0-pipewire gstreamer1.0-plugins-good \
                 (Fedora: sudo dnf install gstreamer1-plugins-good pipewire-gstreamer, \
                 Arch: sudo pacman -S gstreamer gst-plugins-good gst-plugin-pipewire).",
                missing.join(", ")
            ))
        })
        .clone()
}
