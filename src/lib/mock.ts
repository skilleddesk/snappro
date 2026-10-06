/**
 * Development-only stand-in for the Tauri backend.
 *
 * When the frontend is opened in a normal browser (`npm run dev` without Tauri)
 * there is no Rust side to talk to, so the layout can still be reviewed with
 * realistic sample data. Inside the packaged app `window.__TAURI_INTERNALS__`
 * exists and this file is never used.
 */

const now = Date.now();

const sample = (name: string, width = 320, height = 180) =>
  `data:image/svg+xml;utf8,${encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 320 180">
      <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#312e81"/><stop offset="1" stop-color="#0f172a"/>
      </linearGradient></defs>
      <rect width="320" height="180" fill="url(#g)"/>
      <rect x="16" y="16" width="288" height="24" rx="6" fill="#1e293b"/>
      <rect x="16" y="52" width="180" height="12" rx="4" fill="#334155"/>
      <rect x="16" y="72" width="240" height="12" rx="4" fill="#334155"/>
      <rect x="16" y="92" width="120" height="12" rx="4" fill="#334155"/>
      <text x="16" y="150" fill="#818cf8" font-family="monospace" font-size="14">${name}</text>
    </svg>`,
  )}`;

const library = [
  {
    id: "1",
    name: "SnapPro_Screen_2026-10-05_10-12-04.331.png",
    path: "C:\\Users\\you\\Pictures\\SnapPro\\SnapPro_Screen_1.png",
    width: 1920,
    height: 1080,
    sizeBytes: 428_332,
    created: now - 1000 * 60 * 4,
    kind: "image" as const,
  },
  {
    id: "2",
    name: "SnapPro_Region_2026-10-05_09-58-11.002.png",
    path: "C:\\Users\\you\\Pictures\\SnapPro\\SnapPro_Region_2.png",
    width: 860,
    height: 540,
    sizeBytes: 151_204,
    created: now - 1000 * 60 * 22,
    kind: "image" as const,
  },
  {
    id: "3",
    name: "SnapPro_Window_2026-10-05_09-30-00.118.png",
    path: "C:\\Users\\you\\Pictures\\SnapPro\\SnapPro_Window_3.png",
    width: 1280,
    height: 720,
    sizeBytes: 96_400,
    created: now - 1000 * 60 * 60,
    kind: "image" as const,
  },
  {
    id: "4",
    name: "SnapPro_Recording_2026-10-05_09-02-40.mp4",
    path: "C:\\Users\\you\\Pictures\\SnapPro\\SnapPro_Recording_4.mp4",
    width: 1920,
    height: 1080,
    sizeBytes: 14_582_300,
    created: now - 1000 * 60 * 96,
    kind: "video" as const,
  },
];

type MockRecording = {
  recording: boolean;
  paused: boolean;
  startedAt: number | null;
  output: string | null;
  elapsedMs: number;
  segments: number;
  format: string;
};

let recorder: MockRecording = {
  recording: false,
  paused: false,
  startedAt: null,
  output: null,
  elapsedMs: 0,
  segments: 1,
  format: "mp4",
};

const settings = {
  saveDir: "C:\\Users\\you\\Pictures\\SnapPro",
  videoDir: "",
  exportDir: "",
  format: "png",
  autoCopy: true,
  autoSave: true,
  openPreview: true,
  monitor: "primary",
  delaySecs: 3,
  alwaysOnTop: true,
  miniMode: true,
  language: "en",
  playSound: true,
  includeCursor: true,
  imgurClientId: "546c25a59c58ad7",
  s3Region: "us-east-1",
  s3AccessKey: "",
  s3SecretKey: "",
  s3Prefix: "snappro",
  s3Bucket: "",
  autoOcrCaption: false,
  launchAtStartup: false,
  shortcutOcr: "CmdOrCtrl+Shift+O",
  shortcuts: [
    "CmdOrCtrl+Shift+1",
    "CmdOrCtrl+Shift+2",
    "CmdOrCtrl+Shift+3",
    "CmdOrCtrl+Shift+4",
    "CmdOrCtrl+Shift+R",
  ],
  recordingFps: 30,
  recordingAudio: false,
  recordingAudioDevice: null,
  recordingWebcam: false,
  recordingCameraDevice: null,
  recordingFormat: "mp4",
  recordingQuality: "balanced",
  drawMouse: true,
  recordingMode: "screen",
  fixedWidth: 1280,
  fixedHeight: 720,
  recordingMonitor: null,
  recordingRegion: null,
  recordingSystemAudio: false,
  recordingSystemDevice: null,
  webcamPosition: "br",
  webcamWidth: 320,
  recordingCountdown: 3,
  recordingMaxMinutes: 0,
};

const plugins = [
  {
    id: "com.snappro.vintage",
    name: "Vintage Filters",
    version: "1.0.0",
    description: "Warm film-style filters for your screenshots.",
    author: "SnapPro",
    tools: [
      { id: "vintage-warm", label: "Warm Film", effect: "sepia", amount: 0.35 },
      { id: "vintage-mono", label: "Soft Mono", effect: "grayscale", amount: 0.9 },
    ],
  },
  {
    id: "com.snappro.social",
    name: "Social Presets",
    version: "1.0.0",
    description: "Square and story sized export presets.",
    author: "SnapPro",
    tools: [
      { id: "social-square", label: "Square 1:1", effect: "crop", amount: 1 },
      { id: "social-story", label: "Story 9:16", effect: "crop", amount: 0.5625 },
    ],
  },
];

const ocrText = `SnapPro — Screenshot, Editor & Recorder
Capture your screen in one keystroke, annotate it and share it.
Press Ctrl+Shift+1 for a full-screen capture, Ctrl+Shift+2 to select a region.`;

export async function mockInvoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  await new Promise((resolve) => setTimeout(resolve, 90));
  const value = (() => {
    switch (command) {
      case "get_settings":
        return settings;
      case "update_settings": {
        // Mirror the real command so clicking a toggle in the browser preview
        // behaves like it does in the app.
        const patch = (args ?? {}) as Partial<typeof settings>;
        Object.assign(settings, patch);
        return settings;
      }
      case "save_settings": {
        const payload = (args ?? {}) as { settings?: Partial<typeof settings> };
        if (payload.settings) Object.assign(settings, payload.settings);
        return null;
      }
      case "library_list":
        return library;
      case "check_dependencies":
        return { ffmpeg: "C:\\ffmpeg\\bin\\ffmpeg.exe", tesseract: "C:\\Tesseract-OCR\\tesseract.exe", ocrLanguages: ["ara", "ben", "chi_sim", "deu", "eng", "fra", "hin", "jpn", "kor", "rus", "spa"] };
      case "get_monitors":
        return [
          { id: 1, name: "DELL U2723QE", x: 0, y: 0, width: 2560, height: 1440, scaleFactor: 1.25, primary: true },
          { id: 2, name: "Laptop panel", x: 2560, y: 0, width: 1920, height: 1080, scaleFactor: 1, primary: false },
        ];
      case "prepare_recording":
      case "take_pending_recording":
        return null;
      case "list_devices":
        return { cameras: ["HD Webcam C920", "Integrated Camera"], microphones: ["Microphone (USB Audio)", "Line In"], loopback: ["Stereo Mix (Realtek)"] };
      case "ocr_languages":
        return ["ara", "ben", "eng", "hin", "jpn"];
      case "desktop_info":
        return { count: 2, width: 2560, height: 1440, scaleFactor: 1.25 };
      case "plugins_list":
        return plugins;
      case "read_image_data":
        return sample("preview", 1280, 720);
      case "library_thumbnail":
        return sample("preview");
      case "keep_capture":
        return "C:\Users\you\Pictures\SnapPro\kept.png";
      case "install_dependency":
        return "installed";
      case "pending_editor_path":
        return null;
      case "last_capture":
        return null;
      case "ocr_image":
      case "ocr_and_copy":
        return { text: ocrText, language: "eng", words: ocrText.split(/\s+/).length, engine: "tesseract" };
      case "capture_full_screen":
      case "capture_all_monitors":
      case "capture_window":
      case "capture_region":
      case "capture_scrolling":
      case "capture_delayed":
      case "capture_freehand":
        return {
          id: String(Math.random()),
          path: `C:\\Users\\you\\Pictures\\SnapPro\\SnapPro_demo.png`,
          width: 1920,
          height: 1080,
          timestamp: Date.now(),
          mode: "full",
          sizeBytes: 402_100,
          monitor: "DELL U2723QE",
        };
      case "export_pdf":
        return "C:\\Users\\you\\Pictures\\SnapPro\\SnapPro.pdf";
      case "export_image":
      case "library_export":
        return "C:\\Users\\you\\Pictures\\SnapPro\\export.png";
      case "save_edited_image":
      case "overwrite_image":
        return { path: args?.targetPath ?? args?.path ?? "export.png", name: "export.png", width: 1920, height: 1080, sizeBytes: 402_100 };
      case "window_action":
      case "set_always_on_top":
      case "set_window_size":
      case "close_window":
      case "open_path":
      case "open_folder":
      case "reveal_item":
      case "library_reveal":
      case "copy_image_file":
      case "start_region_selector":
      case "cancel_region_selector":
      case "copy_text_to_clipboard":
      case "plugin_remove":
      case "plugin_open_folder":
      case "beep":
      case "minimize_all":
      case "quit_app":
      case "open_editor":
      case "copy_image_data":
      case "open_url":
        return null;
      case "region_backdrop_info":
        return { path: "C:\\Users\\you\\Pictures\\SnapPro\\overlay.png", x: 0, y: 0, width: 2560, height: 1440, scale: 1, monitor: "DELL", mode: (args?.mode as string) ?? "region" };
      case "list_windows":
        return [
          { id: 10, title: "SnapPro — Screenshot Editor", appName: "SnapPro", width: 1440, height: 900, x: 100, y: 80, focused: true, minimized: false },
          { id: 11, title: "Documentation · Vite", appName: "Chrome", width: 1600, height: 1000, x: 200, y: 120, focused: false, minimized: false },
          { id: 12, title: "main.rs — snappro", appName: "Code", width: 1500, height: 950, x: 60, y: 60, focused: false, minimized: false },
        ];
      case "window_thumbnail":
        return sample("window");
      case "window_bounds":
        return { x: 200, y: 120, width: 1600, height: 1000, title: "Documentation · Vite" };
      case "pick_color":
        return { r: 124, g: 58, b: 237, a: 255, hex: "#7C3AED" };
      case "upload_image":
        return { url: "https://i.imgur.com/8sKq2pL.png", deleteUrl: null, provider: "imgur" };
      case "ai_remove_background":
      case "ai_blur_faces":
      case "ai_auto_enhance":
        return { path: "C:\\Users\\you\\Pictures\\SnapPro\\SnapPro_enhanced.png", sizeBytes: 380_000 };
      case "start_recording":
        recorder = { recording: true, paused: false, startedAt: Date.now(), output: null, elapsedMs: 0, segments: 1, format: "mp4" };
        return recorder;
      case "recording_status":
        // Without this the pill fell straight back to "READY" in the browser
        // preview, because the command answered null.
        return recorder;
      case "pause_recording":
        recorder = { ...recorder, paused: true };
        return recorder;
      case "resume_recording":
        recorder = { ...recorder, paused: false, segments: recorder.segments + 1 };
        return recorder;
      case "stop_recording":
        recorder = { recording: false, paused: false, startedAt: null, output: "C:\\Users\\you\\Pictures\\SnapPro\\SnapPro_Recording.mp4", elapsedMs: 0, segments: recorder.segments, format: "mp4" };
        return recorder;
      default:
        return null;
    }
  })();
  if (args?.args === "fail") throw new Error("mock failure");
  return value as T;
}

export function mockListen(): () => void {
  return () => undefined;
}

export const isTauri = (): boolean =>
  typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;