import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "./Icon";
import * as api from "../lib/api";
import { useStore } from "../lib/store";
import { buildRecordOptions, fixedSize } from "../lib/recording";

type Source = "screen" | "window" | "custom";

const CHOOSER_SIZE: [number, number] = [660, 150];
const BAR_SIZE: [number, number] = [600, 60];

const FIXED_PRESETS: [number, number][] = [
  [1920, 1080],
  [1280, 720],
  [854, 480],
  [1080, 1080],
  [1080, 1920],
];

/**
 * The recorder bar. One small window, three states:
 *
 *  - choose:     what to record (whole screen / a window / an area / a fixed frame),
 *                the sound and camera switches, and Start
 *  - countdown:  3… 2… 1…
 *  - recording:  timer, pause / stop, and the same sound / camera switches
 *                (they can be flipped while recording)
 *
 * Windows and areas are picked on the screen itself, like in FastStone Capture.
 */
export function RecorderWindow() {
  const [status, setStatus] = useState<api.RecordingStatus | null>(null);
  const [countdown, setCountdown] = useState<{ left: number; request: api.RecordingRequest } | null>(null);
  const [active, setActive] = useState<api.RecordOptions | null>(null);
  const [picked, setPicked] = useState<api.PickedWindow | null>(null);
  const [devices, setDevices] = useState<api.Devices>({ cameras: [], microphones: [], loopback: [] });
  const [monitors, setMonitors] = useState<api.MonitorInfo[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const { toast, loadLibrary, setStatus: setAppStatus, settings, updateSettings } = useStore();
  const maxMinutes = useRef(0);
  const countingRef = useRef(false);
  const stopping = useRef(false);
  countingRef.current = countdown !== null;

  const recording = Boolean(status?.recording || status?.paused);
  const paused = Boolean(status?.paused);
  const phase: "choose" | "countdown" | "recording" = countdown ? "countdown" : recording ? "recording" : "choose";
  const mode = ((settings?.recordingMode as Source) || "screen") as Source;
  const region = settings?.recordingRegion ?? null;

  // ── window size follows the state ────────────────────────────────────────
  useEffect(() => {
    const [w, h] = phase === "choose" ? CHOOSER_SIZE : BAR_SIZE;
    void api.setWindowSize(w, h, "recorder");
  }, [phase]);

  // ── data ─────────────────────────────────────────────────────────────────
  const refreshDevices = useCallback(() => {
    void api.listDevices().then((d) => setDevices({ ...d, loopback: d.loopback ?? [] })).catch(() => undefined);
    void api.getMonitors().then(setMonitors).catch(() => undefined);
  }, []);

  useEffect(() => {
    void useStore.getState().loadSettings();
    refreshDevices();
    const unlisten: (() => void)[] = [];
    // Stay in step with the setup panel in the main window.
    void api
      .on(api.EVENTS.settingsChanged, () => void useStore.getState().loadSettings())
      .then((fn) => unlisten.push(fn));
    // Areas and windows picked on the screen arrive here.
    void api
      .on<api.RegionRect>(api.EVENTS.recordArea, (rect) => {
        void useStore.getState().updateSettings({ recordingMode: "custom", recordingRegion: rect });
        setPicked(null);
      })
      .then((fn) => unlisten.push(fn));
    void api
      .on<api.PickedWindow>(api.EVENTS.recordWindow, (win) => {
        setPicked(win);
        void useStore.getState().updateSettings({ recordingMode: "window" });
      })
      .then((fn) => unlisten.push(fn));
    return () => unlisten.forEach((fn) => fn());
  }, [refreshDevices]);

  // ── starting ─────────────────────────────────────────────────────────────
  const doStart = useCallback(
    async (request: api.RecordingRequest) => {
      try {
        setAppStatus("busy", "Starting recording…");
        maxMinutes.current = request.maxMinutes;
        setActive(request.options);
        const next = await api.startRecording(request.options);
        setStatus(next);
        setAppStatus("recording", "Recording");
      } catch (error) {
        setActive(null);
        toast(api.errorMessage(error), "error");
        setAppStatus("error");
      }
    },
    [setAppStatus, toast],
  );

  const begin = useCallback(
    (request: api.RecordingRequest) => {
      if (request.seconds > 0) setCountdown({ left: request.seconds, request });
      else void doStart(request);
    },
    [doStart],
  );

  // Poll the recorder; pick up requests parked by the setup panel; enforce the time limit.
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const next = await api.recordingStatus();
        if (!alive) return;
        setStatus(next);
        const running = next.recording || next.paused;
        if (!running && !countingRef.current) {
          const request = await api.takePendingRecording();
          if (request && alive) begin(request);
        }
        if (running && !next.paused && maxMinutes.current > 0 && next.elapsedMs >= maxMinutes.current * 60_000 && !stopping.current) {
          stopping.current = true;
          await api.stopRecording();
          toast("Recording stopped: the time limit was reached", "success");
          await loadLibrary();
          stopping.current = false;
        }
      } catch {
        /* the backend is not ready yet */
      }
    };
    void tick();
    const timer = window.setInterval(tick, 500);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [begin, loadLibrary, toast]);

  useEffect(() => {
    if (!countdown) return;
    const timer = window.setTimeout(() => {
      if (countdown.left <= 1) {
        const request = countdown.request;
        setCountdown(null);
        void doStart(request);
      } else {
        setCountdown({ ...countdown, left: countdown.left - 1 });
      }
    }, 1000);
    return () => window.clearTimeout(timer);
  }, [countdown, doStart]);

  // ── choosing what to record ──────────────────────────────────────────────
  const allBounds = useMemo(() => {
    if (monitors.length === 0) return null;
    const x = Math.min(...monitors.map((m) => m.x));
    const y = Math.min(...monitors.map((m) => m.y));
    return {
      x,
      y,
      width: Math.max(...monitors.map((m) => m.x + m.width)) - x,
      height: Math.max(...monitors.map((m) => m.y + m.height)) - y,
    };
  }, [monitors]);

  const selectOnScreen = (kind: "recwindow" | "recarea" | "recfixed") => {
    // The selector hides this bar while it is open and brings it back afterwards.
    void api.startRegionSelector(kind).catch((error) => toast(api.errorMessage(error), "error"));
  };

  const chooseSource = (next: Source) => {
    if (next === "window") {
      if (!picked) selectOnScreen("recwindow");
      else void updateSettings({ recordingMode: "window" });
    } else if (next === "custom") {
      if (!region) selectOnScreen("recarea");
      else void updateSettings({ recordingMode: "custom" });
    } else {
      void updateSettings({ recordingMode: "screen" });
    }
  };

  const monitorIndex = settings?.recordingMonitor ?? Math.max(0, monitors.findIndex((m) => m.primary));
  const wholeDesktop =
    mode === "custom" &&
    Boolean(region && allBounds && region.x === allBounds.x && region.width === allBounds.width && region.height === allBounds.height && monitors.length > 1);

  const summary =
    mode === "screen"
      ? `Screen ${monitorIndex + 1}${monitors[monitorIndex] ? ` · ${monitors[monitorIndex].width}×${monitors[monitorIndex].height}` : ""}`
      : mode === "window"
        ? picked
          ? `Window: ${picked.title}`
          : "No window chosen yet"
        : region
          ? wholeDesktop
            ? `All screens · ${region.width}×${region.height}`
            : `Area ${region.width}×${region.height}`
          : "No area chosen yet";

  const start = async () => {
    if (!settings) return;
    // Nothing chosen yet: send the user straight to the on-screen picker.
    if (mode === "window" && !picked) return selectOnScreen("recwindow");
    if (mode === "custom" && !region) return selectOnScreen("recarea");
    setBusy("Starting…");
    try {
      const overrides: Partial<api.RecordOptions> = { mode };
      if (mode === "window" && picked) {
        const bounds = await api.windowBounds(picked.id).catch(() => picked);
        overrides.region = { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
        overrides.windowId = String(picked.id);
        overrides.windowTitle = picked.title;
      }
      if (mode === "custom") overrides.region = region;
      await api.prepareRecording({
        options: buildRecordOptions(settings, overrides),
        seconds: settings.recordingCountdown ?? 0,
        maxMinutes: settings.recordingMaxMinutes ?? 0,
      });
    } catch (error) {
      toast(api.errorMessage(error), "error");
    } finally {
      setBusy(null);
    }
  };

  // ── sound / camera switches (also while recording) ───────────────────────
  type Kind = "mic" | "system" | "cam";
  const isOn = (kind: Kind) => {
    const source = recording && active ? active : null;
    if (kind === "mic") return source ? Boolean(source.audio) : Boolean(settings?.recordingAudio);
    if (kind === "system") return source ? Boolean(source.systemAudio) : Boolean(settings?.recordingSystemAudio);
    return source ? Boolean(source.webcam) : Boolean(settings?.recordingWebcam);
  };

  const toggle = async (kind: Kind) => {
    if (!settings) return;
    const turningOn = !isOn(kind);
    if (turningOn) {
      const list = kind === "mic" ? devices.microphones : kind === "cam" ? devices.cameras : devices.loopback;
      if (list.length === 0) {
        toast(
          kind === "mic"
            ? "No microphone was found"
            : kind === "cam"
              ? "No camera was found"
              : "No computer-sound source found (Windows: enable Stereo Mix)",
          "error",
        );
        refreshDevices();
        return;
      }
    }
    const patch =
      kind === "mic"
        ? { recordingAudio: turningOn }
        : kind === "system"
          ? { recordingSystemAudio: turningOn }
          : { recordingWebcam: turningOn };
    await updateSettings(patch);
    if (recording) {
      setBusy(turningOn ? "Switching on…" : "Switching off…");
      try {
        const change = kind === "mic" ? { audio: turningOn } : kind === "system" ? { systemAudio: turningOn } : { webcam: turningOn };
        await api.reconfigureRecording(change);
        setActive((previous) =>
          previous
            ? {
                ...previous,
                audio: kind === "mic" ? turningOn : previous.audio,
                systemAudio: kind === "system" ? turningOn : previous.systemAudio,
                webcam: kind === "cam" ? turningOn : previous.webcam,
              }
            : previous,
        );
      } catch (error) {
        toast(api.errorMessage(error), "error");
      } finally {
        setBusy(null);
      }
    }
  };

  const run = async (task: () => Promise<unknown>, label: string) => {
    try {
      setAppStatus("busy", label);
      setBusy(label);
      await task();
      const next = await api.recordingStatus();
      setStatus(next);
      await loadLibrary();
      setAppStatus(next.recording ? "recording" : "ready");
    } catch (error) {
      toast(api.errorMessage(error), "error");
    } finally {
      setBusy(null);
    }
  };

  const elapsed = status?.elapsedMs ?? 0;
  const limit = maxMinutes.current;
  const remaining = limit > 0 ? Math.max(0, limit * 60_000 - elapsed) : null;

  const toggleButton = (kind: Kind, icon: string, offIcon: string, label: string) => {
    const on = isOn(kind);
    return (
      <button
        key={kind}
        onClick={() => void toggle(kind)}
        title={`${label} is ${on ? "ON — click to turn off" : "OFF — click to turn on"}${recording ? " (a very short cut is made in the video)" : ""}`}
        className={`h-9 px-2.5 rounded-xl border flex items-center gap-1.5 text-[11px] font-semibold transition-all ${
          on
            ? "border-emerald-400/60 bg-emerald-500/20 text-emerald-100"
            : "border-white/20 bg-white/[0.06] text-slate-200 hover:border-white/40"
        }`}
      >
        <Icon name={on ? icon : offIcon} size={15} />
        {label}
        <span className={`w-1.5 h-1.5 rounded-full ${on ? "bg-emerald-300" : "bg-slate-500"}`} />
      </button>
    );
  };

  const sourceButton = (value: Source, icon: string, label: string, onClick: () => void, hint: string) => {
    const selected = mode === value;
    return (
      <button
        key={label}
        onClick={onClick}
        title={hint}
        className={`h-11 flex-1 min-w-0 rounded-xl border flex items-center justify-center gap-2 text-[12px] font-semibold transition-all ${
          selected
            ? "border-violet-400/70 bg-violet-500/25 text-white shadow-[0_0_16px_-6px_rgba(139,92,246,0.9)]"
            : "border-white/15 bg-white/[0.05] text-slate-200 hover:border-white/35"
        }`}
      >
        <Icon name={icon} size={16} />
        {label}
      </button>
    );
  };

  return (
    <div className="h-screen w-screen p-1">
      <div
        className="solid-panel glass-panel drag-handle h-full rounded-2xl px-2.5 py-2 flex flex-col justify-center gap-2 shadow-2xl cursor-move"
        data-tauri-drag-region
      >
        {phase === "countdown" && countdown ? (
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-gradient-to-br from-red-500 to-red-700 flex items-center justify-center text-white text-[20px] font-bold tabular-nums shadow-lg shadow-red-900/50">
              {countdown.left}
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-[13px] font-semibold text-white">Recording starts in {countdown.left}…</div>
              <div className="text-[10.5px] text-slate-300 truncate">Get your screen ready</div>
            </div>
            {toggleButton("mic", "mic", "micOff", "Mic")}
            {toggleButton("cam", "camera", "camera", "Cam")}
            <button
              className="ghost-btn !py-2 !px-3"
              onClick={() => {
                setCountdown(null);
              }}
            >
              Cancel
            </button>
          </div>
        ) : null}

        {phase === "recording" ? (
          <div className="flex items-center gap-2">
            <span
              className={`w-3 h-3 rounded-full ${paused ? "bg-amber-400" : "bg-red-500 animate-pulse shadow-[0_0_10px_rgba(239,68,68,0.9)]"}`}
            />
            <span className="text-[11px] font-bold tracking-wider text-white select-none">{paused ? "PAUSED" : "REC"}</span>
            <span className="font-mono text-[15px] text-white tabular-nums">
              {api.formatDuration(elapsed)}
              {remaining !== null ? <span className="text-[10px] text-slate-400"> /{api.formatDuration(remaining)}</span> : null}
            </span>
            <span className="text-[10.5px] text-slate-300 truncate max-w-[110px]" title={status?.source ?? ""}>
              {status?.source ?? "Screen"}
            </span>
            <div className="flex-1" />
            {toggleButton("mic", "mic", "micOff", "Mic")}
            {toggleButton("system", "headphones", "headphones", "Sound")}
            {toggleButton("cam", "camera", "camera", "Cam")}
            <button
              className="h-9 w-9 rounded-xl border border-white/20 bg-white/[0.06] hover:border-white/40 flex items-center justify-center text-white"
              title={paused ? "Resume" : "Pause"}
              onClick={() => void run(() => (paused ? api.resumeRecording() : api.pauseRecording()), paused ? "Resuming…" : "Pausing…")}
            >
              <Icon name={paused ? "play" : "pause"} size={15} strokeWidth={2} />
            </button>
            <button
              className="h-9 px-3 rounded-xl flex items-center gap-1.5 text-[12px] font-semibold text-white bg-gradient-to-br from-red-500 to-red-700 hover:from-red-400 hover:to-red-600 shadow-lg shadow-red-900/40"
              title="Stop and save"
              onClick={() =>
                void run(async () => {
                  const result = await api.stopRecording();
                  toast(`Saved: ${result.output?.split(/[\\/]/).pop() ?? "recording"}`, "success");
                }, "Finishing…")
              }
            >
              <Icon name="stop" size={12} stroke="#fff" strokeWidth={2} /> Stop
            </button>
          </div>
        ) : null}

        {phase === "choose" ? (
          <>
            <div className="flex items-center gap-1.5">
              <span className="brand-logo w-6 h-6 rounded-lg flex items-center justify-center shrink-0">
                <Icon name="record" size={12} stroke="#fff" strokeWidth={2.2} />
              </span>
              <span className="text-[12px] font-semibold text-white">Screen recorder</span>
              <span className="text-[10.5px] text-slate-300 truncate flex-1 text-right pr-1" title={summary}>
                {summary}
              </span>
              <button
                className="win-ctrl !w-8 !h-8 border border-white/15"
                title="All recording options (quality, countdown, camera corner…)"
                onClick={() => {
                  void api.emitEvent(api.EVENTS.navRecord);
                  void api.focusMainWindow();
                }}
              >
                <Icon name="sliders" size={15} />
              </button>
              <button className="win-ctrl !w-8 !h-8 border border-white/15" title="Open capture folder" onClick={() => void api.openFolder(settings?.saveDir ?? "")}>
                <Icon name="folder" size={15} />
              </button>
              <button className="win-ctrl close !w-8 !h-8 border border-white/15" title="Close" onClick={() => void api.closeWindow("recorder")}>
                <Icon name="close" size={15} strokeWidth={2} />
              </button>
            </div>

            <div className="flex items-center gap-1.5">
              {sourceButton("screen", "monitor", "Full screen", () => chooseSource("screen"), "Record a whole display")}
              {sourceButton("window", "window", "Window", () => (picked && mode === "window" ? selectOnScreen("recwindow") : chooseSource("window")), "Click a window on the screen to record just that window")}
              {sourceButton("custom", "region", "Area", () => (region && mode === "custom" && !wholeDesktop ? selectOnScreen("recarea") : chooseSource("custom")), "Drag a rectangle on the screen and record only that")}
              <button
                onClick={() => selectOnScreen("recfixed")}
                title="A frame of a fixed size: move it, click to place it"
                className="h-11 flex-1 min-w-0 rounded-xl border border-white/15 bg-white/[0.05] hover:border-white/35 text-slate-200 flex items-center justify-center gap-2 text-[12px] font-semibold"
              >
                <Icon name="fixed" size={16} />
                Fixed {fixedSize(settings).width}×{fixedSize(settings).height}
              </button>
              <select
                className="text-input !w-[34px] !px-1 !py-2 h-11 text-center"
                title="Size of the fixed frame"
                value=""
                onChange={(event) => {
                  const [w, h] = event.target.value.split("x").map(Number);
                  if (w && h) void updateSettings({ fixedWidth: w, fixedHeight: h });
                }}
              >
                <option value="" disabled>
                  ▾
                </option>
                {FIXED_PRESETS.map(([w, h]) => (
                  <option key={`${w}x${h}`} value={`${w}x${h}`}>
                    {w} × {h}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex items-center gap-1.5">
              {mode === "screen" && monitors.length > 1 ? (
                <div className="flex items-center gap-1">
                  {monitors.map((monitor, index) => (
                    <button
                      key={monitor.id}
                      onClick={() => void updateSettings({ recordingMode: "screen", recordingMonitor: index })}
                      title={`${monitor.name} · ${monitor.width}×${monitor.height}`}
                      className={`chip !text-[11px] !px-2 !py-1.5 ${monitorIndex === index ? "is-active" : ""}`}
                    >
                      Screen {index + 1}
                    </button>
                  ))}
                  <button
                    className="chip !text-[11px] !px-2 !py-1.5"
                    title="Record both screens as one picture"
                    onClick={() => allBounds && void updateSettings({ recordingMode: "custom", recordingRegion: allBounds })}
                  >
                    Both
                  </button>
                </div>
              ) : mode === "window" && picked ? (
                <button className="chip !text-[11px] !px-2 !py-1.5" onClick={() => selectOnScreen("recwindow")}>
                  Pick another window
                </button>
              ) : mode === "custom" && region ? (
                <button className="chip !text-[11px] !px-2 !py-1.5" onClick={() => selectOnScreen("recarea")}>
                  Select again
                </button>
              ) : null}
              <div className="flex-1" />
              {toggleButton("mic", "mic", "micOff", "Mic")}
              {toggleButton("system", "headphones", "headphones", "Sound")}
              {toggleButton("cam", "camera", "camera", "Cam")}
              <button
                className="record-btn h-9 px-4 rounded-xl flex items-center gap-2 text-white text-[12.5px] font-semibold disabled:opacity-60"
                onClick={() => void start()}
                disabled={Boolean(busy)}
              >
                <span className="rec-dot" />
                {busy ?? (settings?.recordingCountdown ? `Record · ${settings.recordingCountdown}s` : "Record")}
              </button>
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
