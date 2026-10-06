use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

#[cfg(target_os = "linux")]
pub mod wayland;

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct RecordOptions {
    pub mode: String, // screen | window | custom
    /// Index into the monitor list (not the xcap id). `None` = primary.
    pub monitor: Option<usize>,
    pub fps: u32,
    pub audio: bool,
    pub audio_device: Option<String>,
    pub webcam: bool,
    pub camera_device: Option<String>,
    pub region: Option<RegionRect>,
    pub format: String, // mp4 | mkv | gif
    pub draw_mouse: bool,
    /// Window picking `mode == "window"`: a native window handle or an
    /// `xcap` window id, sent as a string so the UI does not have to care.
    pub window_id: Option<String>,
    /// A window title, used when no id is available.
    pub window_title: Option<String>,
    pub quality: Option<String>, // high | balanced | small
    /// Corner of the picture the webcam sits in: br | bl | tr | tl.
    pub webcam_position: String,
    /// Width of the webcam picture in pixels.
    pub webcam_width: u32,
    /// Record what the computer plays (needs a loopback device).
    pub system_audio: bool,
    pub system_audio_device: Option<String>,
    /// Always write an audio track (silent when no source is on) so sound can be
    /// switched during the take.
    pub keep_audio_track: bool,
}

impl Default for RecordOptions {
    fn default() -> Self {
        Self {
            mode: "screen".into(),
            monitor: None,
            fps: 30,
            audio: false,
            audio_device: None,
            webcam: false,
            camera_device: None,
            region: None,
            format: "mp4".into(),
            draw_mouse: true,
            window_id: None,
            window_title: None,
            quality: Some("balanced".into()),
            webcam_position: "br".into(),
            webcam_width: 320,
            system_audio: false,
            system_audio_device: None,
            keep_audio_track: true,
        }
    }
}

/// Never pop a console window when we shell out to ffmpeg.
pub fn hidden_command(program: impl AsRef<std::ffi::OsStr>) -> Command {
    let mut cmd = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd.stdin(Stdio::null());
    crate::util::restore_child_environment(&mut cmd);
    cmd
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct RegionRect {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RecordingStatus {
    pub recording: bool,
    pub paused: bool,
    pub started_at: Option<i64>,
    pub output: Option<String>,
    pub elapsed_ms: u64,
    pub segments: usize,
    pub format: String,
    /// Human-readable source, e.g. "Window: Chrome" or "Display 2".
    pub source: Option<String>,
    pub quality: Option<String>,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Devices {
    pub cameras: Vec<String>,
    pub microphones: Vec<String>,
    /// Sources that carry what the speakers play (Stereo Mix, BlackHole, *.monitor ...).
    pub loopback: Vec<String>,
}

#[derive(Default)]
pub struct RecorderState {
    pub inner: Mutex<RecorderInner>,
}

#[derive(Default)]
pub struct RecorderInner {
    pub child: Option<Child>,
    /// Every finished segment of the current session (pause creates a new one).
    pub segments: Vec<PathBuf>,
    pub active_segment: Option<PathBuf>,
    pub final_output: Option<PathBuf>,
    pub started_at: Option<i64>,
    pub paused: bool,
    /// Set while ffmpeg is being launched so a double click cannot start two takes.
    pub starting: bool,
    pub accumulated_ms: u64,
    pub format: String,
    pub options: Option<RecordOptions>,
}

impl RecorderInner {
    pub fn is_active(&self) -> bool {
        self.started_at.is_some() || self.paused || self.starting
    }

    pub fn elapsed_ms(&self) -> u64 {
        let running = if let Some(started) = self.started_at {
            if self.paused {
                0
            } else {
                (chrono::Utc::now().timestamp_millis() - started).max(0) as u64
            }
        } else {
            0
        };
        self.accumulated_ms + running
    }

    pub fn status(&self) -> RecordingStatus {
        RecordingStatus {
            recording: self.started_at.is_some() || self.paused,
            paused: self.paused,
            started_at: self.started_at,
            output: self
                .final_output
                .as_ref()
                .map(|p| p.to_string_lossy().to_string()),
            elapsed_ms: self.elapsed_ms(),
            segments: self.segments.len() + if self.active_segment.is_some() { 1 } else { 0 },
            format: self.format.clone(),
            source: self.options.as_ref().map(describe_source),
            quality: self.options.as_ref().and_then(|o| o.quality.clone()),
        }
    }
}

// ---------------------------------------------------------------------------
// Device discovery
// ---------------------------------------------------------------------------

/// Parse `ffmpeg -f avfoundation -list_devices true -i ""` output into
/// `(video devices, audio devices)`, each as `(index, name)`.
pub fn parse_avfoundation_devices(text: &str) -> (Vec<(usize, String)>, Vec<(usize, String)>) {
    let mut video = Vec::new();
    let mut audio = Vec::new();
    let mut section = "";
    for line in text.lines() {
        if line.contains("AVFoundation video devices") {
            section = "video";
            continue;
        }
        if line.contains("AVFoundation audio devices") {
            section = "audio";
            continue;
        }
        let Some((_, rest)) = line.split_once("] ") else {
            continue;
        };
        let Some(rest) = rest.strip_prefix('[') else {
            continue;
        };
        let Some((index, name)) = rest.split_once(']') else {
            continue;
        };
        let (Ok(index), name) = (index.trim().parse::<usize>(), name.trim()) else {
            continue;
        };
        if name.is_empty() {
            continue;
        }
        match section {
            "video" => video.push((index, name.to_string())),
            "audio" => audio.push((index, name.to_string())),
            _ => {}
        }
    }
    (video, audio)
}

/// avfoundation device index of the n-th "Capture screen".
pub fn pick_macos_screen(video: &[(usize, String)], monitor: Option<usize>) -> String {
    let screens: Vec<&(usize, String)> = video
        .iter()
        .filter(|(_, name)| name.starts_with("Capture screen"))
        .collect();
    let wanted = monitor.unwrap_or(0);
    screens
        .get(wanted)
        .or_else(|| screens.first())
        .map(|(i, _)| i.to_string())
        .unwrap_or_else(|| "1".to_string())
}

#[cfg(target_os = "macos")]
fn macos_device_list() -> (Vec<(usize, String)>, Vec<(usize, String)>) {
    let Some(ffmpeg) = crate::util::find_ffmpeg() else {
        return (Vec::new(), Vec::new());
    };
    let out = hidden_command(&ffmpeg)
        .args(["-hide_banner", "-f", "avfoundation", "-list_devices", "true", "-i", ""])
        .output();
    match out {
        Ok(out) => parse_avfoundation_devices(&String::from_utf8_lossy(&out.stderr)),
        Err(_) => (Vec::new(), Vec::new()),
    }
}

/// Detect cameras and microphones ffmpeg can access.
pub fn list_devices() -> Devices {
    let mut devices = Devices::default();
    let Some(ffmpeg) = crate::util::find_ffmpeg() else {
        return devices;
    };
    let _ = &ffmpeg;

    #[cfg(windows)]
    {
        let out = hidden_command(&ffmpeg)
            .args(["-hide_banner", "-list_devices", "true", "-f", "dshow", "-i", "dummy"])
            .output();
        if let Ok(out) = out {
            let text = String::from_utf8_lossy(&out.stderr).to_string();
            for line in text.lines() {
                // Skip the "Alternative name" lines that follow every device.
                if line.contains("Alternative name") {
                    continue;
                }
                let name = match line.split('"').nth(1) {
                    Some(n) => n.to_string(),
                    None => continue,
                };
                if line.contains("(video)") {
                    devices.cameras.push(name);
                } else if line.contains("(audio)") {
                    devices.microphones.push(name);
                }
            }
        }
    }
    #[cfg(target_os = "macos")]
    {
        let (video, audio) = macos_device_list();
        for (_, name) in video {
            if !name.starts_with("Capture screen") {
                devices.cameras.push(name);
            }
        }
        for (_, name) in audio {
            devices.microphones.push(name);
        }
    }
    #[cfg(target_os = "linux")]
    {
        if let Ok(entries) = std::fs::read_dir("/dev") {
            let mut cams: Vec<String> = entries
                .flatten()
                .map(|e| e.file_name().to_string_lossy().to_string())
                .filter(|n| n.starts_with("video"))
                .map(|n| format!("/dev/{}", n))
                .collect();
            cams.sort();
            devices.cameras = cams;
        }
        // PulseAudio / PipeWire sources: real microphones first, then the
        // ".monitor" sources which carry what the speakers play (system audio).
        let mut mics: Vec<String> = Vec::new();
        let mut monitors: Vec<String> = Vec::new();
        if let Ok(out) = crate::util::hidden_command("pactl")
            .args(["list", "short", "sources"])
            .output()
        {
            for line in String::from_utf8_lossy(&out.stdout).lines() {
                if let Some(name) = line.split_whitespace().nth(1) {
                    if name.ends_with(".monitor") {
                        monitors.push(name.to_string());
                    } else {
                        mics.push(name.to_string());
                    }
                }
            }
        }
        devices.microphones.push("default".to_string());
        devices.microphones.extend(mics);
        devices.microphones.extend(monitors);
    }

    // Real microphones and "what you hear" sources are shown separately.
    let (mics, loopback) = split_audio_devices(std::mem::take(&mut devices.microphones));
    devices.microphones = mics;
    devices.loopback = loopback;
    devices
}

/// A reason recording cannot work in the current desktop session, if any.
pub fn session_blocker() -> Option<String> {
    #[cfg(target_os = "linux")]
    {
        // Wayland records through the ScreenCast portal (see wayland.rs).
        if crate::portal::is_wayland() {
            return wayland::missing_parts();
        }
        if std::env::var("DISPLAY").map(|d| d.is_empty()).unwrap_or(true) {
            return Some("No X11 display found, screen recording is unavailable.".to_string());
        }
    }
    None
}

// ---------------------------------------------------------------------------
// ffmpeg arguments
// ---------------------------------------------------------------------------

/// Filter that forces even width/height, which libx264 with yuv420p requires.
/// Odd-sized regions and windows used to make ffmpeg exit at once.
const EVEN_SCALE: &str = "scale=trunc(iw/2)*2:trunc(ih/2)*2";

/// Build the ffmpeg argument list for one recording segment.
///
/// GIF is recorded like every other format and converted when the take is
/// finished (see [`finalize_recording`]): encoding a palette live is slow and
/// drops frames.
pub fn build_args(opts: &RecordOptions, output: &str) -> Vec<String> {
    build_args_for(opts, output, &ScreenSource::Grab)
}

/// Where the screen picture of a recording comes from.
pub enum ScreenSource {
    /// The system's own grabber: gdigrab, avfoundation or x11grab.
    Grab,
    /// YUV4MPEG on ffmpeg's stdin, with an optional crop filter. Used on Wayland,
    /// where the picture comes from the ScreenCast portal (see `wayland.rs`).
    Pipe(Option<String>),
}

pub fn build_args_for(opts: &RecordOptions, output: &str, source: &ScreenSource) -> Vec<String> {
    let fps = if opts.fps == 0 { 30 } else { opts.fps };
    let mut args: Vec<String> = vec![
        "-hide_banner".into(),
        "-loglevel".into(),
        "warning".into(),
        "-nostats".into(),
    ];
    let window_mode = opts.mode == "window";
    let window_target = opts
        .window_title
        .clone()
        .or_else(|| opts.window_id.clone())
        .filter(|s| !s.trim().is_empty());
    // Only used on macOS, where the region is applied as a crop filter.
    let mut pre_filter: Option<String> = None;
    let _ = (&window_mode, &window_target, &mut pre_filter);

    // --- Input 0 from a pipe (Wayland)
    let piped = if let ScreenSource::Pipe(crop) = source {
        args.extend([
            // Real clock time stamps keep the screen and the sound in step.
            "-use_wallclock_as_timestamps".into(),
            "1".into(),
            "-thread_queue_size".into(),
            "1024".into(),
            "-f".into(),
            "yuv4mpegpipe".into(),
            "-i".into(),
            "pipe:0".into(),
        ]);
        pre_filter = crop.clone();
        true
    } else {
        false
    };

    // --- Input 0: the screen (whole monitor, a region, or one window)
    #[cfg(windows)]
    if !piped {
        args.extend([
            // Real clock time stamps keep the screen and the camera in step.
            "-use_wallclock_as_timestamps".into(),
            "1".into(),
            "-f".into(),
            "gdigrab".into(),
            "-framerate".into(),
            fps.to_string(),
            "-draw_mouse".into(),
            if opts.draw_mouse { "1".into() } else { "0".into() },
        ]);
        let sized = opts
            .region
            .as_ref()
            .filter(|r| r.width > 0 && r.height > 0);
        match sized {
            Some(region) => {
                args.extend([
                    "-offset_x".into(),
                    region.x.to_string(),
                    "-offset_y".into(),
                    region.y.to_string(),
                    "-video_size".into(),
                    format!("{}x{}", region.width, region.height),
                    "-i".into(),
                    "desktop".into(),
                ]);
            }
            None => {
                if window_mode {
                    // No usable rectangle: fall back to matching the title.
                    if let Some(target) = &window_target {
                        args.extend(["-i".into(), format!("title={}", target)]);
                    } else {
                        args.extend(["-i".into(), "desktop".into()]);
                    }
                } else {
                    args.extend(["-i".into(), "desktop".into()]);
                }
            }
        }
    }
    #[cfg(target_os = "macos")]
    if !piped {
        let (video, _) = macos_device_list();
        let screen = pick_macos_screen(&video, opts.monitor);
        args.extend([
            "-f".into(),
            "avfoundation".into(),
            "-framerate".into(),
            fps.to_string(),
            "-capture_cursor".into(),
            if opts.draw_mouse { "1".into() } else { "0".into() },
            "-i".into(),
            format!("{}:none", screen),
        ]);
        if let Some(region) = opts.region.as_ref().filter(|r| r.width > 0 && r.height > 0) {
            pre_filter = Some(format!(
                "crop={}:{}:{}:{}",
                region.width, region.height, region.x.max(0), region.y.max(0)
            ));
        }
    }
    #[cfg(target_os = "linux")]
    if !piped {
        let display = std::env::var("DISPLAY").unwrap_or_else(|_| ":0.0".into());
        args.extend([
            "-f".into(),
            "x11grab".into(),
            "-framerate".into(),
            fps.to_string(),
            "-draw_mouse".into(),
            if opts.draw_mouse { "1".into() } else { "0".into() },
        ]);
        match &opts.region {
            Some(region) if region.width > 0 && region.height > 0 => args.extend([
                "-video_size".into(),
                format!("{}x{}", region.width, region.height),
                "-i".into(),
                format!("{}+{},{}", display, region.x, region.y),
            ]),
            _ => args.extend(["-i".into(), display]),
        }
    }

    // --- Audio inputs: microphone and/or system sound ("what you hear")
    let mut audio_inputs: Vec<usize> = Vec::new();
    let mut next_input = 1usize;
    let usable = |d: &Option<String>| d.as_ref().filter(|d| !d.trim().is_empty()).cloned();
    let mic = if opts.audio { usable(&opts.audio_device) } else { None };
    let system = if opts.system_audio { usable(&opts.system_audio_device) } else { None };
    for device in [mic, system].into_iter().flatten() {
        push_audio_input(&mut args, &device);
        audio_inputs.push(next_input);
        next_input += 1;
    }
    // Every take carries an audio track, silent when nothing is switched on. That
    // keeps all segments the same shape, so the microphone / computer sound can be
    // turned on or off in the middle of a recording and the pieces still join.
    if audio_inputs.is_empty() && opts.keep_audio_track && opts.format != "gif" {
        args.extend([
            "-f".into(),
            "lavfi".into(),
            "-i".into(),
            "anullsrc=r=48000:cl=stereo".into(),
        ]);
        audio_inputs.push(next_input);
        next_input += 1;
    }

    // --- Webcam: a second *output* of the same ffmpeg process.
    //
    // Mixing the camera into the screen picture inside this process made the whole
    // video wait for the camera, which needs 1-2 seconds to wake up: the start of
    // every take (and of every restart) was lost. Written as its own file, the
    // screen starts at once; the two are laid over each other when the take ends.
    let camera_input = if opts.webcam {
        usable(&opts.camera_device).map(|device| {
            push_camera_input(&mut args, &device);
            let index = next_input;
            next_input += 1;
            index
        })
    } else {
        None
    };
    let _ = next_input;

    let base_chain = match &pre_filter {
        Some(crop) => format!("{},{}", crop, EVEN_SCALE),
        None => EVEN_SCALE.to_string(),
    };

    // One filter graph for the screen picture and for mixing two sound sources.
    let mut graph: Vec<String> = vec![format!("[0:v]{},fps={}[vout]", base_chain, fps)];
    let audio_map = match audio_inputs.len() {
        0 => None,
        1 => Some(format!("{}:a", audio_inputs[0])),
        _ => {
            graph.push(format!(
                "[{}:a][{}:a]amix=inputs=2:duration=longest:normalize=0[aout]",
                audio_inputs[0], audio_inputs[1]
            ));
            Some("[aout]".to_string())
        }
    };
    args.extend(["-filter_complex".into(), graph.join(";"), "-map".into(), "[vout]".into()]);
    if let Some(map) = &audio_map {
        args.extend(["-map".into(), map.clone()]);
    }

    let quality = quality_preset(opts);
    args.extend([
        "-c:v".into(),
        "libx264".into(),
        "-preset".into(),
        quality.preset.into(),
        "-crf".into(),
        quality.crf.to_string(),
        "-pix_fmt".into(),
        "yuv420p".into(),
    ]);
    // `movflags` only exists for the MP4 family; Matroska rejects it.
    let lower = output.to_lowercase();
    if lower.ends_with(".mp4") || lower.ends_with(".mov") {
        args.extend(["-movflags".into(), "+faststart".into()]);
    }

    if audio_map.is_some() {
        args.extend([
            "-c:a".into(),
            "aac".into(),
            "-b:a".into(),
            "192k".into(),
            "-ar".into(),
            "48000".into(),
            "-ac".into(),
            "2".into(),
        ]);
    } else {
        args.push("-an".into());
    }

    // A piped picture ends with its input (Wayland), while the sound inputs never
    // end on their own: the segment has to stop with the picture.
    if piped {
        args.push("-shortest".into());
    }
    args.extend(["-y".into(), output.to_string()]);

    // Second output: the camera, already shrunk to the size it will have in the video.
    if let Some(camera) = camera_input {
        let width = opts.webcam_width.clamp(96, 960);
        args.extend([
            "-map".into(),
            format!("{}:v", camera),
            "-vf".into(),
            format!("scale={}:-2,fps=15", width),
            "-c:v".into(),
            "libx264".into(),
            "-preset".into(),
            "ultrafast".into(),
            "-crf".into(),
            "22".into(),
            "-pix_fmt".into(),
            "yuv420p".into(),
            "-an".into(),
            "-y".into(),
            camera_file_for(Path::new(output)).to_string_lossy().to_string(),
        ]);
    }
    args
}

/// Where the camera picture of a screen segment is written (`x.mkv` -> `x.cam.mkv`).
pub fn camera_file_for(segment: &Path) -> PathBuf {
    segment.with_extension("cam.mkv")
}

/// Overlay position expression for the webcam corner.
fn camera_position(corner: &str) -> &'static str {
    match corner {
        "bl" => "24:H-h-24",
        "tr" => "W-w-24:24",
        "tl" => "24:24",
        _ => "W-w-24:H-h-24",
    }
}

/// Lay each segment's camera file over its screen file. Segments without a camera
/// file are returned unchanged; if composing fails the plain screen segment is kept.
pub fn compose_cameras(segments: &[PathBuf], opts: &RecordOptions) -> Vec<PathBuf> {
    let Ok(ffmpeg) = ffmpeg_path() else {
        return segments.to_vec();
    };
    segments
        .iter()
        .map(|segment| {
            let camera = camera_file_for(segment);
            if !camera.exists() {
                return segment.clone();
            }
            let composed = segment.with_extension("composed.mkv");
            let filter = format!(
                "[0:v][1:v]overlay={}:eof_action=pass,{}[vout]",
                camera_position(&opts.webcam_position),
                EVEN_SCALE
            );
            let status = hidden_command(&ffmpeg)
                .args(["-hide_banner", "-loglevel", "error", "-i"])
                .arg(segment)
                .arg("-i")
                .arg(&camera)
                .args(["-filter_complex", &filter, "-map", "[vout]", "-map", "0:a?"])
                .args(["-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p", "-c:a", "copy", "-y"])
                .arg(&composed)
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
            let ok = matches!(&status, Ok(s) if s.success()) && composed.exists();
            let _ = std::fs::remove_file(&camera);
            if ok {
                let _ = std::fs::remove_file(segment);
                composed
            } else {
                crate::settings::log_line("could not lay the camera over the screen, kept the plain screen recording");
                let _ = std::fs::remove_file(&composed);
                segment.clone()
            }
        })
        .collect()
}

/// Add one audio capture input in the way the current system wants it.
fn push_audio_input(args: &mut Vec<String>, device: &str) {
    #[cfg(windows)]
    args.extend([
        "-f".into(),
        "dshow".into(),
        "-rtbufsize".into(),
        "100M".into(),
        "-i".into(),
        format!("audio={}", device),
    ]);
    #[cfg(target_os = "macos")]
    args.extend([
        "-f".into(),
        "avfoundation".into(),
        "-i".into(),
        format!("none:{}", device),
    ]);
    #[cfg(target_os = "linux")]
    args.extend(["-f".into(), "pulse".into(), "-i".into(), device.to_string()]);
}

fn push_camera_input(args: &mut Vec<String>, device: &str) {
    #[cfg(windows)]
    args.extend([
        "-f".into(),
        "dshow".into(),
        "-rtbufsize".into(),
        "100M".into(),
        "-i".into(),
        format!("video={}", device),
    ]);
    #[cfg(target_os = "macos")]
    args.extend([
        "-f".into(),
        "avfoundation".into(),
        "-framerate".into(),
        "30".into(),
        "-i".into(),
        format!("{}:none", device),
    ]);
    #[cfg(target_os = "linux")]
    args.extend(["-f".into(), "v4l2".into(), "-i".into(), device.to_string()]);
}

/// Split capture devices into real microphones and "what you hear" (loopback)
/// sources, by the names the systems give them.
pub fn split_audio_devices(names: Vec<String>) -> (Vec<String>, Vec<String>) {
    let loopback_words = [
        "stereo mix",
        "what u hear",
        "what you hear",
        "loopback",
        "virtual-audio-capturer",
        "wave out",
        "mixage stéréo",
        "blackhole",
        "soundflower",
        ".monitor",
        "monitor of",
    ];
    let mut mics = Vec::new();
    let mut loopback = Vec::new();
    for name in names {
        let lower = name.to_lowercase();
        if loopback_words.iter().any(|w| lower.contains(w)) {
            loopback.push(name);
        } else {
            mics.push(name);
        }
    }
    (mics, loopback)
}

/// Encoding preset picked from the `quality` setting.
struct QualityPreset {
    preset: &'static str,
    crf: u32,
}

fn quality_preset(opts: &RecordOptions) -> QualityPreset {
    match opts.quality.as_deref() {
        Some("high") => QualityPreset {
            preset: "veryfast",
            crf: 18,
        },
        Some("small") => QualityPreset {
            preset: "veryfast",
            crf: 30,
        },
        // "balanced" and anything unknown: small files, still crisp text.
        _ => QualityPreset {
            preset: "ultrafast",
            crf: 23,
        },
    }
}

pub fn ffmpeg_path() -> anyhow::Result<PathBuf> {
    crate::util::find_ffmpeg().ok_or_else(|| {
        anyhow::anyhow!(
            "ffmpeg was not found. Install it from SnapPro > Settings > System check, \
             or run: winget install Gyan.FFmpeg (Windows), brew install ffmpeg (macOS), \
             sudo apt install ffmpeg (Linux)."
        )
    })
}

fn ffmpeg_log_path() -> PathBuf {
    crate::util::logs_dir().join("ffmpeg.log")
}

/// Last few lines of the ffmpeg log, for error messages.
fn log_tail(max_lines: usize) -> String {
    let text = std::fs::read_to_string(ffmpeg_log_path()).unwrap_or_default();
    let lines: Vec<&str> = text.lines().filter(|l| !l.trim().is_empty()).collect();
    let start = lines.len().saturating_sub(max_lines);
    lines[start..].join("\n")
}

/// Start recording one segment. ffmpeg's stderr goes to a log file: the old
/// code piped it without ever reading it, so after a few minutes the pipe
/// filled up and the recording froze.
pub fn spawn_recording(output: &Path, opts: &RecordOptions) -> anyhow::Result<Child> {
    if let Some(reason) = session_blocker() {
        anyhow::bail!(reason);
    }
    let ffmpeg = ffmpeg_path()?;
    let (args, input) = screen_input(opts, output)?;
    crate::settings::log_line(&format!("ffmpeg {} {}", ffmpeg.display(), args.join(" ")));

    let _ = crate::util::ensure_dir(&crate::util::logs_dir());
    let log = std::fs::File::create(ffmpeg_log_path())?;
    let mut command = hidden_command(&ffmpeg);
    // gdigrab reads the screen in the coordinates ffmpeg itself runs in. Without
    // this flag ffmpeg is DPI-unaware, so on a 125% or 150% display the recorded
    // rectangle no longer matches the one the user picked.
    #[cfg(windows)]
    command.env("__COMPAT_LAYER", "HighDpiAware");
    let mut child = match command
        .args(&args)
        .stdin(input)
        .stdout(Stdio::null())
        .stderr(Stdio::from(log))
        .spawn()
    {
        Ok(child) => child,
        Err(err) => {
            end_screen_session();
            return Err(err.into());
        }
    };

    // A bad device name or argument makes ffmpeg exit within a moment. Report
    // that now instead of pretending to record.
    for _ in 0..8 {
        std::thread::sleep(std::time::Duration::from_millis(100));
        if let Ok(Some(status)) = child.try_wait() {
            end_screen_session();
            let tail = log_tail(6);
            anyhow::bail!(
                "Recording could not start (ffmpeg exited with {}).{}{}",
                status,
                if tail.is_empty() { "" } else { "\n" },
                tail
            );
        }
    }
    Ok(child)
}

/// ffmpeg arguments for one segment and what its stdin is: a pipe for the `q`
/// that ends it, or on Wayland the video itself.
fn screen_input(opts: &RecordOptions, output: &Path) -> anyhow::Result<(Vec<String>, Stdio)> {
    let output = output.to_string_lossy();
    #[cfg(target_os = "linux")]
    if crate::portal::is_wayland() {
        let (video, crop) = wayland::start_source(
            opts.mode == "window",
            opts.draw_mouse,
            if opts.fps == 0 { 30 } else { opts.fps },
            opts.region.as_ref(),
        )?;
        return Ok((build_args_for(opts, &output, &ScreenSource::Pipe(crop)), video));
    }
    Ok((build_args(opts, &output), Stdio::piped()))
}

/// Close the desktop's screen-sharing session of a finished take (Wayland only).
pub fn end_screen_session() {
    #[cfg(target_os = "linux")]
    wayland::end_session();
}

/// Ask ffmpeg to finalise the current segment by sending `q` to its stdin.
/// On Wayland its input is ended instead (see `wayland::stop_source`).
pub fn stop_child(child: &mut Child) -> anyhow::Result<()> {
    use std::io::Write;
    #[cfg(target_os = "linux")]
    wayland::stop_source();
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all(b"q");
        let _ = stdin.flush();
        // Dropping stdin closes the pipe, which also makes ffmpeg stop.
    }
    for _ in 0..100 {
        match child.try_wait() {
            Ok(Some(_)) => return Ok(()),
            Ok(None) => std::thread::sleep(std::time::Duration::from_millis(150)),
            Err(err) => return Err(anyhow::anyhow!(err.to_string())),
        }
    }
    let _ = child.kill();
    let _ = child.wait();
    Ok(())
}

/// ffmpeg filter that turns a recording into a good-looking GIF.
pub fn gif_filter(fps: u32) -> String {
    format!(
        "fps={},scale=if(gt(iw\\,960)\\,960\\,iw):-2:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse",
        fps.clamp(1, 15)
    )
}

/// Join the recorded segments into the final file in the requested format.
/// Returns the path that really exists (it differs from `output` only when the
/// conversion failed and the raw recording had to be kept).
pub fn finalize_recording(
    segments: &[PathBuf],
    output: &Path,
    format: &str,
    fps: u32,
) -> anyhow::Result<PathBuf> {
    if segments.is_empty() {
        anyhow::bail!("nothing was recorded");
    }
    let ffmpeg = ffmpeg_path()?;

    let list_path = output.with_extension("concat.txt");
    let mut list = String::new();
    for segment in segments {
        // ffmpeg concat needs forward slashes and escaped quotes.
        let path = segment
            .to_string_lossy()
            .replace('\\', "/")
            .replace('\'', "'\\''");
        list.push_str(&format!("file '{}'\n", path));
    }
    std::fs::write(&list_path, list)?;

    let mut cmd = hidden_command(&ffmpeg);
    cmd.args(["-hide_banner", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i"])
        .arg(&list_path);
    if format == "gif" {
        cmd.args(["-vf", &gif_filter(fps), "-loop", "0", "-an"]);
    } else {
        cmd.args(["-c", "copy"]);
        if format != "mkv" {
            cmd.args(["-movflags", "+faststart"]);
        }
    }
    let status = cmd
        .arg("-y")
        .arg(output)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    let _ = std::fs::remove_file(&list_path);

    let ok = matches!(&status, Ok(s) if s.success()) && output.exists();
    if ok {
        // Debug aid: keep the raw pieces to inspect them.
        if std::env::var_os("SNAPPRO_KEEP_SEGMENTS").is_none() {
            for segment in segments {
                let _ = std::fs::remove_file(segment);
            }
        }
        return Ok(output.to_path_buf());
    }

    // Conversion failed: keep the raw recording rather than losing it.
    let rescue = output.with_extension("mkv");
    std::fs::rename(&segments[0], &rescue)?;
    for extra in segments.iter().skip(1) {
        let name = extra.file_name().map(|n| n.to_owned()).unwrap_or_default();
        let _ = std::fs::rename(extra, rescue.with_file_name(name));
    }
    crate::settings::log_line("finalising the recording failed, kept the raw .mkv");
    Ok(rescue)
}

/// Human-readable description of what a recording captures, for the recorder UI.
pub fn describe_source(opts: &RecordOptions) -> String {
    match opts.mode.as_str() {
        "window" => {
            let title = opts
                .window_title
                .clone()
                .or_else(|| opts.window_id.clone())
                .unwrap_or_else(|| "window".into());
            format!("Window: {}", title)
        }
        "custom" => match &opts.region {
            Some(region) => format!(
                "Custom {}x{} at {},{}",
                region.width, region.height, region.x, region.y
            ),
            None => "Custom size".into(),
        },
        _ => match opts.monitor {
            Some(index) => format!("Display {}", index + 1),
            None => "Primary display".into(),
        },
    }
}

/// Grab a single frame from a video file (used for library thumbnails).
pub fn extract_frame(video: &Path, target: &Path) -> anyhow::Result<()> {
    let ffmpeg = ffmpeg_path()?;
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)?;
    }
    // Try one second in first (skips a black first frame), then the very start
    // for clips shorter than a second.
    for seek in ["00:00:01", "00:00:00"] {
        let status = hidden_command(&ffmpeg)
            .args(["-hide_banner", "-loglevel", "error", "-ss", seek, "-i"])
            .arg(video)
            .args(["-frames:v", "1", "-vf", "scale=320:-2", "-y"])
            .arg(target)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()?;
        if status.success() && target.exists() {
            return Ok(());
        }
    }
    anyhow::bail!("could not read a frame from the recording");
}
