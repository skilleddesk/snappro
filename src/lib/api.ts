import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { isTauri, mockInvoke } from "./mock";

/**
 * In the packaged app every call goes straight to the Rust backend. When the
 * frontend is opened in a plain browser (design review) sample data is used.
 */
const call = async <T,>(command: string, args?: Record<string, unknown>): Promise<T> => {
  if (isTauri()) return invoke<T>(command, args);
  return mockInvoke<T>(command, args);
};

// ---------------------------------------------------------------------------
// Types (mirror the Rust structs, which are serialised as camelCase)
// ---------------------------------------------------------------------------

export interface CaptureResult {
  id: string;
  path: string;
  width: number;
  height: number;
  timestamp: number;
  mode: string;
  sizeBytes: number;
  monitor: string;
  /** True while the file sits in the temp folder (Auto save is off). */
  temporary?: boolean;
}

export interface Settings {
  saveDir: string;
  videoDir: string;
  exportDir: string;
  format: string;
  autoCopy: boolean;
  autoSave: boolean;
  openPreview: boolean;
  monitor: string;
  delaySecs: number;
  alwaysOnTop: boolean;
  miniMode: boolean;
  language: string;
  playSound: boolean;
  includeCursor: boolean;
  imgurClientId: string;
  s3Region: string;
  s3AccessKey: string;
  s3SecretKey: string;
  s3Prefix: string;
  s3Bucket: string;
  autoOcrCaption: boolean;
  launchAtStartup: boolean;
  shortcutOcr: string;
  shortcuts: string[];
  // --- recording ---
  recordingFps: number;
  recordingAudio: boolean;
  recordingAudioDevice: string | null;
  recordingWebcam: boolean;
  recordingCameraDevice: string | null;
  recordingFormat: string;
  recordingQuality: string;
  drawMouse: boolean;
  recordingMode: string;
  fixedWidth: number;
  fixedHeight: number;
  recordingMonitor: number | null;
  recordingRegion: RegionRect | null;
  recordingSystemAudio: boolean;
  recordingSystemDevice: string | null;
  webcamPosition: "br" | "bl" | "tr" | "tl";
  webcamWidth: number;
  recordingCountdown: number;
  recordingMaxMinutes: number;
}

export interface LibraryItem {
  id: string;
  name: string;
  path: string;
  width: number;
  height: number;
  sizeBytes: number;
  created: number;
  kind: "image" | "video";
}

export interface WindowBounds {
  x: number;
  y: number;
  width: number;
  height: number;
  title: string;
}

export interface WindowInfo {
  id: number;
  title: string;
  appName: string;
  width: number;
  height: number;
  x: number;
  y: number;
  focused: boolean;
  minimized: boolean;
}

export interface MonitorInfo {
  id: number;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  scaleFactor: number;
  primary: boolean;
}

export interface RegionRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** What a recording captures. */
export type RecordMode = "screen" | "window" | "custom";

export interface RecordOptions {
  /** "screen" (a whole display), "window" (one window) or "custom" (a rect). */
  mode: RecordMode;
  monitor: number | null;
  fps: number;
  audio: boolean;
  audioDevice: string | null;
  webcam: boolean;
  cameraDevice: string | null;
  region: RegionRect | null;
  format: string;
  drawMouse: boolean;
  /** Window recording (`mode: "window"`): native handle or xcap window id. */
  windowId?: string | null;
  /** Window recording fallback when no id is available: the window title. */
  windowTitle?: string | null;
  /** "high" | "balanced" | "small" - maps to an x264 crf preset. */
  quality?: string | null;
  /** Corner of the picture the webcam sits in. */
  webcamPosition?: "br" | "bl" | "tr" | "tl";
  webcamWidth?: number;
  /** Record what the computer plays (loopback source). */
  systemAudio?: boolean;
  systemAudioDevice?: string | null;
  keepAudioTrack?: boolean;
}

/** What the main window hands to the recorder pill. */
export interface RecordingRequest {
  options: RecordOptions;
  seconds: number;
  maxMinutes: number;
}

export interface RecordingStatus {
  recording: boolean;
  paused: boolean;
  startedAt: number | null;
  output: string | null;
  elapsedMs: number;
  segments: number;
  format: string;
  /** Human-readable capture target, e.g. "Window: Chrome". */
  source: string | null;
  quality: string | null;
}

export interface Devices {
  cameras: string[];
  microphones: string[];
  /** Sources carrying what the speakers play (Stereo Mix, BlackHole, *.monitor). */
  loopback: string[];
}

export interface SelectorInfo {
  path: string;
  x: number;
  y: number;
  width: number;
  height: number;
  scale: number;
  monitor: string;
  /** Which tool armed the overlay (region, scrolling, freehand, fixed, pick, ocr, record). */
  mode: string;
}

export interface OcrResult {
  text: string;
  language: string;
  words: number;
  engine: string;
}

export interface UploadResult {
  url: string;
  deleteUrl: string | null;
  provider: string;
}

export interface PluginTool {
  id: string;
  label: string;
  icon?: string;
  effect?: string;
  amount?: number;
}

export interface PluginManifest {
  id: string;
  name: string;
  version?: string;
  description?: string;
  author?: string;
  tools: PluginTool[];
}

export interface DependencyReport {
  ffmpeg: string | null;
  tesseract: string | null;
  ocrLanguages: string[];
  platform?: string;
  arch?: string;
  appVersion?: string;
  /** Why recording cannot work in this session (for example Wayland), if it cannot. */
  recordingBlocker?: string | null;
  /** Linux Wayland session: the desktop itself asks which screen or window to share. */
  wayland?: boolean;
}

export interface SavedImage {
  path: string;
  name?: string;
  width: number;
  height: number;
  sizeBytes: number;
}

export interface SavedFile {
  path: string;
  sizeBytes: number;
}

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

export const captureFullScreen = (monitor?: number | null) =>
  call<CaptureResult>("capture_full_screen", { monitor: monitor ?? null });

export const captureAllMonitors = () => call<CaptureResult>("capture_all_monitors");

export const captureRegion = (x: number, y: number, width: number, height: number) =>
  call<CaptureResult>("capture_region", { x, y, width, height });

export const captureFreehand = (points: [number, number][]) =>
  call<CaptureResult>("capture_freehand", { points });

export const captureWindow = (windowId?: number) =>
  call<CaptureResult>("capture_window", { windowId: windowId ?? null });

export const captureScrolling = (
  x: number,
  y: number,
  width: number,
  height: number,
  options?: { maxFrames?: number; scrollAmount?: number; delayMs?: number },
) =>
  call<CaptureResult>("capture_scrolling", {
    x,
    y,
    width,
    height,
    maxFrames: options?.maxFrames ?? null,
    scrollAmount: options?.scrollAmount ?? null,
    delayMs: options?.delayMs ?? null,
  });

export const captureDelayed = (seconds?: number) =>
  call<CaptureResult>("capture_delayed", { seconds: seconds ?? null });

export type SelectorMode =
  | "region"
  | "scrolling"
  | "freehand"
  | "fixed"
  | "pick"
  | "ocr"
  | "recarea"
  | "recwindow"
  | "recfixed";

export const startRegionSelector = (
  mode: SelectorMode = "region",
  monitor?: number | null,
  all?: boolean,
) => call<void>("start_region_selector", { mode, monitor: monitor ?? null, all: all ?? null });
export const cancelRegionSelector = () => call<void>("cancel_region_selector");
export const regionBackdropInfo = () => call<SelectorInfo>("region_backdrop_info");
export const listWindows = () => call<WindowInfo[]>("list_windows");
export const windowThumbnail = (windowId: number, maxWidth?: number) =>
  call<string>("window_thumbnail", { windowId, maxWidth: maxWidth ?? null });
export const windowBounds = (windowId: number) =>
  call<WindowBounds>("window_bounds", { windowId });
export const getMonitors = () => call<MonitorInfo[]>("get_monitors");
export const pickColor = (x: number, y: number) =>
  call<{ r: number; g: number; b: number; a: number; hex: string }>("pick_color", { x, y });

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

export const listDevices = () => call<Devices>("list_devices");
export const recordingStatus = () => call<RecordingStatus>("recording_status");
export const startRecording = (options: RecordOptions) =>
  call<RecordingStatus>("start_recording", { options });
export const pauseRecording = () => call<RecordingStatus>("pause_recording");
export const resumeRecording = () => call<RecordingStatus>("resume_recording");
export const stopRecording = () => call<RecordingStatus>("stop_recording");
export const prepareRecording = (request: RecordingRequest) =>
  call<void>("prepare_recording", { request });
export const showRecorder = () => call<void>("show_recorder");
export const reconfigureRecording = (change: {
  audio?: boolean;
  audioDevice?: string;
  systemAudio?: boolean;
  webcam?: boolean;
}) => call<RecordingStatus>("reconfigure_recording", { change });
export const takePendingRecording = () => call<RecordingRequest | null>("take_pending_recording");

// ---------------------------------------------------------------------------
// Editing / export
// ---------------------------------------------------------------------------

export const saveEditedImage = (dataUrl: string, source?: string, targetPath?: string) =>
  call<SavedImage>("save_edited_image", {
    dataUrl,
    source: source ?? null,
    targetPath: targetPath ?? null,
  });

export const overwriteImage = (dataUrl: string, path: string) =>
  call<{ path: string; sizeBytes: number; width: number; height: number; format: string }>(
    "overwrite_image",
    { dataUrl, path },
  );

export const exportImage = (dataUrl: string, targetPath?: string, format?: string) =>
  call<string>("export_image", {
    dataUrl,
    targetPath: targetPath ?? null,
    format: format ?? null,
  });

export interface PdfOptions {
  pageSize: "a4" | "a3" | "a5" | "letter" | "legal" | "tabloid" | "image";
  orientation: "auto" | "portrait" | "landscape";
  margin: "none" | "small" | "normal" | "large";
  fit: "fit" | "fill" | "actual";
  quality: "auto" | "lossless" | "high" | "small";
  perPage: 1 | 2 | 4;
  splitTall: boolean;
  neverEnlarge: boolean;
  pageNumbers: boolean;
  captions: boolean;
  background: string;
  align: "center" | "top";
  dpi: number;
  title?: string | null;
}

export const defaultPdfOptions: PdfOptions = {
  pageSize: "a4",
  orientation: "auto",
  margin: "small",
  fit: "fit",
  quality: "auto",
  perPage: 1,
  splitTall: true,
  neverEnlarge: false,
  pageNumbers: false,
  captions: false,
  background: "#ffffff",
  align: "center",
  dpi: 96,
};

export const exportPdf = (paths: string[], targetPath?: string, options?: PdfOptions) =>
  call<string>("export_pdf", { paths, targetPath: targetPath ?? null, options: options ?? null });

export const exportPdfData = (dataUrl: string, targetPath?: string, options?: PdfOptions) =>
  call<string>("export_pdf_data", { dataUrl, targetPath: targetPath ?? null, options: options ?? null });

export interface PdfPagePlan {
  width: number;
  height: number;
  tiles: { source: number; crop: number[]; rect: number[]; dpi: number }[];
}
export const pdfPlan = (sizes: [number, number][], options: PdfOptions) =>
  call<PdfPagePlan[]>("pdf_plan", { sizes, options });

export const listDrives = () => call<{ path: string; label: string }[]>("list_drives");

export const readImageData = (path: string) => call<string>("read_image_data", { path });
export const copyImageFile = (path: string) => call<void>("copy_image_file", { path });
export const copyImageData = (dataUrl: string) => call<void>("copy_image_data", { dataUrl });
export const libraryThumbnail = (path: string, maxWidth?: number) =>
  call<string>("library_thumbnail", { path, maxWidth: maxWidth ?? null });
export const keepCapture = (path: string) => call<string>("keep_capture", { path });
export const openUrl = (url: string) => call<void>("open_url", { url });
export const installDependency = (name: "ffmpeg" | "tesseract") =>
  call<string>("install_dependency", { name });

/** Linux Wayland: whether the desktop still has to be told that SnapPro may take screenshots. */
export const screenshotPermissionState = () =>
  call<{ needed: boolean }>("screenshot_permission_state");

/** Asks the desktop (once) to allow screenshots; the question only appears while a SnapPro window is active. */
export const requestScreenshotPermission = () => call<void>("request_screenshot_permission");

// ---------------------------------------------------------------------------
// Library
// ---------------------------------------------------------------------------

export const libraryList = () => call<LibraryItem[]>("library_list");
export const libraryDelete = (path: string) => call<void>("library_delete", { path });
export const libraryRename = (path: string, newName: string) =>
  call<string>("library_rename", { path, newName });
export const libraryExport = (path: string, targetDir?: string) =>
  call<string>("library_export", { path, targetDir: targetDir ?? null });
export const revealItem = (path: string) => call<void>("reveal_item", { path });
export const openPath = (path: string) => call<void>("open_path", { path });
export const openFolder = (path: string) => call<void>("open_folder", { path });
export const focusMainWindow = () => call<void>("focus_main_window");

// ---------------------------------------------------------------------------
// OCR / AI / cloud / plugins
// ---------------------------------------------------------------------------

export const ocrImage = (path: string, language = "eng") =>
  call<OcrResult>("ocr_image", { path, language });
export const ocrLanguages = () => call<string[]>("ocr_languages");

export const aiRemoveBackground = (path: string, tolerance?: number) =>
  call<SavedFile>("ai_remove_background", { path, tolerance: tolerance ?? null });
export const aiBlurFaces = (path: string, strength?: number) =>
  call<SavedFile>("ai_blur_faces", { path, strength: strength ?? null });
export const aiAutoEnhance = (path: string) =>
  call<SavedFile>("ai_auto_enhance", { path });

export const uploadImage = (args: {
  path: string;
  provider?: string;
  clientId?: string;
  endpoint?: string;
  token?: string;
  bucket?: string;
  region?: string;
  accessKey?: string;
  secretKey?: string;
  prefix?: string;
}) => call<UploadResult>("upload_image", { args });

export const ocrAndCopy = (path: string, language = "eng") =>
  call<OcrResult>("ocr_and_copy", { path, language });

export const copyTextToClipboard = (text: string) =>
  call<void>("copy_text_to_clipboard", { text });

export const desktopInfo = () =>
  call<{ count: number; width: number; height: number; scaleFactor: number }>("desktop_info");

export const pluginsList = () => call<PluginManifest[]>("plugins_list");
export const pluginInstall = (path: string) => call<PluginManifest>("plugin_install", { path });
export const pluginRemove = (id: string) => call<void>("plugin_remove", { id });
export const pluginOpenFolder = () => call<void>("plugin_open_folder");

// ---------------------------------------------------------------------------
// Settings & helpers
// ---------------------------------------------------------------------------

export const getSettings = () => call<Settings>("get_settings");
/** Resolves with the shortcuts that could not be registered (taken or invalid). */
export const saveSettings = (settings: Settings) =>
  call<string[] | null>("save_settings", { settings }).then((failed) => failed ?? []);
export const checkDependencies = () => call<DependencyReport>("check_dependencies");
export const beep = () => call<void>("beep");
export const closeWindow = (label?: string) => call<void>("close_window", { label: label ?? null });
export const lastCapture = () => call<CaptureResult | null>("last_capture");
export const pendingEditorPath = () => call<string | null>("pending_editor_path");
export const openEditor = (path: string) => call<void>("open_editor", { path });
export const windowAction = (action: string) =>
  call<void>("window_action", { action });
export const setAlwaysOnTop = (value: boolean, label?: string) =>
  call<void>("set_always_on_top", { label: label ?? null, value });
export const setWindowSize = (width: number, height: number, label?: string) =>
  call<void>("set_window_size", { width, height, label: label ?? null });
export const minimizeAll = () => call<void>("minimize_all");
export const quitApp = () => call<void>("quit_app");

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export const on = <T,>(event: string, handler: (payload: T) => void): Promise<UnlistenFn> =>
  isTauri()
    ? listen<T>(event, (e) => handler(e.payload))
    : Promise.resolve(() => undefined);

export const EVENTS = {
  captureComplete: "capture://complete",
  captureFailed: "capture://failed",
  recordArea: "record://area",
  recordWindow: "record://window",
  regionBackdrop: "region://backdrop",
  recordingStarted: "recording://started",
  recordingPaused: "recording://paused",
  recordingResumed: "recording://resumed",
  recordingStopped: "recording://stopped",
  editorOpen: "editor://open",
  previewImage: "preview://image",
  libraryChanged: "library://changed",
  settingsChanged: "settings://changed",
  navLibrary: "nav://library",
  navRecord: "nav://record",
  navScrolling: "nav://scrolling",
  scrollingProgress: "scrolling://progress",
  scrollingStarted: "scrolling://started",
  permissionScreenshot: "permission://screenshot",
  permissionScreenshotAllowed: "permission://screenshot-allowed",
} as const;

/** Live frame counter for a running scrolling capture. */
export const onScrollingProgress = (
  handler: (done: number, total: number) => void,
): Promise<UnlistenFn> =>
  listen<{ done: number; total: number }>(EVENTS.scrollingProgress, (event) =>
    handler(event.payload.done, event.payload.total),
  );

/** Fired when the backend starts driving the page, before the first frame. */
export const onScrollingStarted = (handler: () => void): Promise<UnlistenFn> =>
  listen<unknown>(EVENTS.scrollingStarted, () => handler());

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

export function formatBytes(bytes: number): string {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / Math.pow(1024, index);
  // Whole numbers stay whole (2 KB, not 2.0 KB); everything else gets one decimal.
  const rounded = Math.abs(value - Math.round(value)) < 0.05 ? Math.round(value) : value.toFixed(1);
  return `${rounded} ${units[index]}`;
}

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (n: number) => String(n).padStart(2, "0");
  return hours > 0 ? `${pad(hours)}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}

export function formatDate(ms: number): string {
  if (!ms) return "—";
  const date = new Date(ms);
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function errorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  return String(error);
}
/** Send an event to every window (the region overlay reports picks to the main window). */
export const emitEvent = async (event: string, payload?: unknown): Promise<void> => {
  if (!isTauri()) return;
  const { emit } = await import("@tauri-apps/api/event");
  await emit(event, payload);
};

export interface PickedWindow {
  id: number;
  title: string;
  appName: string;
  x: number;
  y: number;
  width: number;
  height: number;
}
