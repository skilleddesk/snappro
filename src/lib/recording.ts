import type { RecordMode, RecordOptions, Settings } from "./api";
import { targetMonitorIndex } from "../components/targetMonitor";

/**
 * One place that turns the saved settings into recording options.
 *
 * The toolbar, the quick bar, the floating pill and the source picker used to
 * each build their own options by hand, and they disagreed: the quick bar
 * ignored every setting and the toolbar's mic/camera buttons never reached
 * ffmpeg. They all go through here now.
 */
export function buildRecordOptions(
  settings: Settings,
  overrides: Partial<RecordOptions> = {},
): RecordOptions {
  const mode = (overrides.mode ?? (settings.recordingMode as RecordMode) ?? "screen") as RecordMode;
  return {
    mode,
    monitor: mode === "screen" ? (settings.recordingMonitor ?? targetMonitorIndex(settings.monitor)) : null,
    fps: settings.recordingFps || 30,
    audio: settings.recordingAudio,
    audioDevice: settings.recordingAudioDevice ?? null,
    webcam: settings.recordingWebcam,
    cameraDevice: settings.recordingCameraDevice ?? null,
    region: mode === "custom" ? (settings.recordingRegion ?? null) : null,
    format: settings.recordingFormat || "mp4",
    drawMouse: settings.drawMouse,
    windowId: null,
    windowTitle: null,
    quality: settings.recordingQuality || "balanced",
    webcamPosition: settings.webcamPosition || "br",
    webcamWidth: settings.webcamWidth || 320,
    systemAudio: settings.recordingSystemAudio,
    systemAudioDevice: settings.recordingSystemDevice ?? null,
    ...overrides,
  };
}

/** Wheel-notch hint, fixed capture size etc. are plain settings; this clamps them. */
export function fixedSize(settings: Settings | null): { width: number; height: number } {
  const clamp = (value: number | undefined, fallback: number) =>
    Math.min(8000, Math.max(16, Math.round(value || fallback)));
  return {
    width: clamp(settings?.fixedWidth, 1280),
    height: clamp(settings?.fixedHeight, 720),
  };
}

/** `CmdOrCtrl+Shift+K` from a keyboard event, or null while only modifiers are held. */
export function acceleratorFromEvent(event: {
  key: string;
  code: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}): string | null {
  const modifierKeys = ["Control", "Shift", "Alt", "Meta", "OS", "AltGraph"];
  if (modifierKeys.includes(event.key)) return null;

  let key = "";
  if (event.code.startsWith("Key")) key = event.code.slice(3);
  else if (event.code.startsWith("Digit")) key = event.code.slice(5);
  else if (/^F\d{1,2}$/.test(event.code)) key = event.code;
  else {
    const map: Record<string, string> = {
      Space: "Space",
      Enter: "Enter",
      Tab: "Tab",
      Backspace: "Backspace",
      Delete: "Delete",
      Insert: "Insert",
      Home: "Home",
      End: "End",
      PageUp: "PageUp",
      PageDown: "PageDown",
      ArrowUp: "Up",
      ArrowDown: "Down",
      ArrowLeft: "Left",
      ArrowRight: "Right",
      PrintScreen: "PrintScreen",
      Minus: "-",
      Equal: "=",
      Comma: ",",
      Period: ".",
      Slash: "/",
      Backslash: "\\",
      Semicolon: ";",
      Quote: "'",
      BracketLeft: "[",
      BracketRight: "]",
      Backquote: "`",
    };
    key = map[event.code] ?? "";
  }
  if (!key) return null;

  const parts: string[] = [];
  if (event.ctrlKey || event.metaKey) parts.push("CmdOrCtrl");
  if (event.altKey) parts.push("Alt");
  if (event.shiftKey) parts.push("Shift");
  // Plain keys (other than F-keys and PrintScreen) would hijack typing everywhere.
  const standalone = /^F\d{1,2}$/.test(key) || key === "PrintScreen";
  if (parts.length === 0 && !standalone) return null;
  parts.push(key);
  return parts.join("+");
}

/** "CmdOrCtrl+Shift+1" -> "Ctrl ⇧ 1" for display next to buttons. */
export function prettyAccelerator(accelerator: string, mac = false): string {
  return accelerator
    .split("+")
    .map((part) => {
      if (part === "CmdOrCtrl") return mac ? "⌘" : "Ctrl";
      if (part === "Shift") return "⇧";
      if (part === "Alt") return mac ? "⌥" : "Alt";
      return part;
    })
    .join(" ");
}
