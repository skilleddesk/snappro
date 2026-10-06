import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Icon } from "./Icon";
import * as api from "../lib/api";
import { useStore } from "../lib/store";
import { buildRecordOptions, prettyAccelerator } from "../lib/recording";
import { EmptyState, PanelShell, Switch } from "./PanelUI";

type Source = "screen" | "window" | "custom";

function Card({ step, title, hint, children }: { step: number; title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="rounded-2xl border border-white/8 bg-white/[0.025] p-3 mb-2.5">
      <header className="flex items-center gap-2 mb-2.5">
        <span className="w-5 h-5 rounded-full bg-violet-500/25 text-violet-200 text-[10px] font-bold flex items-center justify-center">
          {step}
        </span>
        <div className="min-w-0">
          <div className="text-[11.5px] font-semibold text-slate-100">{title}</div>
          {hint ? <div className="text-[9.5px] text-slate-500 leading-snug">{hint}</div> : null}
        </div>
      </header>
      <div className="space-y-2">{children}</div>
    </section>
  );
}

function Choice<T extends string>({
  value,
  options,
  onChange,
  columns,
}: {
  value: T;
  options: { value: T; label: string; icon?: string; hint?: string }[];
  onChange: (value: T) => void;
  columns?: number;
}) {
  return (
    <div className="grid gap-1.5" style={{ gridTemplateColumns: `repeat(${columns ?? options.length}, minmax(0, 1fr))` }}>
      {options.map((option) => (
        <button
          key={option.value}
          title={option.hint}
          onClick={() => onChange(option.value)}
          className={`rounded-xl border px-2 py-2 flex flex-col items-center gap-1 text-[10px] font-medium transition-all ${
            value === option.value
              ? "border-violet-400/60 bg-violet-500/20 text-violet-50 shadow-[0_0_14px_-6px_rgba(139,92,246,0.8)]"
              : "border-white/10 text-slate-400 hover:border-white/25 hover:text-slate-200"
          }`}
        >
          {option.icon ? <Icon name={option.icon} size={16} /> : null}
          {option.label}
        </button>
      ))}
    </div>
  );
}

function ToggleRow({
  icon,
  title,
  hint,
  on,
  onChange,
  disabled,
  children,
}: {
  icon: string;
  title: string;
  hint?: string;
  on: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
  children?: ReactNode;
}) {
  return (
    <div className={`rounded-xl border p-2.5 transition-colors ${on ? "border-violet-400/40 bg-violet-500/[0.07]" : "border-white/8"} ${disabled ? "opacity-60" : ""}`}>
      <div className="flex items-center gap-2">
        <span className={`w-7 h-7 rounded-lg flex items-center justify-center ${on ? "bg-violet-500/30 text-violet-100" : "bg-white/5 text-slate-400"}`}>
          <Icon name={icon} size={14} />
        </span>
        <div className="flex-1 min-w-0">
          <div className="text-[11px] font-medium text-slate-200">{title}</div>
          {hint ? <div className="text-[9.5px] text-slate-500 leading-snug">{hint}</div> : null}
        </div>
        <Switch on={on} onChange={(value) => !disabled && onChange(value)} />
      </div>
      {on && children ? <div className="mt-2 space-y-2">{children}</div> : null}
    </div>
  );
}

const SELECT = "text-input !py-1.5 !text-[10.5px]";

/**
 * Recording setup: everything about a take in one organised place — what to
 * record (screen / window / area), the sound, the camera and the quality —
 * then one Start button. The choices are remembered.
 */
export function RecorderSetup() {
  const { settings, updateSettings, toast, dependencies, monitors, loadMonitors, loadDependencies } = useStore();
  const [devices, setDevices] = useState<api.Devices>({ cameras: [], microphones: [], loopback: [] });
  const [windows, setWindows] = useState<api.WindowInfo[]>([]);
  const [thumbs, setThumbs] = useState<Record<number, string>>({});
  const [picked, setPicked] = useState<api.PickedWindow | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const fetching = useRef(new Set<number>());

  const refresh = useCallback(async () => {
    setLoading(true);
    const [list, devs] = await Promise.all([
      api.listWindows().catch(() => []),
      api.listDevices().catch(() => ({ cameras: [], microphones: [], loopback: [] }) as api.Devices),
    ]);
    setWindows(list.filter((w) => w.width > 80 && w.height > 60).slice(0, 12));
    setDevices({ ...devs, loopback: devs.loopback ?? [] });
    setLoading(false);
  }, []);

  useEffect(() => {
    void loadMonitors();
    void loadDependencies();
    void refresh();
  }, [loadMonitors, loadDependencies, refresh]);

  // Areas and windows picked with the on-screen selector arrive as events.
  useEffect(() => {
    const unlisten: (() => void)[] = [];
    void api
      .on<api.RegionRect>(api.EVENTS.recordArea, (rect) => {
        void useStore.getState().updateSettings({ recordingMode: "custom", recordingRegion: rect });
        toast(`Area selected: ${rect.width} × ${rect.height}`, "success");
      })
      .then((fn) => unlisten.push(fn));
    void api
      .on<api.PickedWindow>(api.EVENTS.recordWindow, (win) => {
        setPicked(win);
        void useStore.getState().updateSettings({ recordingMode: "window" });
        toast(`Window selected: ${win.title}`, "success");
      })
      .then((fn) => unlisten.push(fn));
    return () => unlisten.forEach((fn) => fn());
  }, [toast]);

  // Window previews load one after another so xcap is never hammered.
  useEffect(() => {
    if (settings?.recordingMode !== "window") return;
    const next = windows.find((w) => !thumbs[w.id] && !fetching.current.has(w.id));
    if (!next) return;
    fetching.current.add(next.id);
    void api
      .windowThumbnail(next.id, 260)
      .then((url) => setThumbs((previous) => ({ ...previous, [next.id]: url })))
      .catch(() => setThumbs((previous) => ({ ...previous, [next.id]: "" })));
  }, [windows, thumbs, settings?.recordingMode]);

  const mode = (settings?.recordingMode as Source) || "screen";
  const region = settings?.recordingRegion ?? null;

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

  if (!settings) return null;
  const set = (patch: Partial<api.Settings>) => void updateSettings(patch);

  const chooseWindow = async (win: api.WindowInfo) => {
    try {
      const bounds = await api.windowBounds(win.id);
      setPicked({ ...bounds, id: win.id, title: win.title, appName: win.appName });
    } catch (error) {
      toast(api.errorMessage(error), "error");
    }
  };

  const startOverlay = async (kind: "recarea" | "recwindow") => {
    try {
      await api.startRegionSelector(kind, null);
    } catch (error) {
      toast(api.errorMessage(error), "error");
    }
  };

  // On Wayland the desktop asks which screen or window to share when the take
  // starts (one at a time), and the window list only shows XWayland windows.
  const desktopAsks = Boolean(dependencies?.wayland);
  const monitorIndex = settings.recordingMonitor ?? monitors.findIndex((m) => m.primary);
  const ffmpegMissing = dependencies !== null && !dependencies.ffmpeg;

  // What exactly will be recorded, in words.
  const sourceText =
    mode === "screen"
      ? `Screen: ${monitors[Math.max(0, monitorIndex)]?.name || "primary display"}`
      : mode === "window"
        ? picked
          ? `Window: ${picked.title}`
          : desktopAsks
            ? "Window: chosen when recording starts"
            : "Window: not chosen yet"
        : region
          ? `Area ${region.width}×${region.height} at ${region.x},${region.y}`
          : "Area: not chosen yet";
  const ready = mode === "screen" || (mode === "window" && (Boolean(picked) || desktopAsks)) || (mode === "custom" && Boolean(region));

  const start = async () => {
    setBusy(true);
    try {
      const overrides: Partial<api.RecordOptions> = { mode };
      if (mode === "window" && picked && !desktopAsks) {
        // Re-read the position: the window may have been moved since it was picked.
        const bounds = await api.windowBounds(picked.id).catch(() => picked);
        overrides.region = { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
        overrides.windowId = String(picked.id);
        overrides.windowTitle = picked.title;
      }
      if (mode === "custom") overrides.region = region;
      const options = buildRecordOptions(settings, overrides);
      await api.prepareRecording({
        options,
        seconds: settings.recordingCountdown ?? 0,
        maxMinutes: settings.recordingMaxMinutes ?? 0,
      });
    } catch (error) {
      toast(api.errorMessage(error), "error");
    } finally {
      setBusy(false);
    }
  };

  const loopbackHint =
    dependencies?.platform === "windows"
      ? "Windows: turn on “Stereo Mix” (Sound settings → Recording → right-click → Show disabled devices)."
      : dependencies?.platform === "macos"
        ? "macOS: install a loopback driver such as BlackHole, then choose it here."
        : "Linux: a PulseAudio / PipeWire “monitor” source is needed.";

  return (
    <PanelShell
      title="Record setup"
      subtitle={loading ? "Looking for screens, windows and devices…" : `${monitors.length} display(s) · ${windows.length} windows`}
      actions={
        <button className="win-ctrl" title="Refresh devices and windows" onClick={() => void refresh()}>
          <Icon name="refresh" size={14} strokeWidth={2} />
        </button>
      }
    >
      {ffmpegMissing ? (
        <div className="mb-2.5 rounded-xl border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-[10px] text-amber-100">
          ffmpeg is not installed. Open Settings → System check and press Install.
        </div>
      ) : null}
      {dependencies?.recordingBlocker ? (
        <div className="mb-2.5 rounded-xl border border-rose-400/30 bg-rose-400/10 px-3 py-2 text-[10px] text-rose-100">
          {dependencies.recordingBlocker}
        </div>
      ) : null}

      {/* 1 ── source ── */}
      <Card step={1} title="What to record" hint="A whole screen, one window, or any area you draw.">
        <Choice
          value={mode}
          onChange={(value) => set({ recordingMode: value })}
          options={[
            { value: "screen", label: "Screen", icon: "monitor" },
            { value: "window", label: "Window", icon: "window" },
            { value: "custom", label: "Area", icon: "region" },
          ]}
        />

        {mode === "screen" ? (
          <div className="space-y-1.5">
            {monitors.map((monitor, index) => (
              <button
                key={monitor.id}
                onClick={() => set({ recordingMonitor: index })}
                className={`w-full text-left rounded-xl border px-2.5 py-2 transition-all ${
                  monitorIndex === index ? "border-violet-400/60 bg-violet-400/10" : "border-white/8 hover:border-white/25"
                }`}
              >
                <div className="text-[11px] text-slate-100 truncate">
                  {monitor.name || `Display ${index + 1}`} {monitor.primary ? <span className="text-violet-300">· main</span> : null}
                </div>
                <div className="text-[9.5px] text-slate-500">
                  {monitor.width}×{monitor.height} · position {monitor.x},{monitor.y}
                </div>
              </button>
            ))}
            {desktopAsks ? (
              <div className="text-[10px] leading-relaxed text-slate-400 px-1">
                The first time, your desktop asks which screen to share: pick the same one there.
              </div>
            ) : null}
            {monitors.length > 1 && allBounds && !desktopAsks ? (
              <button
                onClick={() => set({ recordingMode: "custom", recordingRegion: allBounds })}
                className="w-full text-left rounded-xl border border-dashed border-white/15 px-2.5 py-2 text-[10.5px] text-slate-400 hover:text-slate-200 hover:border-white/30"
              >
                Record all displays together ({allBounds.width}×{allBounds.height})
              </button>
            ) : null}
          </div>
        ) : null}

        {mode === "window" && desktopAsks ? (
          <div className="text-[10px] leading-relaxed text-slate-400 px-1">
            Press Start: your desktop asks which window to share. Tick “Remember this selection” there and it will not ask again.
          </div>
        ) : mode === "window" ? (
          <>
            <div className="flex gap-1.5">
              <button className="ghost-btn flex-1 !text-[10.5px]" onClick={() => void startOverlay("recwindow")}>
                <Icon name="eyedropper" size={13} /> Click a window on screen
              </button>
            </div>
            {windows.length === 0 ? (
              <EmptyState icon="window" title="No windows found" hint="Open the app you want to record, then refresh." />
            ) : (
              <div className="grid grid-cols-2 gap-1.5">
                {windows.map((win) => (
                  <button
                    key={win.id}
                    onClick={() => void chooseWindow(win)}
                    className={`rounded-xl border overflow-hidden text-left transition-all ${
                      picked?.id === win.id ? "border-violet-400/70 shadow-[0_0_14px_-5px_rgba(139,92,246,0.9)]" : "border-white/8 hover:border-white/25"
                    }`}
                  >
                    <div className="h-[62px] bg-black/50 flex items-center justify-center overflow-hidden">
                      {thumbs[win.id] ? (
                        <img src={thumbs[win.id]} alt="" className="w-full h-full object-cover object-top" />
                      ) : (
                        <Icon name={thumbs[win.id] === "" ? "window" : "loading"} size={16} className={thumbs[win.id] === undefined ? "spin text-slate-600" : "text-slate-600"} />
                      )}
                    </div>
                    <div className="px-2 py-1.5">
                      <div className="text-[10px] text-slate-200 truncate">{win.title}</div>
                      <div className="text-[9px] text-slate-500 truncate">
                        {win.appName} · {win.width}×{win.height}
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </>
        ) : null}

        {mode === "custom" ? (
          <>
            <button className="primary-btn w-full !py-2 flex items-center justify-center gap-2" onClick={() => void startOverlay("recarea")}>
              <Icon name="region" size={14} /> {region ? "Choose a different area" : "Select the area on screen"}
            </button>
            {region ? (
              <div className="grid grid-cols-4 gap-1.5">
                {(["x", "y", "width", "height"] as const).map((key) => (
                  <label key={key} className="text-[9px] text-slate-500 uppercase">
                    {key === "width" ? "W" : key === "height" ? "H" : key}
                    <input
                      type="number"
                      className="text-input !py-1 !px-1.5 !text-[10.5px] mt-0.5"
                      value={region[key]}
                      onChange={(event) =>
                        set({ recordingRegion: { ...region, [key]: Number(event.target.value) || 0 } })
                      }
                    />
                  </label>
                ))}
              </div>
            ) : (
              <div className="text-[10px] text-slate-500">Nothing selected yet. Drag a rectangle, or click a window to take its exact area.</div>
            )}
            <div className="flex flex-wrap gap-1">
              {[
                ["1920×1080", 1920, 1080],
                ["1280×720", 1280, 720],
                ["854×480", 854, 480],
                ["1080×1080", 1080, 1080],
              ].map(([label, w, h]) => (
                <button
                  key={String(label)}
                  className="chip"
                  title="Use this size, placed at the top-left of the main display"
                  onClick={() => set({ recordingRegion: { x: region?.x ?? 0, y: region?.y ?? 0, width: Number(w), height: Number(h) } })}
                >
                  {label}
                </button>
              ))}
            </div>
          </>
        ) : null}
      </Card>

      {/* 2 ── sound ── */}
      <Card step={2} title="Sound" hint="Your voice, the computer’s sound, or both mixed together.">
        <ToggleRow icon="mic" title="Microphone" hint="Narration while you record" on={settings.recordingAudio} onChange={(value) => set({ recordingAudio: value })}>
          <select
            className={SELECT}
            value={settings.recordingAudioDevice ?? ""}
            onChange={(event) => set({ recordingAudioDevice: event.target.value || null })}
          >
            <option value="">Default ({devices.microphones[0] ?? "none found"})</option>
            {devices.microphones.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
          {devices.microphones.length === 0 ? <div className="text-[9.5px] text-amber-300">No microphone found — plug one in and refresh.</div> : null}
        </ToggleRow>
        <ToggleRow
          icon="headphones"
          title="Computer sound"
          hint="What you hear from the speakers"
          on={settings.recordingSystemAudio}
          onChange={(value) => set({ recordingSystemAudio: value })}
        >
          {devices.loopback.length > 0 ? (
            <select
              className={SELECT}
              value={settings.recordingSystemDevice ?? ""}
              onChange={(event) => set({ recordingSystemDevice: event.target.value || null })}
            >
              <option value="">Default ({devices.loopback[0]})</option>
              {devices.loopback.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          ) : (
            <div className="text-[9.5px] text-amber-300 leading-snug">No source for computer sound was found. {loopbackHint}</div>
          )}
        </ToggleRow>
      </Card>

      {/* 3 ── camera ── */}
      <Card step={3} title="Webcam" hint="Your face in a corner of the video.">
        <ToggleRow icon="camera" title="Show my camera" on={settings.recordingWebcam} onChange={(value) => set({ recordingWebcam: value })}>
          <select
            className={SELECT}
            value={settings.recordingCameraDevice ?? ""}
            onChange={(event) => set({ recordingCameraDevice: event.target.value || null })}
          >
            <option value="">Default ({devices.cameras[0] ?? "none found"})</option>
            {devices.cameras.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
          {devices.cameras.length === 0 ? <div className="text-[9.5px] text-amber-300">No camera found.</div> : null}
          <div>
            <div className="text-[9.5px] text-slate-500 mb-1">Corner</div>
            <div className="grid grid-cols-4 gap-1">
              {(
                [
                  ["tl", "↖ Top left"],
                  ["tr", "↗ Top right"],
                  ["bl", "↙ Bottom left"],
                  ["br", "↘ Bottom right"],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  title={label}
                  onClick={() => set({ webcamPosition: value })}
                  className={`rounded-lg border py-1 text-[11px] ${settings.webcamPosition === value ? "border-violet-400/60 bg-violet-500/20 text-violet-50" : "border-white/10 text-slate-400"}`}
                >
                  {label.split(" ")[0]}
                </button>
              ))}
            </div>
          </div>
          <div>
            <div className="text-[9.5px] text-slate-500 mb-1">Size</div>
            <Choice
              value={String(settings.webcamWidth || 320)}
              onChange={(value) => set({ webcamWidth: Number(value) })}
              options={[
                { value: "200", label: "Small" },
                { value: "320", label: "Medium" },
                { value: "480", label: "Large" },
              ]}
            />
          </div>
        </ToggleRow>
      </Card>

      {/* 4 ── video ── */}
      <Card step={4} title="Video">
        <div>
          <div className="text-[9.5px] text-slate-500 mb-1">Format</div>
          <Choice
            value={settings.recordingFormat || "mp4"}
            onChange={(value) => set({ recordingFormat: value })}
            options={[
              { value: "mp4", label: "MP4", hint: "Plays everywhere" },
              { value: "mkv", label: "MKV", hint: "Safest if the computer may crash" },
              { value: "gif", label: "GIF", hint: "Short looping clip, 15 fps maximum" },
            ]}
          />
        </div>
        <div>
          <div className="text-[9.5px] text-slate-500 mb-1">Quality</div>
          <Choice
            value={settings.recordingQuality || "balanced"}
            onChange={(value) => set({ recordingQuality: value })}
            options={[
              { value: "small", label: "Small file" },
              { value: "balanced", label: "Balanced" },
              { value: "high", label: "Best" },
            ]}
          />
        </div>
        <div>
          <div className="text-[9.5px] text-slate-500 mb-1">Smoothness</div>
          <Choice
            value={String(settings.recordingFps || 30)}
            onChange={(value) => set({ recordingFps: Number(value) })}
            options={[
              { value: "15", label: "15 fps" },
              { value: "24", label: "24 fps" },
              { value: "30", label: "30 fps" },
              { value: "60", label: "60 fps" },
            ]}
          />
        </div>
        <ToggleRow icon="cursor" title="Show the mouse pointer" on={settings.drawMouse} onChange={(value) => set({ drawMouse: value })} />
      </Card>

      {/* 5 ── start ── */}
      <Card step={5} title="Start">
        <div className="grid grid-cols-2 gap-2">
          <label className="text-[9.5px] text-slate-500">
            Countdown
            <select className={`${SELECT} mt-1`} value={settings.recordingCountdown ?? 3} onChange={(event) => set({ recordingCountdown: Number(event.target.value) })}>
              <option value={0}>Start at once</option>
              <option value={3}>3 seconds</option>
              <option value={5}>5 seconds</option>
              <option value={10}>10 seconds</option>
            </select>
          </label>
          <label className="text-[9.5px] text-slate-500">
            Stop automatically
            <select className={`${SELECT} mt-1`} value={settings.recordingMaxMinutes ?? 0} onChange={(event) => set({ recordingMaxMinutes: Number(event.target.value) })}>
              <option value={0}>Never</option>
              <option value={1}>After 1 minute</option>
              <option value={5}>After 5 minutes</option>
              <option value={15}>After 15 minutes</option>
              <option value={30}>After 30 minutes</option>
              <option value={60}>After 1 hour</option>
            </select>
          </label>
        </div>

        <div className="rounded-xl bg-black/30 border border-white/8 p-2.5 text-[10px] leading-relaxed text-slate-300 space-y-0.5">
          <div className="flex items-center gap-1.5">
            <Icon name="monitor" size={11} className="text-violet-300" />
            <span className="truncate">{sourceText}</span>
          </div>
          <div className="flex items-center gap-1.5 text-slate-400">
            <Icon name="mic" size={11} className={settings.recordingAudio ? "text-emerald-300" : "text-slate-600"} />
            Mic {settings.recordingAudio ? "on" : "off"}
            <span className="text-slate-600">·</span>
            <Icon name="headphones" size={11} className={settings.recordingSystemAudio ? "text-emerald-300" : "text-slate-600"} />
            Computer sound {settings.recordingSystemAudio ? "on" : "off"}
            <span className="text-slate-600">·</span>
            <Icon name="camera" size={11} className={settings.recordingWebcam ? "text-emerald-300" : "text-slate-600"} />
            Camera {settings.recordingWebcam ? "on" : "off"}
          </div>
          <div className="text-slate-500">
            {(settings.recordingFormat || "mp4").toUpperCase()} · {settings.recordingFps || 30} fps · {settings.recordingQuality || "balanced"}
            {settings.recordingMaxMinutes ? ` · stops after ${settings.recordingMaxMinutes} min` : ""}
          </div>
        </div>

        <button
          className="record-btn w-full h-[46px] rounded-xl flex items-center justify-center gap-2.5 text-white disabled:opacity-50"
          disabled={busy || !ready || ffmpegMissing}
          onClick={() => void start()}
        >
          <span className="rec-dot" />
          <span className="text-[12.5px] font-semibold">
            {busy ? "Starting…" : settings.recordingCountdown ? `Start recording in ${settings.recordingCountdown}s` : "Start recording"}
          </span>
        </button>
        {!ready ? <div className="text-[9.5px] text-amber-300 text-center">Choose {mode === "window" ? "a window" : "an area"} first.</div> : null}
        <p className="text-[9.5px] leading-relaxed text-slate-500">
          While recording, use the small bar at the top of the screen to pause or stop. The shortcut {prettyAccelerator(settings.shortcuts[4] ?? "")} also stops it.
        </p>
      </Card>
    </PanelShell>
  );
}
