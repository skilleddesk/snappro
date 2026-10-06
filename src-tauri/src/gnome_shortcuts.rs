//! Keyboard shortcuts on GNOME under Wayland.
//!
//! Wayland lets no program grab keys for the whole desktop, so SnapPro's global
//! shortcuts only fired while one of its own windows had focus. GNOME runs custom
//! shortcuts itself: SnapPro's shortcuts are written there as commands such as
//! `snappro --capture region`, which hand the action to the running copy
//! (see `commands::cli_action`).

use crate::util::hidden_command;

const SCHEMA: &str = "org.gnome.settings-daemon.plugins.media-keys";
const BASE: &str = "/org/gnome/settings-daemon/plugins/media-keys/custom-keybindings";
/// Our entries are recognised by this path prefix, so they can be replaced later.
const PREFIX: &str = "snappro-";

/// GNOME on Wayland, where this is needed.
pub fn wanted() -> bool {
    let desktop = std::env::var("XDG_CURRENT_DESKTOP").unwrap_or_default();
    crate::portal::is_wayland() && desktop.to_uppercase().split(':').any(|d| d == "GNOME")
}

/// Command line argument for a `hotkey_action` index.
pub fn cli_argument(action: usize) -> Option<&'static str> {
    Some(match action {
        0 => "--capture full",
        1 => "--capture window",
        2 => "--capture region",
        3 => "--capture scrolling",
        4 => "--record",
        5 => "--capture all",
        6 => "--capture text",
        7 => "--capture fixed",
        8 => "--capture color",
        _ => return None,
    })
}

fn label(action: usize) -> &'static str {
    match action {
        0 => "SnapPro: capture full screen",
        1 => "SnapPro: capture window",
        2 => "SnapPro: capture region",
        3 => "SnapPro: scrolling capture",
        4 => "SnapPro: start / stop recording",
        5 => "SnapPro: capture all displays",
        6 => "SnapPro: copy text from screen",
        7 => "SnapPro: fixed size capture",
        _ => "SnapPro: colour picker",
    }
}

/// Tauri accelerator ("CmdOrCtrl+Shift+2") in GTK notation ("<Control><Shift>2").
pub fn gtk_accelerator(accelerator: &str) -> Option<String> {
    let mut out = String::new();
    let mut key: Option<String> = None;
    for part in accelerator.split('+').map(str::trim).filter(|p| !p.is_empty()) {
        let modifier = match part.to_lowercase().as_str() {
            "cmdorctrl" | "commandorcontrol" | "ctrl" | "control" => Some("<Control>"),
            "shift" => Some("<Shift>"),
            "alt" | "option" => Some("<Alt>"),
            "super" | "meta" | "cmd" | "command" => Some("<Super>"),
            _ => None,
        };
        if let Some(m) = modifier {
            out.push_str(m);
            continue;
        }
        if key.is_some() {
            return None;
        }
        let lower = part.to_lowercase();
        key = Some(match lower.as_str() {
            "printscreen" | "print" => "Print".into(),
            "space" => "space".into(),
            "enter" | "return" => "Return".into(),
            "esc" | "escape" => "Escape".into(),
            "tab" => "Tab".into(),
            "backspace" => "BackSpace".into(),
            "delete" | "del" => "Delete".into(),
            "insert" => "Insert".into(),
            "home" => "Home".into(),
            "end" => "End".into(),
            "pageup" => "Page_Up".into(),
            "pagedown" => "Page_Down".into(),
            "up" | "arrowup" => "Up".into(),
            "down" | "arrowdown" => "Down".into(),
            "left" | "arrowleft" => "Left".into(),
            "right" | "arrowright" => "Right".into(),
            _ if lower.len() == 1 && lower.chars().all(|c| c.is_ascii_alphanumeric()) => lower,
            _ if lower.starts_with('f') && lower[1..].parse::<u8>().map(|n| (1..=24).contains(&n)).unwrap_or(false) => {
                lower.to_uppercase()
            }
            _ if lower.starts_with("digit") && lower.len() == 6 => lower[5..].to_string(),
            _ if lower.starts_with("key") && lower.len() == 4 => lower[3..].to_string(),
            _ => return None,
        });
    }
    key.map(|k| out + &k)
}

/// The paths in a `gsettings get` answer such as `['/a/', '/b/']` or `@as []`.
pub fn parse_paths(text: &str) -> Vec<String> {
    text.split('\'')
        .skip(1)
        .step_by(2)
        .map(str::to_string)
        .collect()
}

/// A string in GVariant text form, as `gsettings set` expects it.
pub fn gvariant_string(value: &str) -> String {
    format!("'{}'", value.replace('\\', "\\\\").replace('\'', "\\'"))
}

/// The command GNOME runs for a shortcut; the program path is quoted only when needed.
pub fn shortcut_command(exe: &str, argument: &str) -> String {
    if exe.contains(|c: char| c.is_whitespace() || c == '"' || c == '\'' || c == '\\') {
        format!("\"{}\" {}", exe.replace('\\', "\\\\").replace('"', "\\\""), argument)
    } else {
        format!("{exe} {argument}")
    }
}

fn gsettings(args: &[&str]) -> Option<String> {
    let out = hidden_command("gsettings").args(args).output().ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// Replace SnapPro's GNOME shortcuts with `entries` (accelerator, action).
/// Runs in the background; errors only go to the log.
pub fn apply(entries: Vec<(String, usize)>) {
    std::thread::spawn(move || {
        let Some(current) = gsettings(&["get", SCHEMA, "custom-keybindings"]) else {
            crate::settings::log_line("GNOME shortcuts: gsettings is not available");
            return;
        };
        let exe = std::env::current_exe()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|_| "snappro".into());
        // Keep everybody else's shortcuts; ours are rewritten from scratch.
        let mut paths: Vec<String> = parse_paths(&current)
            .into_iter()
            .filter(|p| !p.trim_end_matches('/').rsplit('/').next().unwrap_or("").starts_with(PREFIX))
            .collect();
        let mut ours = Vec::new();
        for (accelerator, action) in entries {
            let (Some(binding), Some(argument)) = (gtk_accelerator(&accelerator), cli_argument(action)) else {
                continue;
            };
            let path = format!("{BASE}/{PREFIX}{action}/");
            let schema = format!("{SCHEMA}.custom-keybinding:{path}");
            let command = shortcut_command(&exe, argument);
            let ok = gsettings(&["set", &schema, "name", &gvariant_string(label(action))]).is_some()
                && gsettings(&["set", &schema, "command", &gvariant_string(&command)]).is_some()
                && gsettings(&["set", &schema, "binding", &gvariant_string(&binding)]).is_some();
            if ok {
                ours.push(path);
            } else {
                crate::settings::log_line(&format!("GNOME shortcut {accelerator} could not be set"));
            }
        }
        paths.extend(ours);
        let list = format!(
            "[{}]",
            paths.iter().map(|p| format!("'{p}'")).collect::<Vec<_>>().join(", ")
        );
        if gsettings(&["set", SCHEMA, "custom-keybindings", &list]).is_none() {
            crate::settings::log_line("GNOME shortcuts could not be saved");
        }
    });
}
