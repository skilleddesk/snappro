//! Scrolling capture on Wayland.
//!
//! Wayland lets no program fake mouse input or read the screen on its own. The
//! old way (X11 fake wheel events plus one portal screenshot per frame) made
//! GNOME ask for "remote interaction" again and again, flashed the screen for
//! every frame, and when the wheel events were refused nothing scrolled, so the
//! result was a single screen instead of the whole page.
//!
//! Here one RemoteDesktop portal session does both jobs: it shares the screen as
//! a PipeWire stream (frames without flash or shutter sound) and accepts pointer
//! and wheel events. The desktop asks once; with "Remember" ticked the restore
//! token lets later captures start without any dialog.

use std::collections::HashMap;
use std::io::Read;
use std::process::Child;
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use image::RgbaImage;
use zbus::blocking::{Connection, Proxy};
use zbus::zvariant::{DeserializeDict, ObjectPath, OwnedObjectPath, OwnedValue, Type, Value};

use crate::capture::scrolling::ScrollDriver;
use crate::portal::{request, token, CANCELLED, DEST, PATH};

const REMOTE: &str = "org.freedesktop.portal.RemoteDesktop";
const SCREENCAST: &str = "org.freedesktop.portal.ScreenCast";
const DEVICE_POINTER: u32 = 2;
const SOURCE_MONITOR: u32 = 1;
const CURSOR_EMBEDDED: u32 = 2;
const AXIS_VERTICAL: u32 = 0;
/// How often GStreamer repeats the last picture when the screen does not change.
const STREAM_FPS: u32 = 8;

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
}

#[derive(DeserializeDict, Type, Debug)]
#[zvariant(signature = "dict")]
struct StartResults {
    devices: Option<u32>,
    streams: Option<Vec<(u32, StreamProps)>>,
    restore_token: Option<String>,
}

/// The newest PNG frame from GStreamer and how many frames have arrived so far.
#[derive(Default)]
struct Latest {
    count: u64,
    png: Vec<u8>,
    ended: bool,
}

/// An open RemoteDesktop session with its screen stream.
pub struct WaylandScroller {
    conn: Connection,
    session: OwnedObjectPath,
    node: u32,
    /// Shared screen in desktop (layout) coordinates.
    screen: (i32, i32, u32, u32),
    /// The capture area in desktop coordinates.
    region: (i32, i32, u32, u32),
    gst: Option<Child>,
    latest: Arc<(Mutex<Latest>, Condvar)>,
    /// Alternates the resting spot by one pixel, so every nudge is a real move.
    wiggle: bool,
}

fn token_path() -> std::path::PathBuf {
    crate::portal::token_file("remote-desktop")
}

fn portal_error(err: anyhow::Error) -> anyhow::Error {
    if err.to_string() == CANCELLED {
        anyhow::anyhow!("Scrolling capture was cancelled: the desktop needs permission to scroll and to see the screen.")
    } else {
        anyhow::anyhow!("The desktop did not allow scrolling capture: {err}")
    }
}

/// Split a byte stream of concatenated PNG files. Returns complete files and
/// leaves an unfinished one in `buffer`.
pub fn take_pngs(buffer: &mut Vec<u8>) -> Vec<Vec<u8>> {
    const SIGNATURE: &[u8] = b"\x89PNG\r\n\x1a\n";
    let mut out = Vec::new();
    loop {
        let Some(start) = buffer.windows(SIGNATURE.len()).position(|w| w == SIGNATURE) else {
            // Keep a possible partial signature at the end, drop the rest.
            let keep = buffer.len().min(SIGNATURE.len() - 1);
            buffer.drain(..buffer.len() - keep);
            return out;
        };
        let mut pos = start + SIGNATURE.len();
        let mut end = None;
        while pos + 8 <= buffer.len() {
            let len = u32::from_be_bytes([buffer[pos], buffer[pos + 1], buffer[pos + 2], buffer[pos + 3]]) as usize;
            let kind = &buffer[pos + 4..pos + 8];
            let next = pos + 12 + len;
            if next > buffer.len() {
                break;
            }
            if kind == b"IEND" {
                end = Some(next);
                break;
            }
            pos = next;
        }
        match end {
            Some(end) => {
                out.push(buffer[start..end].to_vec());
                buffer.drain(..end);
            }
            None => {
                buffer.drain(..start);
                return out;
            }
        }
    }
}

impl WaylandScroller {
    /// Open the session (the desktop may ask once) and start the frame stream.
    pub fn open(region: (i32, i32, u32, u32)) -> anyhow::Result<Self> {
        let conn = Connection::session()?;

        let handle = token();
        let session_token = token();
        let mut options: HashMap<&str, Value> = HashMap::new();
        options.insert("handle_token", Value::from(handle.as_str()));
        options.insert("session_handle_token", Value::from(session_token.as_str()));
        let created: SessionResults = request(&conn, REMOTE, "CreateSession", &options, &handle).map_err(portal_error)?;
        let session = OwnedObjectPath::try_from(
            created
                .session_handle
                .ok_or_else(|| anyhow::anyhow!("the desktop portal opened no session"))?,
        )?;
        let path = ObjectPath::from(&session);

        // Pointer only; remembered until revoked, so the dialog appears once.
        let saved = std::fs::read_to_string(token_path()).unwrap_or_default();
        let handle = token();
        let mut options: HashMap<&str, Value> = HashMap::new();
        options.insert("handle_token", Value::from(handle.as_str()));
        options.insert("types", Value::from(DEVICE_POINTER));
        options.insert("persist_mode", Value::from(2u32));
        if !saved.trim().is_empty() {
            options.insert("restore_token", Value::from(saved.trim()));
        }
        let _: HashMap<String, OwnedValue> =
            request(&conn, REMOTE, "SelectDevices", &(&path, options), &handle).map_err(portal_error)?;

        // The pointer is drawn into the stream on purpose: GNOME only sends a new
        // frame when something on screen changes, and nudging the pointer (parked
        // just outside the area, see `rest`) is a change that never shows in the area.
        let handle = token();
        let mut options: HashMap<&str, Value> = HashMap::new();
        options.insert("handle_token", Value::from(handle.as_str()));
        options.insert("types", Value::from(SOURCE_MONITOR));
        options.insert("multiple", Value::from(false));
        options.insert("cursor_mode", Value::from(CURSOR_EMBEDDED));
        let _: HashMap<String, OwnedValue> =
            request(&conn, SCREENCAST, "SelectSources", &(&path, options), &handle).map_err(portal_error)?;

        let handle = token();
        let mut options: HashMap<&str, Value> = HashMap::new();
        options.insert("handle_token", Value::from(handle.as_str()));
        let started: StartResults =
            request(&conn, REMOTE, "Start", &(&path, "", options), &handle).map_err(portal_error)?;
        if let Some(saved) = started.restore_token.as_deref().filter(|t| !t.is_empty()) {
            let _ = crate::util::ensure_dir(&crate::util::app_data_dir());
            let _ = std::fs::write(token_path(), saved);
        }
        let close = |e: anyhow::Error| {
            crate::portal::close_session(&conn, &session);
            e
        };
        if started.devices.unwrap_or(0) & DEVICE_POINTER == 0 {
            return Err(close(anyhow::anyhow!(
                "The desktop did not allow SnapPro to scroll. Allow remote interaction and try again."
            )));
        }
        let (node, props) = started
            .streams
            .and_then(|streams| streams.into_iter().next())
            .ok_or_else(|| close(anyhow::anyhow!("the desktop shared no screen")))?;
        let screen = match (props.position, props.size) {
            (Some((x, y)), Some((w, h))) if w > 0 && h > 0 => (x, y, w as u32, h as u32),
            (_, Some((w, h))) if w > 0 && h > 0 => (0, 0, w as u32, h as u32),
            _ => crate::capture::full::virtual_bounds().map_err(close)?,
        };

        let mut scroller = Self {
            conn,
            session,
            node,
            screen,
            region,
            gst: None,
            latest: Arc::new((Mutex::new(Latest::default()), Condvar::new())),
            wiggle: false,
        };
        scroller.start_stream()?;
        Ok(scroller)
    }

    fn start_stream(&mut self) -> anyhow::Result<()> {
        let mut child = crate::portal::spawn_gstreamer(&self.conn, &self.session, &gst_args(self.node), "gstreamer-scroll.log")?;
        let mut stdout = child
            .stdout
            .take()
            .ok_or_else(|| anyhow::anyhow!("GStreamer gave no output"))?;
        self.gst = Some(child);
        let latest = self.latest.clone();
        std::thread::spawn(move || {
            let mut buffer = Vec::with_capacity(4 << 20);
            let mut chunk = vec![0u8; 1 << 16];
            loop {
                let n = match stdout.read(&mut chunk) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => n,
                };
                buffer.extend_from_slice(&chunk[..n]);
                if let Some(png) = take_pngs(&mut buffer).pop() {
                    let (lock, ready) = &*latest;
                    let mut state = lock.lock().unwrap();
                    state.count += 1;
                    state.png = png;
                    ready.notify_all();
                }
            }
            let (lock, ready) = &*latest;
            lock.lock().unwrap().ended = true;
            ready.notify_all();
        });
        Ok(())
    }

    /// A frame that arrived after this call started, cut to the capture area.
    fn fresh_frame(&mut self) -> anyhow::Result<RgbaImage> {
        let latest = self.latest.clone();
        let (lock, ready) = &*latest;
        let deadline = Instant::now() + Duration::from_secs(8);
        let seen = lock.lock().unwrap().count;
        // Two new frames: the first may have been rendered before the last scroll.
        loop {
            self.rest();
            let state = lock.lock().unwrap();
            if state.count >= seen + 2 {
                break;
            }
            if state.ended {
                anyhow::bail!("the screen stream stopped (see gstreamer-scroll.log)");
            }
            if Instant::now() >= deadline {
                if state.count > 0 {
                    break;
                }
                anyhow::bail!("the desktop sent no picture of the screen");
            }
            let _ = ready.wait_timeout(state, Duration::from_millis(120)).unwrap();
        }
        let png = lock.lock().unwrap().png.clone();
        let picture = image::load_from_memory(&png)?.to_rgba8();
        crate::capture::full::crop_desktop(&picture, self.screen, self.region)
    }

    /// Move the pointer, in the shared screen's coordinates.
    fn move_pointer(&self, x: f64, y: f64) {
        let options: HashMap<&str, Value> = HashMap::new();
        self.call(
            "NotifyPointerMotionAbsolute",
            &(ObjectPath::from(&self.session), options, self.node, x, y),
        );
    }

    /// Park the pointer just past the bottom-right corner of the area: the arrow
    /// is drawn to the right of and below its tip, so it never shows in the area.
    fn rest(&mut self) {
        self.wiggle = !self.wiggle;
        let step = if self.wiggle { 1.0 } else { 0.0 };
        let x = (self.region.0 - self.screen.0) as f64 + self.region.2 as f64 + 1.0 + step;
        let y = (self.region.1 - self.screen.1) as f64 + self.region.3 as f64 + 1.0 + step;
        self.move_pointer(x, y);
    }

    fn call(&self, method: &str, body: &(impl serde::Serialize + zbus::zvariant::DynamicType)) {
        if let Ok(proxy) = Proxy::new(&self.conn, DEST, PATH, REMOTE) {
            if let Err(err) = proxy.call_method(method, body) {
                crate::settings::log_line(&format!("RemoteDesktop.{method} failed: {err}"));
            }
        }
    }
}

impl ScrollDriver for WaylandScroller {
    fn frame(&mut self) -> anyhow::Result<RgbaImage> {
        self.fresh_frame()
    }

    fn quick_settle(&self) -> Duration {
        // Pictures come through the compositor and GStreamer, a little later.
        Duration::from_millis(220)
    }

    fn park(&mut self) {
        // The pointer rests outside the area and only visits it to turn the wheel.
        self.rest();
    }

    fn scroll(&mut self, notches: i32) {
        if notches == 0 {
            return;
        }
        // The wheel scrolls what is under the pointer: the middle of the area.
        let x = (self.region.0 - self.screen.0) as f64 + self.region.2 as f64 / 2.0;
        let y = (self.region.1 - self.screen.1) as f64 + self.region.3 as f64 / 2.0;
        self.move_pointer(x, y);
        std::thread::sleep(Duration::from_millis(30));
        let options: HashMap<&str, Value> = HashMap::new();
        self.call(
            "NotifyPointerAxisDiscrete",
            &(ObjectPath::from(&self.session), options, AXIS_VERTICAL, notches),
        );
        std::thread::sleep(Duration::from_millis(30));
        self.rest();
    }
}

impl Drop for WaylandScroller {
    fn drop(&mut self) {
        if let Some(child) = self.gst.take() {
            crate::portal::stop_gstreamer(child);
        }
        crate::portal::close_session(&self.conn, &self.session);
    }
}

/// gst-launch-1.0 pipeline: the stream (fd 3) as lossless PNG frames on stdout.
pub fn gst_args(node: u32) -> Vec<String> {
    [
        "-q".to_string(),
        "pipewiresrc".into(),
        "fd=3".into(),
        format!("path={node}"),
        "do-timestamp=true".into(),
        "always-copy=true".into(),
        format!("keepalive-time={}", 1000 / STREAM_FPS),
        "!".into(),
        // Only the newest picture is kept: while something animates on screen the
        // desktop sends far more frames than PNG encoding keeps up with, and a
        // backlog made every "fresh" frame seconds old.
        "queue".into(),
        "leaky=downstream".into(),
        "max-size-buffers=1".into(),
        "max-size-bytes=0".into(),
        "max-size-time=0".into(),
        "!".into(),
        "videoconvert".into(),
        "!".into(),
        "video/x-raw,format=RGBA".into(),
        "!".into(),
        "pngenc".into(),
        "compression-level=1".into(),
        "snapshot=false".into(),
        "!".into(),
        "fdsink".into(),
        "fd=1".into(),
        "sync=false".into(),
    ]
    .into()
}
