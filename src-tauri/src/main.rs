// Prevents an extra console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    #[cfg(target_os = "linux")]
    linux_environment();
    snappro_lib::run()
}

/// WebKitGTK and GTK settings that have to be in place before the first window.
/// A value the user already set always wins.
#[cfg(target_os = "linux")]
fn linux_environment() {
    let unset = |key: &str| std::env::var_os(key).map(|v| v.is_empty()).unwrap_or(true);
    // The DMA-BUF renderer leaves transparent, undecorated windows blank or black
    // on many GPU / compositor combinations, so SnapPro's windows never appeared.
    if unset("WEBKIT_DISABLE_DMABUF_RENDERER") {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }
    // On Wayland the windows run through XWayland: a native Wayland window cannot
    // place itself (region overlay, recorder bar, preview), cannot stay on top and
    // cannot take global shortcuts. Screenshots still go through the desktop portal.
    let wayland = std::env::var("XDG_SESSION_TYPE")
        .map(|s| s.eq_ignore_ascii_case("wayland"))
        .unwrap_or(false)
        || !unset("WAYLAND_DISPLAY");
    // GDK_BACKEND=wayland is often exported for the whole session (VS Code's
    // terminal does it), so it is overridden; SNAPPRO_NATIVE_WAYLAND=1 opts out.
    // Programs SnapPro starts get the original value back (util::hidden_command).
    if wayland && unset("SNAPPRO_NATIVE_WAYLAND") && !unset("DISPLAY") {
        std::env::set_var(
            "SNAPPRO_GDK_BACKEND_ORIG",
            std::env::var("GDK_BACKEND").unwrap_or_default(),
        );
        std::env::set_var("GDK_BACKEND", "x11");
    }
}
