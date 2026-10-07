import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "./Icon";
import * as api from "../lib/api";
import { useStore } from "../lib/store";
import { fixedSize } from "../lib/recording";

type Point = [number, number];
type Mode = "region" | "scrolling" | "freehand" | "fixed" | "pick" | "ocr" | "recarea" | "recwindow" | "recfixed";
type LocalRect = { x: number; y: number; w: number; h: number };

const LOUPE_CELLS = 15;
const LOUPE_ZOOM = 9;

const HINTS: Record<Mode, string> = {
  region: "Drag to select · click a window to snap to it · Esc to cancel",
  scrolling: "Select the part of the page that scrolls · Esc stops the capture early",
  freehand: "Draw around the shape you want · release to capture",
  fixed: "Move the frame, then click to capture",
  pick: "Click a pixel to copy its colour · Shift+click copies RGB · arrows nudge by 1px",
  ocr: "Select the text you want to copy · Esc to cancel",
  recfixed: "Move the frame to where you want to record, then click · Esc to cancel",
  recarea: "Drag the area to record (or click a window) · Esc to cancel",
  recwindow: "Click the window you want to record · Esc to cancel",
};

/**
 * Full-screen overlay over a frozen snapshot of the desktop: region, window
 * snapping, freehand, fixed-size frame, scrolling area, OCR area and the
 * colour picker all share it.
 */
export function RegionOverlay() {
  const [info, setInfo] = useState<api.SelectorInfo | null>(null);
  const [backdrop, setBackdrop] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>("region");
  const [windows, setWindows] = useState<api.WindowInfo[]>([]);
  const [pointer, setPointer] = useState<Point>([0, 0]);
  const [rect, setRect] = useState<LocalRect | null>(null);
  const [points, setPoints] = useState<Point[]>([]);
  const [drawing, setDrawing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [capturing, setCapturing] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [nudge, setNudge] = useState<Point>([0, 0]);
  const start = useRef<Point>([0, 0]);
  const pixels = useRef<HTMLCanvasElement | null>(null);
  const loupe = useRef<HTMLCanvasElement | null>(null);
  const settings = useStore((s) => s.settings);
  const { toast, pushCapture, loadLibrary, setStatus } = useStore();

  const scale = info?.scale && info.scale > 0 ? info.scale : 1;
  const [screens, setScreens] = useState<api.MonitorInfo[]>([]);
  useEffect(() => {
    void api.getMonitors().then(setScreens).catch(() => setScreens([]));
  }, []);
  /** Reopen the selector on another display (or on all of them). */
  const switchScope = (index: number | null) => {
    void api.startRegionSelector(mode, index, index === null);
  };
  const onAllScreens = Boolean(info && screens.length > 1 && info.width > Math.max(...screens.map((s) => s.width)));

  // ── session loading ──────────────────────────────────────────────────────
  const load = useCallback(async () => {
    try {
      const session = await api.regionBackdropInfo();
      const data = await api.readImageData(session.path);
      // Keep a full-resolution copy to read exact pixels for the loupe / picker.
      const image = new Image();
      image.onload = () => {
        const canvas = document.createElement("canvas");
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        canvas.getContext("2d", { willReadFrequently: true })?.drawImage(image, 0, 0);
        pixels.current = canvas;
      };
      image.src = data;

      const requested = (session.mode || "region") as Mode;
      setMode(requested);
      setRect(null);
      setPoints([]);
      setCapturing(false);
      setProgress(null);
      setBusy(false);
      setNudge([0, 0]);
      setBackdrop(data);
      setInfo(session);

      void useStore.getState().loadSettings();
      if (requested === "region" || requested === "ocr" || requested === "recarea" || requested === "recwindow") {
        void api.listWindows().then(setWindows).catch(() => setWindows([]));
      } else {
        setWindows([]);
      }
    } catch {
      /* no session yet: the next "region://backdrop" event brings one */
    }
  }, []);

  useEffect(() => {
    void load();
    let unlisten: (() => void) | undefined;
    // A new session is announced with an event; this also covers the overlay
    // being reused for a second capture without remounting.
    void api.on(api.EVENTS.regionBackdrop, () => void load()).then((fn) => (unlisten = fn));
    return () => unlisten?.();
  }, [load]);

  const cancel = useCallback(() => {
    setRect(null);
    setPoints([]);
    setDrawing(false);
    void api.cancelRegionSelector();
  }, []);

  // ── helpers ──────────────────────────────────────────────────────────────
  const toGlobal = (lx: number, ly: number): Point => {
    if (!info) return [Math.round(lx), Math.round(ly)];
    // `info.x/y` are already physical pixels; only the local offset is scaled.
    return [Math.round(info.x + lx * scale), Math.round(info.y + ly * scale)];
  };
  const toPhysical = (value: number) => Math.max(1, Math.round(value * scale));
  const toLocalRect = (x: number, y: number, w: number, h: number): LocalRect => ({
    x: (x - (info?.x ?? 0)) / scale,
    y: (y - (info?.y ?? 0)) / scale,
    w: w / scale,
    h: h / scale,
  });

  // Remembered while the button is held, so a click (no drag) still knows which window it was on.
  const hoverRef = useRef<api.WindowInfo | null>(null);
  const hoveredWindow = useMemo(() => {
    if (!info || (mode !== "region" && mode !== "ocr" && mode !== "recarea" && mode !== "recwindow") || drawing) return null;
    const [gx, gy] = toGlobal(pointer[0], pointer[1]);
    return (
      windows.find(
        (w) => w.width > 40 && w.height > 40 && gx >= w.x && gy >= w.y && gx < w.x + w.width && gy < w.y + w.height,
      ) ?? null
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [windows, pointer, drawing, mode, info]);
  if (!drawing) hoverRef.current = hoveredWindow;

  const fixedBox = useMemo((): LocalRect | null => {
    if (mode !== "fixed" && mode !== "recfixed") return null;
    const size = fixedSize(settings);
    const w = size.width / scale;
    const h = size.height / scale;
    return { x: pointer[0] - w / 2, y: pointer[1] - h / 2, w, h };
  }, [mode, pointer, scale, settings]);

  /** Colour under the pointer (physical pixel, plus nudge) for the picker. */
  const pixelAt = (lx: number, ly: number) => {
    const canvas = pixels.current;
    if (!canvas || !info) return null;
    const px = Math.min(canvas.width - 1, Math.max(0, Math.round(lx * scale) + nudge[0]));
    const py = Math.min(canvas.height - 1, Math.max(0, Math.round(ly * scale) + nudge[1]));
    const data = canvas.getContext("2d")?.getImageData(px, py, 1, 1).data;
    if (!data) return null;
    const hex = `#${[data[0], data[1], data[2]].map((v) => v.toString(16).padStart(2, "0")).join("").toUpperCase()}`;
    return { r: data[0], g: data[1], b: data[2], hex, px, py };
  };

  // Paint the magnifier whenever the pointer moves.
  useEffect(() => {
    const target = loupe.current;
    const source = pixels.current;
    if (!target || !source || !info || capturing) return;
    const ctx = target.getContext("2d");
    if (!ctx) return;
    const size = LOUPE_CELLS * LOUPE_ZOOM;
    target.width = size;
    target.height = size;
    ctx.imageSmoothingEnabled = false;
    const cx = Math.round(pointer[0] * scale) + nudge[0];
    const cy = Math.round(pointer[1] * scale) + nudge[1];
    const half = Math.floor(LOUPE_CELLS / 2);
    ctx.fillStyle = "#0b0c14";
    ctx.fillRect(0, 0, size, size);
    ctx.drawImage(source, cx - half, cy - half, LOUPE_CELLS, LOUPE_CELLS, 0, 0, size, size);
    ctx.strokeStyle = "rgba(255,255,255,0.9)";
    ctx.lineWidth = 2;
    ctx.strokeRect(half * LOUPE_ZOOM, half * LOUPE_ZOOM, LOUPE_ZOOM, LOUPE_ZOOM);
    ctx.strokeStyle = "rgba(0,0,0,0.8)";
    ctx.lineWidth = 1;
    ctx.strokeRect(half * LOUPE_ZOOM - 1, half * LOUPE_ZOOM - 1, LOUPE_ZOOM + 2, LOUPE_ZOOM + 2);
  }, [pointer, nudge, info, scale, capturing, backdrop]);

  // ── capture ──────────────────────────────────────────────────────────────
  const finish = async (result: api.CaptureResult | null, message: string) => {
    if (result) {
      pushCapture(result);
      await loadLibrary();
    }
    setStatus("ready", "Saved");
    toast(message, "success");
  };

  const capture = async (box: LocalRect) => {
    if (!info || busy) return;
    if (box.w < 3 || box.h < 3) {
      toast("Select a larger area", "error");
      return;
    }
    setBusy(true);
    try {
      const [gx, gy] = toGlobal(box.x, box.y);
      const gw = toPhysical(box.w);
      const gh = toPhysical(box.h);
      if (mode === "scrolling") {
        setCapturing(true);
        setStatus("busy", "Scrolling capture…");
        const stopStarted = await api.onScrollingStarted(() => setProgress({ done: 0, total: 0 }));
        const stopProgress = await api.onScrollingProgress((done, total) => setProgress({ done, total }));
        try {
          const result = await api.captureScrolling(gx, gy, gw, gh);
          await finish(result, `Scrolling capture saved (${result.height}px tall)`);
        } finally {
          stopStarted();
          stopProgress();
        }
      } else if (mode === "recarea" || mode === "recwindow" || mode === "recfixed") {
        // Hand the area to the recorder setup in the main window; nothing is captured here.
        await api.cancelRegionSelector();
        await api.emitEvent(api.EVENTS.recordArea, { x: gx, y: gy, width: gw, height: gh });
      } else if (mode === "ocr") {
        setStatus("busy", "Reading text…");
        const shot = await api.captureRegion(gx, gy, gw, gh);
        const text = await api.ocrAndCopy(shot.path, "eng");
        pushCapture(shot);
        await loadLibrary();
        setStatus("ready");
        toast(text.words > 0 ? `Copied ${text.words} words to the clipboard` : "No text was found in that area", text.words > 0 ? "success" : "error");
      } else {
        setStatus("busy", "Capturing…");
        const result = await api.captureRegion(gx, gy, gw, gh);
        await finish(result, "Capture saved");
      }
    } catch (error) {
      toast(api.errorMessage(error), "error");
      setStatus("error");
    } finally {
      setBusy(false);
      setCapturing(false);
      await api.cancelRegionSelector();
    }
  };

  const captureFreehand = async (shape: Point[]) => {
    if (!info || busy) return;
    if (shape.length < 3) {
      toast("Draw around the area you want to keep", "error");
      setPoints([]);
      return;
    }
    setBusy(true);
    try {
      setStatus("busy", "Cropping selection…");
      const result = await api.captureFreehand(shape.map(([x, y]) => toGlobal(x, y)) as [number, number][]);
      await finish(result, "Capture saved");
    } catch (error) {
      toast(api.errorMessage(error), "error");
      setStatus("error");
    } finally {
      setBusy(false);
      await api.cancelRegionSelector();
    }
  };

  const pickColor = async (x: number, y: number, asRgb: boolean) => {
    const color = pixelAt(x, y);
    if (!color) return;
    const text = asRgb ? `rgb(${color.r}, ${color.g}, ${color.b})` : color.hex;
    await api.copyTextToClipboard(text).catch(() => undefined);
    toast(`${text} copied`, "success");
    await api.cancelRegionSelector();
  };

  // ── pointer handling ─────────────────────────────────────────────────────
  const local = (event: React.MouseEvent): Point => {
    const bounds = (event.currentTarget as HTMLElement).getBoundingClientRect();
    return [event.clientX - bounds.left, event.clientY - bounds.top];
  };

  const onMouseDown = (event: React.MouseEvent) => {
    if (busy || capturing) return;
    if (event.button === 2) {
      cancel();
      return;
    }
    if (event.button !== 0) return;
    const [x, y] = local(event);
    start.current = [x, y];
    if (mode === "pick") {
      void pickColor(x, y, event.shiftKey);
      return;
    }
    if (mode === "fixed" || mode === "recfixed") {
      if (fixedBox) void capture(fixedBox);
      return;
    }
    setDrawing(true);
    if (mode === "freehand") setPoints([[x, y]]);
    else setRect({ x, y, w: 0, h: 0 });
  };

  const onMouseMove = (event: React.MouseEvent) => {
    const [x, y] = local(event);
    setPointer([x, y]);
    if (!drawing) return;
    if (mode === "freehand") {
      setPoints((previous) => [...previous, [x, y]]);
    } else {
      let w = Math.abs(x - start.current[0]);
      let h = Math.abs(y - start.current[1]);
      if (event.shiftKey) w = h = Math.max(w, h);
      setRect({
        x: x < start.current[0] ? start.current[0] - w : start.current[0],
        y: y < start.current[1] ? start.current[1] - h : start.current[1],
        w,
        h,
      });
    }
  };

  const onMouseUp = () => {
    if (!drawing) return;
    setDrawing(false);
    if (mode === "freehand") {
      void captureFreehand(points);
      return;
    }
    if (!rect) return;
    // A click without a drag snaps to the window under the pointer.
    if (rect.w < 4 && rect.h < 4) {
      // `hoveredWindow` is null while the button is down, so use the one remembered before it.
      const target = hoverRef.current;
      if (target && mode === "recwindow") {
        void api.cancelRegionSelector();
        void api.emitEvent(api.EVENTS.recordWindow, target);
      } else if (target) {
        void capture(toLocalRect(target.x, target.y, target.width, target.height));
      } else {
        setRect(null);
      }
      return;
    }
    void capture(rect);
  };

  // ── keyboard ─────────────────────────────────────────────────────────────
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !capturing) {
        cancel();
        return;
      }
      if (mode === "pick" && event.key.startsWith("Arrow")) {
        event.preventDefault();
        setNudge(([nx, ny]) => [
          nx + (event.key === "ArrowLeft" ? -1 : event.key === "ArrowRight" ? 1 : 0),
          ny + (event.key === "ArrowUp" ? -1 : event.key === "ArrowDown" ? 1 : 0),
        ]);
      }
      if (event.key === "Enter" && mode === "pick") {
        void pickColor(pointer[0], pointer[1], event.shiftKey);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, capturing, pointer, nudge, cancel]);

  // ── rendering ────────────────────────────────────────────────────────────
  const viewport = { w: window.innerWidth, h: window.innerHeight };
  const active: LocalRect | null =
    mode === "fixed" || mode === "recfixed"
      ? fixedBox
      : rect && (rect.w > 0 || rect.h > 0)
        ? rect
        : !drawing && hoveredWindow
          ? toLocalRect(hoveredWindow.x, hoveredWindow.y, hoveredWindow.width, hoveredWindow.height)
          : null;

  const path = points.length ? `M ${points.map(([x, y]) => `${x} ${y}`).join(" L ")} Z` : "";

  // While a scrolling capture runs the overlay must paint nothing over the
  // region (every pixel drawn there would be captured). Only a small progress
  // badge remains, in whichever corner the selection does not touch.
  if (capturing) {
    const badge = { w: 270, h: 44 };
    const corners: LocalRect[] = [
      { x: 12, y: 12, ...badge, w: badge.w, h: badge.h },
      { x: viewport.w - badge.w - 12, y: 12, w: badge.w, h: badge.h },
      { x: 12, y: viewport.h - badge.h - 12, w: badge.w, h: badge.h },
      { x: viewport.w - badge.w - 12, y: viewport.h - badge.h - 12, w: badge.w, h: badge.h },
    ];
    // On Wayland the window itself shrinks to the badge and moves clear of the area.
    const compact = viewport.w < badge.w + 60;
    const free = compact
      ? corners[0]
      : corners.find((c) =>
          !rect || c.x + c.w < rect.x - 8 || c.x > rect.x + rect.w + 8 || c.y + c.h < rect.y - 8 || c.y > rect.y + rect.h + 8,
        );
    return (
      <div className="fixed inset-0 pointer-events-none">
        {free ? (
          <div
            className="absolute glass-panel rounded-xl px-3 py-2 text-[11px] text-slate-200 font-mono flex items-center gap-2"
            style={{ left: free.x, top: free.y, width: badge.w }}
          >
            <Icon name="loading" size={13} className="spin text-violet-300" />
            {progress && progress.done > 0
              ? `Scrolling… frame ${progress.done}`
              : "Scrolling… getting ready"}
            <span className="text-slate-500">· Esc to finish</span>
          </div>
        ) : null}
      </div>
    );
  }

  const loupeLeft = pointer[0] + 28 + LOUPE_CELLS * LOUPE_ZOOM > viewport.w ? pointer[0] - 28 - LOUPE_CELLS * LOUPE_ZOOM : pointer[0] + 28;
  const loupeTop = pointer[1] + 28 + LOUPE_CELLS * LOUPE_ZOOM + 70 > viewport.h ? pointer[1] - 28 - LOUPE_CELLS * LOUPE_ZOOM - 70 : pointer[1] + 28;
  const colorNow = mode === "pick" ? pixelAt(pointer[0], pointer[1]) : null;

  return (
    <div
      className="region-overlay"
      style={{ cursor: mode === "pick" ? "none" : "crosshair" }}
      onMouseDown={onMouseDown}
      onMouseMove={onMouseMove}
      onMouseUp={onMouseUp}
      onContextMenu={(event) => event.preventDefault()}
    >
      {backdrop ? (
        <img
          src={backdrop}
          alt=""
          className="absolute inset-0 w-full h-full pointer-events-none select-none"
          draggable={false}
        />
      ) : null}

      {/* Dim everything; the active box punches a bright hole through it. */}
      {!active && mode !== "freehand" && mode !== "pick" ? (
        <div className="absolute inset-0 pointer-events-none" style={{ background: "rgba(5,6,12,0.28)" }} />
      ) : null}

      {active && mode !== "freehand" ? (
        <div
          className="selection-box"
          style={{
            left: active.x,
            top: active.y,
            width: active.w,
            height: active.h,
            borderStyle: rect ? "solid" : "dashed",
          }}
        >
          <span
            className="size-tag absolute"
            style={{ left: 0, top: active.y > 30 ? -26 : active.h + 6 }}
          >
            {Math.round(active.w * scale)} × {Math.round(active.h * scale)}
            {!rect && hoveredWindow ? ` · ${hoveredWindow.appName || hoveredWindow.title}`.slice(0, 40) : ""}
          </span>
        </div>
      ) : null}

      {mode === "freehand" && points.length > 1 ? (
        <>
          <div className="absolute inset-0 pointer-events-none" style={{ background: "rgba(5,6,12,0.45)" }} />
          <svg className="absolute inset-0 pointer-events-none" width="100%" height="100%">
            <path d={path} fill="rgba(167,139,250,0.22)" stroke="#a78bfa" strokeWidth={2} strokeLinejoin="round" />
          </svg>
        </>
      ) : null}

      {/* Crosshair guides */}
      {mode !== "pick" && !drawing && !active ? (
        <>
          <div className="absolute top-0 bottom-0 w-px bg-white/30 pointer-events-none" style={{ left: pointer[0] }} />
          <div className="absolute left-0 right-0 h-px bg-white/30 pointer-events-none" style={{ top: pointer[1] }} />
        </>
      ) : null}

      {/* Magnifier with pixel grid and coordinates */}
      {backdrop ? (
        <div
          className="absolute pointer-events-none glass-panel rounded-xl p-1.5"
          style={{ left: loupeLeft, top: loupeTop, width: LOUPE_CELLS * LOUPE_ZOOM + 12 }}
        >
          <canvas ref={loupe} className="rounded-lg block" style={{ imageRendering: "pixelated" }} />
          <div className="text-[10px] font-mono text-slate-300 mt-1 px-0.5 flex items-center justify-between">
            <span>
              {toGlobal(pointer[0], pointer[1])[0] + nudge[0]}, {toGlobal(pointer[0], pointer[1])[1] + nudge[1]}
            </span>
            {colorNow ? (
              <span className="flex items-center gap-1.5">
                <span className="w-3 h-3 rounded-sm border border-white/30" style={{ background: colorNow.hex }} />
                {colorNow.hex}
              </span>
            ) : null}
          </div>
          {colorNow ? (
            <div className="text-[10px] font-mono text-slate-500 px-0.5">
              rgb({colorNow.r}, {colorNow.g}, {colorNow.b})
            </div>
          ) : null}
        </div>
      ) : null}

      {/* Hint bar */}
      <div
        className="absolute left-1/2 -translate-x-1/2 top-4 z-20 flex items-center gap-2"
        onMouseDown={(e) => e.stopPropagation()}
        onMouseUp={(e) => e.stopPropagation()}
      >
        <div className="glass-panel rounded-xl px-3 py-2 text-[11px] text-slate-200 flex items-center gap-2">
          <span className="text-violet-300 font-semibold uppercase tracking-wider text-[9.5px]">{mode}</span>
          <span className="text-slate-300">{HINTS[mode]}</span>
          {screens.length > 1 ? (
            <span className="flex items-center gap-1 ml-1 pl-2 border-l border-white/15">
              {screens.map((screen, index) => (
                <button
                  key={screen.id}
                  className={`chip ${!onAllScreens && info && info.x === screen.x && info.y === screen.y ? "is-active" : ""}`}
                  title={`Select on ${screen.name || `screen ${index + 1}`}`}
                  onClick={() => switchScope(index)}
                >
                  Screen {index + 1}
                </button>
              ))}
              <button
                className={`chip ${onAllScreens ? "is-active" : ""}`}
                title="Select across all screens"
                onClick={() => switchScope(null)}
              >
                All
              </button>
            </span>
          ) : null}
          <button
            className="tool-btn w-6 h-6 rounded-md flex items-center justify-center ml-1"
            title="Cancel (Esc)"
            onClick={cancel}
          >
            <Icon name="close" size={12} strokeWidth={2.4} />
          </button>
        </div>
      </div>
    </div>
  );
}
