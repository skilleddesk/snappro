import { create } from "zustand";
import * as api from "./api";
import type { CaptureResult, LibraryItem, RecordOptions, RecordingStatus, Settings } from "./api";
import { buildRecordOptions } from "./recording";

export type View =
  | "home"
  | "settings"
  | "history"
  | "ocr"
  | "pdf"
  | "cloud"
  | "ai"
  | "plugins"
  | "editor"
  | "windows"
  | "record"
  | "quick";

export type Toast = {
  id: string;
  message: string;
  kind: "info" | "success" | "error";
};

type Status = "ready" | "busy" | "recording" | "error";

interface AppState {
  view: View;
  previousView: View;
  status: Status;
  statusText: string;
  settings: Settings | null;
  captures: CaptureResult[];
  library: LibraryItem[];
  recording: RecordingStatus | null;
  lastCapture: CaptureResult | null;
  selected: string[];
  editors: string[];
  toasts: Toast[];
  dependencies: api.DependencyReport | null;
  monitors: api.MonitorInfo[];

  setView: (view: View) => void;
  back: () => void;
  setStatus: (status: Status, text?: string) => void;
  toast: (message: string, kind?: Toast["kind"]) => void;
  dismissToast: (id: string) => void;

  loadSettings: () => Promise<void>;
  updateSettings: (patch: Partial<Settings>) => Promise<void>;
  loadLibrary: () => Promise<void>;
  loadRecording: () => Promise<void>;
  loadDependencies: () => Promise<void>;
  loadMonitors: () => Promise<void>;

  startRecording: (overrides?: Partial<RecordOptions>) => Promise<RecordingStatus | null>;
  stopRecording: () => Promise<RecordingStatus | null>;
  toggleRecording: () => Promise<void>;

  pushCapture: (capture: CaptureResult) => void;
  toggleSelected: (path: string) => void;
  clearSelected: () => void;
  openInEditor: (path: string) => void;
  openEditorTab: (path: string) => void;
  closeEditorTab: (path: string) => void;
}

const MAX_TOASTS = 3;

export const useStore = create<AppState>((set, get) => ({
  view: "home",
  previousView: "home",
  status: "ready",
  statusText: "Ready",
  settings: null,
  captures: [],
  library: [],
  recording: null,
  lastCapture: null,
  selected: [],
  editors: [],
  toasts: [],
  dependencies: null,
  monitors: [],

  setView: (view) => set({ view, previousView: get().view }),
  back: () => set({ view: get().previousView === get().view ? "home" : get().previousView }),
  setStatus: (status, text) =>
    set({
      status,
      statusText:
        text ??
        (status === "busy"
          ? "Working…"
          : status === "recording"
            ? "Recording"
            : status === "error"
              ? "Something went wrong"
              : "Ready"),
    }),

  toast: (message, kind = "info") => {
    const id = Math.random().toString(36).slice(2);
    set({ toasts: [...get().toasts, { id, message, kind }].slice(-MAX_TOASTS) });
    window.setTimeout(() => get().dismissToast(id), 4200);
  },
  dismissToast: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),

  loadSettings: async () => {
    try {
      const settings = await api.getSettings();
      set({ settings });
    } catch (error) {
      get().toast(api.errorMessage(error), "error");
    }
  },

  updateSettings: async (patch) => {
    const current = get().settings;
    if (!current) return;
    const next = { ...current, ...patch };
    set({ settings: next });
    try {
      const failed = await api.saveSettings(next);
      if (failed.length > 0) {
        get().toast(`Shortcut not available (used by another app?): ${failed.join(", ")}`, "error");
      }
    } catch (error) {
      // The backend refused (for example a folder that cannot be written): go back.
      set({ settings: current });
      get().toast(api.errorMessage(error), "error");
    }
  },

  loadLibrary: async () => {
    try {
      const library = await api.libraryList();
      set({ library });
    } catch (error) {
      get().toast(api.errorMessage(error), "error");
    }
  },

  loadRecording: async () => {
    try {
      const recording = await api.recordingStatus();
      set({ recording });
      if (recording.recording) {
        set({ status: "recording", statusText: recording.paused ? "Paused" : "Recording" });
      }
    } catch {
      /* the recorder is not available until the app is ready */
    }
  },

  loadDependencies: async () => {
    try {
      const dependencies = await api.checkDependencies();
      set({ dependencies });
    } catch {
      /* ignore */
    }
  },

  loadMonitors: async () => {
    try {
      const monitors = await api.getMonitors();
      set({ monitors });
    } catch {
      /* ignore */
    }
  },

  startRecording: async (overrides) => {
    const settings = get().settings;
    if (!settings) return null;
    try {
      let options = buildRecordOptions(settings, overrides);

      // "Record a window" with no window chosen yet: take the one in front.
      if (options.mode === "window" && !options.region) {
        const windows = await api.listWindows().catch(() => []);
        const target = windows.find((w) => w.focused) ?? windows[0];
        if (!target) throw new Error("Pick the window to record in Record setup first");
        const bounds = await api.windowBounds(target.id);
        options = {
          ...options,
          region: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
          windowId: String(target.id),
          windowTitle: target.title,
        };
      }
      if (options.mode === "custom" && !options.region) {
        throw new Error("Select the area to record in Record setup first");
      }

      // The floating pill counts down, shows the controls and starts the take.
      await api.prepareRecording({
        options,
        seconds: settings.recordingCountdown ?? 0,
        maxMinutes: settings.recordingMaxMinutes ?? 0,
      });
      return null;
    } catch (error) {
      get().toast(api.errorMessage(error), "error");
      return null;
    }
  },

  stopRecording: async () => {
    try {
      set({ status: "busy", statusText: "Finishing the recording…" });
      const result = await api.stopRecording();
      set({ recording: null, status: "ready", statusText: "Saved" });
      void get().loadLibrary();
      get().toast(`Recording saved: ${result.output?.split(/[\\/]/).pop() ?? ""}`, "success");
      return result;
    } catch (error) {
      set({ status: "error", statusText: "Something went wrong" });
      get().toast(api.errorMessage(error), "error");
      return null;
    }
  },

  toggleRecording: async () => {
    const current = get().recording;
    if (current?.recording || current?.paused) await get().stopRecording();
    else await api.showRecorder();
  },

  pushCapture: (capture) =>
    set({
      lastCapture: capture,
      captures: [capture, ...get().captures].slice(0, 40),
    }),

  toggleSelected: (path) => {
    const selected = get().selected;
    set({
      selected: selected.includes(path)
        ? selected.filter((p) => p !== path)
        : [...selected, path],
    });
  },
  clearSelected: () => set({ selected: [] }),

  openInEditor: (path) => {
    const editors = get().editors;
    set({
      editors: editors.includes(path) ? editors : [...editors, path],
    });
    // The editor has its own native window with its own store, so the path has
    // to travel over the bridge as well - otherwise the window opens empty.
    void api.openEditor(path);
  },
  openEditorTab: (path) => {
    const editors = get().editors;
    if (editors.includes(path)) return;
    set({ editors: [...editors, path] });
  },
  closeEditorTab: (path) => {
    set({ editors: get().editors.filter((p) => p !== path) });
  },
}));