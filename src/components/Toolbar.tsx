import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "./Icon";
import * as api from "../lib/api";
import { useStore } from "../lib/store";
import { Panels } from "./Panels";
import { MiniMode } from "./MiniMode";
import { PermissionBanner } from "./PermissionBanner";
import { nativeWindow } from "../lib/window";
import { prettyAccelerator } from "../lib/recording";
import { targetMonitorIndex } from "./targetMonitor";

function WindowControls() {
  const settings = useStore((s) => s.settings);
  const updateSettings = useStore((s) => s.updateSettings);
  const setView = useStore((s) => s.setView);
  const view = useStore((s) => s.view);

  const togglePin = async () => {
    const next = !(settings?.alwaysOnTop ?? true);
    await updateSettings({ alwaysOnTop: next });
    await api.setAlwaysOnTop(next, "main");
  };

  return (
    <div className="flex items-center gap-0.5">
      <button
        className={`win-ctrl ${view === "settings" ? "bg-white/10 text-slate-200" : ""}`}
        title="Settings"
        onClick={() => setView(view === "settings" ? "home" : "settings")}
      >
        <Icon name="settings" size={14} strokeWidth={1.8} />
      </button>
      <button
        className={`win-ctrl ${settings?.alwaysOnTop ? "text-indigo-300" : ""}`}
        title="Pin on top"
        onClick={togglePin}
      >
        <Icon name="pin" size={14} strokeWidth={1.8} />
      </button>
      <button className="win-ctrl" title="Minimize" onClick={() => void nativeWindow()?.minimize()}>
        <Icon name="minimize" size={14} strokeWidth={2} />
      </button>
      <button className="win-ctrl close" title="Hide to tray" onClick={() => api.closeWindow("main")}>
        <Icon name="close" size={14} strokeWidth={2} />
      </button>
    </div>
  );
}

function Header() {
  return (
    <div
      data-tauri-drag-region
      className="drag-handle flex items-center justify-between pl-3 pr-2 h-11 border-b border-white/5"
    >
      <div className="flex items-center gap-2.5" data-tauri-drag-region>
        <div className="brand-logo w-7 h-7 rounded-lg flex items-center justify-center">
          <Icon name="logo" size={15} strokeWidth={2.2} stroke="#fff" />
        </div>
        <div className="flex items-baseline gap-2">
          <span className="text-[13px] font-semibold text-white tracking-tight">SnapPro</span>
          <span className="text-[9px] font-semibold tracking-wider text-indigo-300/80 bg-indigo-500/10 border border-indigo-500/20 px-1.5 py-0.5 rounded">
            PRO
          </span>
        </div>
      </div>
      <WindowControls />
    </div>
  );
}

type ToolButtonProps = {
  icon: string;
  label?: string;
  tooltip: string;
  kbd?: string;
  badge?: string;
  onClick?: () => void;
  active?: boolean;
  disabled?: boolean;
  className?: string;
  compact?: boolean;
};

function ToolButton({
  icon,
  label,
  tooltip,
  kbd,
  badge,
  onClick,
  active,
  disabled,
  className = "",
  compact,
}: ToolButtonProps) {
  return (
    <button
      className={`tool-btn group ${compact ? "h-10 rounded-lg flex items-center justify-center" : "h-[60px] rounded-xl flex flex-col items-center justify-center gap-1.5"} ${active ? "is-active" : ""} ${className}`}
      onClick={onClick}
      disabled={disabled}
    >
      <Icon name={icon} size={compact ? 17 : 19} strokeWidth={1.75} className="tool-icon" />
      {label ? <span className="tool-label">{label}</span> : null}
      {badge ? (
        <span className="ai-badge absolute -top-1 -right-1 text-white px-1.5 py-0.5 rounded-full">
          {badge}
        </span>
      ) : null}
      <span className="tooltip">
        {tooltip}
        {kbd ? <span className="kbd">{kbd}</span> : null}
      </span>
    </button>
  );
}

function QuickBar() {
  // Quick bar (app style): only the few essential actions. The leading logo
  // button in `MiniMode` expands into the full panel.
  const settings = useStore((s) => s.settings);
  if (!settings?.miniMode) return null;
  return <MiniMode />;
}

export function Toolbar() {
  const settings = useStore((s) => s.settings);
  const miniMode = Boolean(settings?.miniMode);
  const permissionNeeded = useStore((s) => s.screenshotPermissionNeeded);

  // Sizing belongs here, not inside MiniMode: entering the full panel unmounts
  // MiniMode, so a resize effect living there never ran. The quick bar grows
  // while the "Allow screenshots" notice is shown under it.
  useEffect(() => {
    void api.setWindowSize(372, miniMode ? (permissionNeeded ? 176 : 56) : 668, "main");
  }, [miniMode, permissionNeeded]);

  if (miniMode)
    return (
      <>
        <QuickBar />
        <PermissionBanner className="absolute left-1 right-1 top-[54px]" />
      </>
    );
  return <FullPanel />;
}

function FullPanel() {
  const {
    view,
    setView,
    status,
    statusText,
    settings,
    library,
    recording,
    dependencies,
    loadSettings,
    loadLibrary,
    loadRecording,
    loadDependencies,
    loadMonitors,
    pushCapture,
    toast,
    setStatus,
    updateSettings,
    toggleRecording,
  } = useStore();

  const [busy, setBusy] = useState(false);
  const [installing, setInstalling] = useState(false);
  const mounted = useRef(true);
  const accel = (slot: number) => prettyAccelerator(settings?.shortcuts?.[slot] ?? "");

  useEffect(() => {
    mounted.current = true;
    void loadSettings();
    void loadLibrary();
    void loadRecording();
    void loadDependencies();
    void loadMonitors();
    return () => {
      mounted.current = false;
    };
  }, [loadSettings, loadLibrary, loadRecording, loadDependencies, loadMonitors]);

  const run = async <T,>(label: string, task: () => Promise<T>) => {
    setBusy(true);
    setStatus("busy", label);
    try {
      return await task();
    } catch (error) {
      setStatus("error", api.errorMessage(error));
      toast(api.errorMessage(error), "error");
      window.setTimeout(() => setStatus("ready"), 2600);
      return null;
    } finally {
      setBusy(false);
    }
  };

  const finishCapture = (result: api.CaptureResult | null) => {
    if (!result) return;
    pushCapture(result);
    void loadLibrary();
    setStatus("ready", "Saved");
    window.setTimeout(() => setStatus("ready"), 1800);
  };

  const monitor = targetMonitorIndex(settings?.monitor);

  const captureFull = () =>
    run("Capturing full screen…", async () => {
      const result = await api.captureFullScreen(monitor);
      finishCapture(result);
      return result;
    });

  const captureAll = () =>
    run("Capturing all displays…", async () => {
      const result = await api.captureAllMonitors();
      finishCapture(result);
      return result;
    });

  const captureWindow = () =>
    run("Capturing window…", async () => {
      const result = await api.captureWindow();
      finishCapture(result);
      return result;
    });

  /** Region-style tools all share the full-screen selector overlay. */
  const selector = (
    mode: "region" | "scrolling" | "freehand" | "fixed" | "pick" | "ocr" | "recarea" | "recwindow",
    label: string,
  ) =>
    run(label, async () => {
      await api.startRegionSelector(mode, monitor);
      return true;
    });

  const delayedCapture = () => {
    const seconds = settings?.delaySecs ?? 3;
    let left = seconds;
    setBusy(true);
    setStatus("busy", `Capturing in ${left}s…`);
    const timer = window.setInterval(() => {
      left -= 1;
      if (left > 0) setStatus("busy", `Capturing in ${left}s…`);
    }, 1000);
    void api
      .captureDelayed(seconds)
      .then(finishCapture)
      .catch((error) => {
        setStatus("error", api.errorMessage(error));
        toast(api.errorMessage(error), "error");
      })
      .finally(() => {
        window.clearInterval(timer);
        setBusy(false);
      });
  };

  const recordingActive = Boolean(recording?.recording || recording?.paused);

  const openEditor = () => {
    const state = useStore.getState();
    const candidate =
      state.lastCapture?.path ??
      state.library.find((item) => item.kind === "image")?.path ??
      null;
    if (candidate) state.openInEditor(candidate);
    else state.setView("history");
  };

  const toggleDevice = async (kind: "mic" | "cam") => {
    if (!settings) return;
    const enabling = kind === "mic" ? !settings.recordingAudio : !settings.recordingWebcam;
    if (enabling) {
      const devices = await api.listDevices().catch(() => ({ cameras: [], microphones: [] }));
      const list = kind === "mic" ? devices.microphones : devices.cameras;
      if (list.length === 0) {
        toast(kind === "mic" ? "No microphone found on this system" : "No webcam found on this system", "error");
        return;
      }
      await updateSettings(
        kind === "mic"
          ? { recordingAudio: true, recordingAudioDevice: settings.recordingAudioDevice ?? list[0] }
          : { recordingWebcam: true, recordingCameraDevice: settings.recordingCameraDevice ?? list[0] },
      );
    } else {
      await updateSettings(kind === "mic" ? { recordingAudio: false } : { recordingWebcam: false });
    }
  };

  const installFfmpeg = async () => {
    setInstalling(true);
    try {
      await api.installDependency("ffmpeg");
      await loadDependencies();
      toast("ffmpeg installed — recording is ready", "success");
    } catch (error) {
      toast(api.errorMessage(error), "error");
    } finally {
      setInstalling(false);
    }
  };

  const historyCount = library.length;
  const diskUsage = useMemo(
    () => api.formatBytes(library.reduce((total, item) => total + item.sizeBytes, 0)),
    [library],
  );

  // The floating recorder pill asks the main window to show the record panel.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void api
      .on(api.EVENTS.navRecord, () => {
        useStore.getState().setView("record");
        void api.focusMainWindow();
      })
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => undefined);
    return () => unlisten?.();
  }, []);

  const ffmpegMissing = dependencies !== null && !dependencies.ffmpeg;

  return (
    <div className="relative">
      <div
        className="popup-enter glass-panel rounded-2xl select-none flex flex-col"
        style={{ width: 372, height: "calc(100vh - 8px)" }}
      >
        <Header />

        <PermissionBanner className="mx-3.5 mt-2.5" />

        <div className="px-3.5 pt-2.5">
          <button
            className="w-full ghost-btn py-1.5 text-[10.5px] font-medium"
            onClick={() => void updateSettings({ miniMode: true })}
            title="Switch to the compact quick bar"
          >
            Quick bar
          </button>
        </div>

        <div className="p-3.5 flex-1 overflow-y-auto thin-scroll">
          {/* ────── CAPTURE ────── */}
          <div className="flex items-center justify-between mb-2.5 px-1">
            <span className="section-label">Capture</span>
            <button
              className="flex items-center gap-1.5 text-[10px] font-medium text-slate-400 hover:text-indigo-300 transition-colors group"
              onClick={delayedCapture}
              disabled={busy}
              title="Capture the screen after a countdown"
            >
              <Icon name="clock" size={11} strokeWidth={2} />
              <span>Delay</span>
              <span className="font-mono text-indigo-300 bg-indigo-500/10 border border-indigo-500/20 px-1.5 py-0.5 rounded text-[9.5px] group-hover:border-indigo-400/40">
                {settings?.delaySecs ?? 3}s
              </span>
            </button>
          </div>

          <div className="grid grid-cols-4 gap-2">
            <ToolButton icon="fullscreen" label="Full" tooltip="Full Screen" kbd={accel(0)} onClick={captureFull} disabled={busy} />
            <ToolButton icon="monitors" label="All" tooltip="All Monitors" onClick={captureAll} disabled={busy} />
            <ToolButton
              icon="region"
              label="Region"
              tooltip="Rectangular Region (hover a window to snap to it)"
              kbd={accel(1)}
              onClick={() => void selector("region", "Select an area…")}
              disabled={busy}
            />
            <ToolButton icon="window" label="Window" tooltip="Active Window" kbd={accel(2)} onClick={captureWindow} disabled={busy} />
            <ToolButton
              icon="scrolling"
              label="Scroll"
              badge="AI"
              tooltip="Scrolling capture + smart stitching"
              kbd={accel(3)}
              onClick={() => void selector("scrolling", "Preparing scrolling capture…")}
              disabled={busy}
            />
            <ToolButton
              icon="pencil"
              label="Free"
              tooltip="Freehand Region"
              onClick={() => void selector("freehand", "Draw the area you want…")}
              disabled={busy}
            />
            <ToolButton
              icon="fixed"
              label="Fixed"
              tooltip={`Fixed size ${settings?.fixedWidth ?? 1280}×${settings?.fixedHeight ?? 720} — click to place`}
              onClick={() => void selector("fixed", "Click to place the frame…")}
              disabled={busy}
            />
            <ToolButton
              icon="ocr"
              label="Text"
              tooltip="Grab text from the screen (OCR to clipboard)"
              kbd={prettyAccelerator(settings?.shortcutOcr ?? "")}
              onClick={() => void selector("ocr", "Select the text area…")}
              disabled={busy}
            />
            <ToolButton
              icon="eyedropper"
              label="Color"
              tooltip="Screen colour picker with magnifier"
              onClick={() => void selector("pick", "Click a colour…")}
              disabled={busy}
            />
            <ToolButton icon="window" label="Windows" tooltip="Pick a window from a list" onClick={() => setView("windows")} active={view === "windows"} />
            <ToolButton icon="image" label="Editor" tooltip="Open the last capture in the editor" onClick={openEditor} />
            <ToolButton
              icon="history"
              label="History"
              tooltip={`${historyCount} items`}
              onClick={() => setView("history")}
              active={view === "history"}
            />
          </div>

          <div className="divider my-3.5" />

          {/* ────── RECORDER ────── */}
          <div className="flex items-center justify-between mb-2.5 px-1">
            <span className="section-label">Recorder</span>
            <button
              type="button"
              className="text-[10px] text-violet-300/90 hover:text-violet-200 font-medium"
              onClick={() => setView("record")}
            >
              Choose source
            </button>
          </div>

          {ffmpegMissing ? (
            <div className="mb-2 rounded-xl border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-[10px] text-amber-100 leading-relaxed">
              Recording needs <b>ffmpeg</b>, which is not installed.
              <button className="chip ml-2" onClick={() => void installFfmpeg()} disabled={installing}>
                {installing ? "Installing…" : "Install now"}
              </button>
            </div>
          ) : null}
          {dependencies?.recordingBlocker ? (
            <div className="mb-2 rounded-xl border border-rose-400/30 bg-rose-400/10 px-3 py-2 text-[10px] text-rose-100 leading-relaxed">
              {dependencies.recordingBlocker}
            </div>
          ) : null}

          <div className="flex items-center gap-2">
            <button
              className="record-btn group flex-1 h-[48px] rounded-xl flex items-center justify-center gap-2.5 text-white"
              onClick={() => void toggleRecording()}
              disabled={busy || ffmpegMissing}
            >
              <span className="rec-dot" />
              <span className="text-[12.5px] font-semibold tracking-tight">
                {recordingActive ? "Stop" : "Record"}
              </span>
              <span className="kbd !bg-white/15 !text-white !border-white/25 !ml-0.5 whitespace-nowrap">{accel(4)}</span>
            </button>

            <button
              className="tool-btn group h-[48px] w-[52px] rounded-xl flex flex-col items-center justify-center gap-0.5"
              onClick={() => setView("record")}
              disabled={recordingActive}
              title="Recording setup: source, sound, camera, quality"
            >
              <Icon name="sliders" size={17} strokeWidth={1.75} className="tool-icon" />
              <span className="tool-label !text-[9px]">Setup</span>
              <span className="tooltip">Choose screen / window / area, sound and camera</span>
            </button>

            <button
              className={`tool-btn group h-[48px] w-[52px] rounded-xl flex flex-col items-center justify-center gap-0.5 ${settings?.recordingWebcam ? "is-active" : ""}`}
              onClick={() => void toggleDevice("cam")}
              disabled={recordingActive}
              title="Webcam overlay"
            >
              <Icon name="camera" size={17} strokeWidth={1.75} className="tool-icon" />
              <span className="tool-label !text-[9px]">Cam</span>
              <span className="tooltip">Webcam overlay (bottom-right corner)</span>
            </button>

            <button
              className={`tool-btn group h-[48px] w-[52px] rounded-xl flex flex-col items-center justify-center gap-0.5 ${settings?.recordingAudio ? "is-active" : ""}`}
              onClick={() => void toggleDevice("mic")}
              disabled={recordingActive}
              title="Microphone"
            >
              <Icon name={settings?.recordingAudio ? "mic" : "micOff"} size={17} strokeWidth={1.75} className="tool-icon" />
              <span className="tool-label !text-[9px]">Mic</span>
              <span className="tooltip">Record the microphone</span>
            </button>
          </div>

          <div className="divider my-3.5" />

          {/* ────── TOOLS ────── */}
          <div className="flex items-center justify-between mb-2.5 px-1">
            <span className="section-label">Tools</span>
          </div>

          <div className="grid grid-cols-5 gap-1.5">
            <ToolButton compact icon="ocr" tooltip="OCR — extract text from an image" onClick={() => setView("ocr")} active={view === "ocr"} />
            <ToolButton compact icon="pdf" tooltip="PDF convert" onClick={() => setView("pdf")} active={view === "pdf"} />
            <ToolButton compact icon="cloud" tooltip="Cloud upload" onClick={() => setView("cloud")} active={view === "cloud"} />
            <button
              className={`tool-btn group h-10 rounded-lg flex items-center justify-center relative ${view === "ai" ? "is-active" : ""}`}
              onClick={() => setView("ai")}
            >
              <Icon name="sparkles" size={17} strokeWidth={1.75} className="tool-icon" />
              <span className="absolute top-0.5 right-0.5 w-1.5 h-1.5 rounded-full bg-violet-400 shadow-[0_0_6px_rgba(139,92,246,0.9)]" />
              <span className="tooltip">AI tools</span>
            </button>
            <ToolButton compact icon="plug" tooltip="Plugins / extensions" onClick={() => setView("plugins")} active={view === "plugins"} />
          </div>
        </div>

        {/* ══ STATUS BAR ══ */}
        <div className="flex items-center justify-between px-3.5 h-8 border-t border-white/5 bg-black/20 rounded-b-2xl">
          <div className="flex items-center gap-2 text-[10px] min-w-0">
            <span
              className={`status-dot ${status === "busy" ? "busy" : ""} ${status === "recording" ? "recording" : ""} ${status === "error" ? "error" : ""}`}
            />
            <span className="text-slate-300 font-medium truncate">{statusText}</span>
            <span className="text-slate-600">·</span>
            <span className="text-slate-400 font-mono tracking-tight truncate">
              {settings?.saveDir ?? "~/Pictures/SnapPro"}
            </span>
          </div>
          <div className="flex items-center gap-3 text-[10px] font-mono text-slate-400 flex-none">
            <span>{diskUsage}</span>
            <span className="text-slate-600">·</span>
            <span>v{dependencies?.appVersion ?? "0.1.0"}</span>
          </div>
        </div>

        <ResizeHandle />
      </div>

      <Panels />
    </div>
  );
}

function ResizeHandle() {
  const dragging = useRef(false);
  const start = useRef({ x: 0, y: 0, w: 0, h: 0 });

  useEffect(() => {
    const onMove = async (event: MouseEvent) => {
      if (!dragging.current) return;
      const width = Math.max(340, start.current.w + (event.clientX - start.current.x));
      const height = Math.max(420, start.current.h + (event.clientY - start.current.y));
      await api.setWindowSize(width, height, "main");
    };
    const onUp = () => {
      dragging.current = false;
      document.body.style.cursor = "";
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, []);

  return (
    <div
      className="absolute bottom-1 right-1 w-4 h-4 cursor-nwse-resize flex items-end justify-end p-1 opacity-30 hover:opacity-80 transition-opacity"
      onMouseDown={async (event) => {
        const win = nativeWindow();
        if (!win) return;
        const size = await win.innerSize();
        const scale = await win.scaleFactor();
        dragging.current = true;
        start.current = {
          x: event.clientX,
          y: event.clientY,
          w: size.width / scale,
          h: size.height / scale,
        };
      }}
    >
      <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="#94a3b8" strokeWidth="1.5" strokeLinecap="round">
        <path d="M9 9L5 9M9 5L9 9M5 5L5 9" />
      </svg>
    </div>
  );
}
