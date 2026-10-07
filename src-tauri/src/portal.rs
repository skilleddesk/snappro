//! XDG desktop portal calls (Linux). On Wayland a program may not read the screen
//! itself: screenshots and screen recordings are handed out by the portal.

use std::collections::HashMap;

use image::RgbaImage;
use serde::de::DeserializeOwned;
use zbus::blocking::{Connection, Proxy};
use zbus::zvariant::{DeserializeDict, DynamicType, ObjectPath, OwnedObjectPath, Type, Value};

pub const DEST: &str = "org.freedesktop.portal.Desktop";
pub const PATH: &str = "/org/freedesktop/portal/desktop";

/// Error text when the person closed the portal dialog instead of allowing it.
pub const CANCELLED: &str = "cancelled";

/// Error text when the portal ended the request without an answer (response 2).
/// For a screenshot that means the desktop refused it, nearly always because the
/// one-time "allow screenshots" question could not be shown: GNOME only lets the
/// application whose window has the focus show that question.
pub const REFUSED: &str = "refused";

/// Starts every error that means "SnapPro has no permission to take screenshots
/// yet", so callers can tell it from a failed capture (see `needs_screenshot_permission`).
pub const SCREENSHOT_PERMISSION_MESSAGE: &str = "SnapPro is not allowed to take screenshots yet. \
Open SnapPro and press \"Allow screenshots\": your desktop asks once, and only while a SnapPro window is active.";

/// Error text of a screenshot the person closed the desktop's picker without taking.
pub const SCREENSHOT_CANCELLED: &str = "Screenshot cancelled";

/// True for the error text of a screenshot the desktop refused for lack of permission.
pub fn needs_screenshot_permission(error: &str) -> bool {
    error.contains("SnapPro is not allowed to take screenshots yet")
}

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
        2 => anyhow::bail!(REFUSED),
        other => anyhow::bail!("the desktop portal answered with code {other}"),
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
    .map_err(|e| match e.to_string().as_str() {
        CANCELLED => anyhow::anyhow!(SCREENSHOT_CANCELLED),
        // The desktop's own picker answers 2 when it is closed without a picture.
        REFUSED if interactive => anyhow::anyhow!(SCREENSHOT_CANCELLED),
        REFUSED => anyhow::anyhow!(SCREENSHOT_PERMISSION_MESSAGE),
        _ => anyhow::anyhow!("The desktop did not allow a screenshot: {e}"),
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

/// Start `gst-launch-1.0 <args>` on the PipeWire stream of an open ScreenCast (or
/// RemoteDesktop) portal session. The PipeWire connection is handed over as fd 3,
/// so the pipeline begins with `pipewiresrc fd=3 path=<node>`; stdout is piped.
pub fn spawn_gstreamer(
    conn: &Connection,
    session: &OwnedObjectPath,
    args: &[String],
    log_name: &str,
) -> anyhow::Result<std::process::Child> {
    use std::os::fd::{AsRawFd, OwnedFd};
    use std::os::unix::process::CommandExt;
    use std::process::{Command, Stdio};

    let portal = Proxy::new(conn, DEST, PATH, "org.freedesktop.portal.ScreenCast")?;
    let options: HashMap<&str, Value> = HashMap::new();
    let fd: zbus::zvariant::OwnedFd = portal.call("OpenPipeWireRemote", &(ObjectPath::from(session), options))?;
    let fd: OwnedFd = fd.into();

    crate::settings::log_line(&format!("gst-launch-1.0 {}", args.join(" ")));
    let _ = crate::util::ensure_dir(&crate::util::logs_dir());
    let mut command = Command::new("gst-launch-1.0");
    command
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::from(std::fs::File::create(crate::util::logs_dir().join(log_name))?));
    crate::util::restore_child_environment(&mut command);
    let raw = fd.as_raw_fd();
    unsafe {
        command.pre_exec(move || {
            if raw == 3 {
                let flags = libc::fcntl(3, libc::F_GETFD);
                if flags < 0 || libc::fcntl(3, libc::F_SETFD, flags & !libc::FD_CLOEXEC) < 0 {
                    return Err(std::io::Error::last_os_error());
                }
            } else if libc::dup2(raw, 3) < 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let child = command
        .spawn()
        .map_err(|e| anyhow::anyhow!("GStreamer (gst-launch-1.0) could not be started: {e}"))?;
    drop(fd);
    Ok(child)
}

/// Ask a GStreamer process to finish (EOS) and wait a moment for it.
pub fn stop_gstreamer(mut child: std::process::Child) {
    unsafe {
        libc::kill(child.id() as libc::pid_t, libc::SIGINT);
    }
    for _ in 0..40 {
        if let Ok(Some(_)) = child.try_wait() {
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }
    let _ = child.kill();
    let _ = child.wait();
}

/// Close a portal session (its "sharing" indicator goes away).
pub fn close_session(conn: &Connection, session: &OwnedObjectPath) {
    if let Ok(proxy) = Proxy::new(conn, DEST, session, "org.freedesktop.portal.Session") {
        let _ = proxy.call_method("Close", &());
    }
}

/// The id the desktop knows this program by, taken from the systemd scope the
/// desktop started it in (`app-gnome-SnapPro-1234.scope` -> `SnapPro`). `None`
/// when SnapPro was not started by the desktop (a terminal, for example).
pub fn own_app_id() -> Option<String> {
    let cgroup = std::fs::read_to_string("/proc/self/cgroup").ok()?;
    app_id_from_cgroup(&cgroup)
}

/// See [`own_app_id`]; separate so it can be tested.
pub fn app_id_from_cgroup(cgroup: &str) -> Option<String> {
    let unit = cgroup.lines().filter_map(|l| l.rsplit('/').next()).find(|u| u.starts_with("app-"))?;
    let name = unit.strip_suffix(".scope").or_else(|| unit.strip_suffix(".service"))?;
    // systemd writes a dash inside a name as \x2d.
    let name = name.replace("\\x2d", "-");
    let name = name.strip_prefix("app-")?;
    // Started at login: `app-gnome-SnapPro@autostart`. Otherwise the process id ends the name.
    let name = match name.split_once('@') {
        Some((name, _)) => name,
        None => {
            let (name, pid) = name.rsplit_once('-')?;
            if pid.is_empty() || !pid.chars().all(|c| c.is_ascii_digit()) {
                return None;
            }
            name
        }
    };
    // Drop the launcher in front of the name.
    let name = ["gnome-", "kde-", "dbus-"].iter().find_map(|l| name.strip_prefix(l)).unwrap_or(name);
    (!name.is_empty()).then(|| name.to_string())
}

/// File that keeps a "remember my answer" token of the desktop for this program.
///
/// The desktop ties such a token to the identity of the program that got it
/// ([`own_app_id`]), and a token of another identity makes it ask again. SnapPro is
/// started in different ways (application menu, login, a terminal) that have
/// different identities, so each identity keeps its own file; one shared file made
/// them wipe each other's token and the "Share Screen" question came back every time.
pub fn token_file(kind: &str) -> std::path::PathBuf {
    crate::util::app_data_dir().join(token_file_name(kind, own_app_id().as_deref()))
}

/// See [`token_file`]; separate so it can be tested.
pub fn token_file_name(kind: &str, app_id: Option<&str>) -> String {
    let id: String = app_id
        .unwrap_or("default")
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.' { c } else { '_' })
        .collect();
    format!("{kind}-{id}.token")
}

/// Whether this program is allowed to take screenshots, as recorded by the
/// desktop: `Some(true/false)`, or `None` when that cannot be told (SnapPro was not
/// started by the desktop, or the desktop keeps no such record).
pub fn screenshot_permission() -> Option<bool> {
    let id = own_app_id()?;
    let conn = Connection::session().ok()?;
    let store = Proxy::new(
        &conn,
        "org.freedesktop.impl.portal.PermissionStore",
        "/org/freedesktop/impl/portal/PermissionStore",
        "org.freedesktop.impl.portal.PermissionStore",
    )
    .ok()?;
    match store.call::<_, _, (HashMap<String, Vec<String>>, zbus::zvariant::OwnedValue)>("Lookup", &("screenshot", "screenshot")) {
        Ok((entries, _)) => Some(entries.get(&id).map(|p| p.iter().any(|p| p == "yes")).unwrap_or(false)),
        // The table does not exist until some program was answered once.
        Err(_) => Some(false),
    }
}

/// A "no" recorded earlier makes the desktop refuse without asking again. Pressing
/// "Allow screenshots" asks for the question again, so a recorded "no" for SnapPro is
/// removed first; the answer to the question is still the person's to give.
pub fn forget_screenshot_denial() {
    let Some(id) = own_app_id() else { return };
    let Ok(conn) = Connection::session() else { return };
    let Ok(store) = Proxy::new(
        &conn,
        "org.freedesktop.impl.portal.PermissionStore",
        "/org/freedesktop/impl/portal/PermissionStore",
        "org.freedesktop.impl.portal.PermissionStore",
    ) else {
        return;
    };
    let lookup = store.call::<_, _, (HashMap<String, Vec<String>>, zbus::zvariant::OwnedValue)>(
        "Lookup",
        &("screenshot", "screenshot"),
    );
    if let Ok((entries, _)) = lookup {
        if entries.get(&id).map(|p| !p.iter().any(|p| p == "yes")).unwrap_or(false) {
            let _ = store.call_method("DeletePermission", &("screenshot", "screenshot", id.as_str()));
        }
    }
}
