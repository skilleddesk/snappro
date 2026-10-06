/* eslint-disable @typescript-eslint/no-explicit-any */
import { PdfDialog, type PdfSource } from "./PdfDialog";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PencilBrush } from "fabric";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { Icon } from "./Icon";
import { IconToggle, NumberBox, SmallButton } from "./editorUi";
import { EffectsPanel, ImagePanel, LayersPanel, StylePanel, type PanelProps } from "./EditorPanels";
import * as api from "../lib/api";
import { useStore } from "../lib/store";
import { nativeWindow } from "../lib/window";
import { EditorEngine, normalizeScale } from "../editor/engine";
import { SpotlightShape } from "../editor/shapes";
import {
  DEFAULT_STYLE,
  attachTools,
  hexToRgba,
  kindOf,
  readStyle,
  writeStyle,
  type ObjectKind,
  type Tool,
  type ToolStyle,
} from "../editor/tools";

interface ToolDef {
  id: Tool;
  icon: string;
  label: string;
  key?: string;
}

const TOOL_GROUPS: ToolDef[][] = [
  [
    { id: "select", icon: "cursor", label: "Select", key: "V" },
    { id: "hand", icon: "hand", label: "Pan", key: "H" },
    { id: "crop", icon: "crop", label: "Crop", key: "C" },
  ],
  [
    { id: "arrow", icon: "arrow", label: "Arrow", key: "A" },
    { id: "line", icon: "lines", label: "Line", key: "L" },
    { id: "rect", icon: "squareShape", label: "Box", key: "R" },
    { id: "ellipse", icon: "circle", label: "Oval", key: "O" },
    { id: "poly", icon: "shapes", label: "Shapes", key: "U" },
    { id: "pen", icon: "pen", label: "Pen", key: "P" },
    { id: "highlighter", icon: "highlighter", label: "Marker pen", key: "K" },
    { id: "marker", icon: "highlighter", label: "Highlight", key: "M" },
  ],
  [
    { id: "text", icon: "text", label: "Text", key: "T" },
    { id: "callout", icon: "callout", label: "Callout", key: "Q" },
    { id: "step", icon: "hash", label: "Step", key: "N" },
    { id: "stamp", icon: "smile", label: "Stamp", key: "S" },
  ],
  [
    { id: "redact", icon: "blur", label: "Blur", key: "B" },
    { id: "spotlight", icon: "spotlight", label: "Focus", key: "F" },
    { id: "magnifier", icon: "magnifier", label: "Magnify", key: "Z" },
  ],
  [
    { id: "eraser", icon: "eraser", label: "Eraser", key: "E" },
    { id: "eyedropper", icon: "eyedropper", label: "Colour", key: "I" },
  ],
];

const KEY_TO_TOOL: Record<string, Tool> = {};
TOOL_GROUPS.flat().forEach((tool) => {
  if (tool.key) KEY_TO_TOOL[tool.key.toLowerCase()] = tool.id;
});

const RATIOS: { label: string; value: number | null }[] = [
  { label: "Free", value: null },
  { label: "1:1", value: 1 },
  { label: "4:3", value: 4 / 3 },
  { label: "3:2", value: 3 / 2 },
  { label: "16:9", value: 16 / 9 },
  { label: "9:16", value: 9 / 16 },
];

type Tab = "style" | "layers" | "image" | "effects";

function loadBitmap(dataUrl: string): Promise<HTMLCanvasElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      canvas.getContext("2d")?.drawImage(image, 0, 0);
      resolve(canvas);
    };
    image.onerror = () => reject(new Error("The image could not be decoded"));
    image.src = dataUrl;
  });
}

export function Editor({ path, onClose }: { path: string; onClose: () => void }) {
  const canvasElement = useRef<HTMLCanvasElement | null>(null);
  const host = useRef<HTMLDivElement | null>(null);
  const engineRef = useRef<EditorEngine | null>(null);
  const [engine, setEngine] = useState<EditorEngine | null>(null);
  const [pdfSource, setPdfSource] = useState<PdfSource | null>(null);
  const [, setTick] = useState(0);

  const [currentPath, setCurrentPath] = useState(path);
  const [pendingPath, setPendingPath] = useState<string | null>(null);
  const [closing, setClosing] = useState(false);
  const [tool, setToolState] = useState<Tool>("select");
  const [spaceHeld, setSpaceHeld] = useState(false);
  const [sticky, setSticky] = useState(false);
  const [style, setStyle] = useState<ToolStyle>(DEFAULT_STYLE);
  const [tab, setTab] = useState<Tab>("style");
  const [busy, setBusy] = useState<string | null>(null);
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  const [cropRatio, setCropRatio] = useState<number | null>(null);
  const [plugins, setPlugins] = useState<api.PluginManifest[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const { toast: pushToast, loadLibrary, settings } = useStore();
  const activeTool: Tool = spaceHeld ? "hand" : tool;

  // Responsive layout: the editor runs in windows from 760 px wide up to full screen.
  const [win, setWin] = useState({ w: window.innerWidth, h: window.innerHeight });
  const [panelOpen, setPanelOpen] = useState(window.innerWidth >= 1180);
  const [notice, setNotice] = useState<{ text: string; kind: "ok" | "error" | "busy" } | null>(null);
  const [showKeys, setShowKeys] = useState(false);
  const [grid, setGrid] = useState(false);
  const [snap, setSnap] = useState(true);
  const [exportMenu, setExportMenu] = useState(false);
  const compact = win.w < 1180;
  const narrow = win.w < 940;
  const short = win.h < 700;

  /** Show a message where the user is looking: a toast and a line in the bottom bar. */
  const toast = useCallback(
    (message: string, kind: "info" | "success" | "error" = "info") => {
      pushToast(message, kind);
      setNotice({ text: message, kind: kind === "error" ? "error" : "ok" });
    },
    [pushToast],
  );
  useEffect(() => {
    if (!notice || notice.kind === "busy") return;
    const timer = window.setTimeout(() => setNotice(null), 6000);
    return () => window.clearTimeout(timer);
  }, [notice]);
  useEffect(() => {
    let was = window.innerWidth < 1180;
    const onResize = () => {
      const next = { w: window.innerWidth, h: window.innerHeight };
      setWin(next);
      const isCompact = next.w < 1180;
      // Crossing the breakpoint opens the panel when there is room and tucks it away when not.
      if (isCompact !== was) setPanelOpen(!isCompact);
      was = isCompact;
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // Refs so the long-lived canvas listeners always see current values.
  const toolRef = useRef(tool);
  const styleRef = useRef(style);
  const stickyRef = useRef(sticky);
  const ratioRef = useRef(cropRatio);
  const cropBox = useRef<any>(null);
  const userZoomed = useRef(false);
  const commitTimer = useRef<number | undefined>(undefined);
  toolRef.current = tool;
  styleRef.current = style;
  stickyRef.current = sticky;
  ratioRef.current = cropRatio;

  const fileName = currentPath.split(/[\\/]/).pop() ?? "image";

  const setTool = useCallback((next: Tool) => {
    toolRef.current = next;
    setToolState(next);
  }, []);

  // ── engine lifecycle ─────────────────────────────────────────────────────
  useEffect(() => {
    const element = canvasElement.current;
    const area = host.current;
    if (!element || !area) return;
    const created = new EditorEngine(element);
    engineRef.current = created;
    setEngine(created);
    // Browser preview only: lets automated tests drive the editor.
    if (!("__TAURI_INTERNALS__" in window)) (window as any).__engine = created;

    const unsubscribe = created.subscribe(() => setTick((value) => value + 1));
    const rect = area.getBoundingClientRect();
    created.resizeViewport(rect.width, rect.height);

    const observer = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      if (!box) return;
      created.resizeViewport(box.width, box.height);
      if (!userZoomed.current && created.width > 0) created.fit();
    });
    observer.observe(area);

    const detach = attachTools(created, {
      tool: () => toolRef.current,
      style: () => styleRef.current,
      sticky: () => stickyRef.current,
      setTool: (next) => {
        toolRef.current = next;
        setToolState(next);
      },
      patchStyle: (patch) => setStyle((previous) => ({ ...previous, ...patch })),
      toast: (message, kind) => useStore.getState().toast(message, kind),
      copyText: (text) => void api.copyTextToClipboard(text).catch(() => undefined),
    });

    // Highlighter strokes darken instead of covering the text underneath.
    const onPath = (event: any) => {
      if (toolRef.current === "highlighter" && event.path) {
        event.path.set({ globalCompositeOperation: "multiply" });
      }
    };
    created.canvas.on("path:created", onPath);

    // Keep the crop frame inside the picture (and in shape, if a ratio is set).
    const clampCrop = (event: any, scaling: boolean) => {
      const target = event.target;
      if (!target?.snapTemp) return;
      if (scaling) {
        normalizeScale(target);
        const ratio = ratioRef.current;
        if (ratio) target.set({ height: target.width / ratio });
        target.set({
          width: Math.min(target.width, created.width),
          height: Math.min(target.height, created.height),
        });
      }
      target.set({
        left: Math.min(Math.max(0, target.left), created.width - target.width),
        top: Math.min(Math.max(0, target.top), created.height - target.height),
      });
      target.setCoords();
    };
    const onMoving = (event: any) => clampCrop(event, false);
    const onScaling = (event: any) => clampCrop(event, true);
    created.canvas.on("object:moving", onMoving);
    created.canvas.on("object:scaling", onScaling);

    const onMove = (event: any) => {
      const point = created.canvas.getScenePoint(event.e);
      setCursor({ x: Math.round(point.x), y: Math.round(point.y) });
    };
    created.canvas.on("mouse:move", onMove);

    void api.pluginsList().then(setPlugins).catch(() => undefined);

    return () => {
      detach();
      observer.disconnect();
      unsubscribe();
      created.canvas.off("path:created", onPath);
      created.canvas.off("object:moving", onMoving);
      created.canvas.off("object:scaling", onScaling);
      created.canvas.off("mouse:move", onMove);
      created.dispose();
      engineRef.current = null;
      setEngine(null);
    };
  }, []);

  // ── loading a picture ────────────────────────────────────────────────────
  const loadPath = useCallback(
    async (target: string) => {
      const active = engineRef.current;
      if (!active) return;
      setLoadError(null);
      try {
        const data = await api.readImageData(target);
        const bitmap = await loadBitmap(data);
        active.loadPicture(bitmap);
        userZoomed.current = false;
        setCurrentPath(target);
        setTool("select");
        setStyle((previous) => ({ ...previous, stepValue: 1 }));
      } catch (error) {
        setLoadError(api.errorMessage(error));
        toast(`Could not open that image: ${api.errorMessage(error)}`, "error");
      }
    },
    [setTool, toast],
  );

  useEffect(() => {
    if (!engine) return;
    if (path === currentPath && engine.width > 0) return;
    if (engine.width > 0 && engine.dirty && path !== currentPath) {
      setPendingPath(path);
      return;
    }
    void loadPath(path);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, path]);

  // ── tool configuration ───────────────────────────────────────────────────
  const endCrop = useCallback(() => {
    const active = engineRef.current;
    if (active && cropBox.current) {
      active.canvas.remove(cropBox.current);
      cropBox.current = null;
      active.canvas.requestRenderAll();
    }
  }, []);

  const startCrop = useCallback(() => {
    const active = engineRef.current;
    if (!active || active.width === 0) return;
    endCrop();
    const box: any = new SpotlightShape({
      left: active.width * 0.06,
      top: active.height * 0.06,
      width: active.width * 0.88,
      height: active.height * 0.88,
      dim: 0.58,
      ring: "#ffffff",
      cornerRadius: 0,
      lockRotation: true,
      snapTemp: true,
    });
    box.setControlsVisibility({ mtr: false });
    active.canvas.add(box);
    box.set({ selectable: true, evented: true });
    active.canvas.setActiveObject(box);
    cropBox.current = box;
    active.canvas.requestRenderAll();
  }, [endCrop]);

  useEffect(() => {
    if (!engine) return;
    const canvas = engine.canvas;
    const drawing = activeTool === "pen" || activeTool === "highlighter";
    canvas.isDrawingMode = drawing;
    if (drawing) {
      const brush = new PencilBrush(canvas);
      brush.color = activeTool === "highlighter" ? hexToRgba(style.stroke, 0.42) : style.stroke;
      brush.width = activeTool === "highlighter" ? Math.max(10, style.strokeWidth * 3) : style.strokeWidth;
      (brush as any).strokeLineCap = "round";
      canvas.freeDrawingBrush = brush;
    }
    engine.setInteractive(activeTool === "select" ? "select" : activeTool === "eraser" ? "erase" : "none");

    if (activeTool === "crop") startCrop();
    else endCrop();

    canvas.defaultCursor =
      activeTool === "select" ? "default" : activeTool === "hand" ? "grab" : activeTool === "eraser" ? "not-allowed" : "crosshair";
    canvas.hoverCursor = activeTool === "select" ? "move" : canvas.defaultCursor;
    canvas.requestRenderAll();
  }, [engine, activeTool, style.stroke, style.strokeWidth, startCrop, endCrop]);

  // ── selection ↔ style panel ──────────────────────────────────────────────
  const selected = engine?.canvas.getActiveObjects() ?? [];
  const single: any = selected.length === 1 && !(selected[0] as any).snapTemp ? selected[0] : null;
  const selectionKind: ObjectKind | null = single ? kindOf(single) : null;
  const shown: ToolStyle = useMemo(
    () => (single ? ({ ...style, ...readStyle(single) } as ToolStyle) : style),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [single, style, engine?.canvas.getActiveObjects().length, single?.cacheKey],
  );

  const commitSoon = useCallback(() => {
    window.clearTimeout(commitTimer.current);
    commitTimer.current = window.setTimeout(() => engineRef.current?.commit(), 350);
  }, []);

  const patchStyle = useCallback(
    (patch: Partial<ToolStyle>) => {
      const active = engineRef.current;
      const merged = { ...styleRef.current, ...patch };
      setStyle(merged);
      styleRef.current = merged;
      if (!active) return;
      active
        .canvas.getActiveObjects()
        .filter((object: any) => !object.snapTemp)
        .forEach((object: any) => writeStyle(object, patch, merged));
      active.canvas.requestRenderAll();
      setTick((value) => value + 1);
    },
    [],
  );

  // ── view helpers ─────────────────────────────────────────────────────────
  const view = engine?.view;
  const zoomBy = (factor: number) => {
    if (!engine) return;
    userZoomed.current = true;
    engine.zoomTo(engine.view.zoom * factor);
  };

  // Wheel: Ctrl+wheel zooms around the pointer, plain wheel scrolls.
  useEffect(() => {
    const area = host.current;
    if (!area || !engine) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      userZoomed.current = true;
      if (event.ctrlKey || event.metaKey) {
        const bounds = area.getBoundingClientRect();
        engine.zoomTo(engine.view.zoom * (event.deltaY < 0 ? 1.12 : 1 / 1.12), {
          x: event.clientX - bounds.left,
          y: event.clientY - bounds.top,
        });
      } else if (event.shiftKey) {
        engine.panBy(-event.deltaY, 0);
      } else {
        engine.panBy(-event.deltaX, -event.deltaY);
      }
    };
    area.addEventListener("wheel", onWheel, { passive: false });
    return () => area.removeEventListener("wheel", onWheel);
  }, [engine]);

  // Hand tool / middle mouse button pan.
  useEffect(() => {
    const area = host.current;
    if (!area || !engine) return;
    let last: { x: number; y: number } | null = null;
    const down = (event: PointerEvent) => {
      if (event.button === 1 || (event.button === 0 && (toolRef.current === "hand" || spaceRef.current))) {
        last = { x: event.clientX, y: event.clientY };
        area.setPointerCapture(event.pointerId);
        event.preventDefault();
      }
    };
    const move = (event: PointerEvent) => {
      if (!last) return;
      userZoomed.current = true;
      engine.panBy(event.clientX - last.x, event.clientY - last.y);
      last = { x: event.clientX, y: event.clientY };
    };
    const up = (event: PointerEvent) => {
      if (!last) return;
      last = null;
      try {
        area.releasePointerCapture(event.pointerId);
      } catch {
        /* already released */
      }
    };
    area.addEventListener("pointerdown", down, true);
    area.addEventListener("pointermove", move);
    area.addEventListener("pointerup", up);
    return () => {
      area.removeEventListener("pointerdown", down, true);
      area.removeEventListener("pointermove", move);
      area.removeEventListener("pointerup", up);
    };
  }, [engine]);
  const spaceRef = useRef(false);

  // ── saving / exporting ───────────────────────────────────────────────────
  const afterSave = async (message: string) => {
    engineRef.current?.markSaved();
    toast(message, "success");
    await loadLibrary();
  };

  const guard = async (label: string, task: () => Promise<void>) => {
    setBusy(label);
    setNotice({ text: label, kind: "busy" });
    try {
      await task();
    } catch (error) {
      toast(`Failed: ${api.errorMessage(error)}`, "error");
    } finally {
      setBusy(null);
      setNotice((current) => (current?.kind === "busy" ? null : current));
    }
  };

  const saveOver = () =>
    guard("Saving…", async () => {
      if (!engine) return;
      await api.overwriteImage(engine.dataUrl("png"), currentPath);
      await afterSave(`Saved ${fileName}`);
    });

  const saveNew = () =>
    guard("Saving…", async () => {
      if (!engine) return;
      const result = await api.saveEditedImage(engine.dataUrl("png"), currentPath);
      await afterSave(`Saved as ${result.path.split(/[\\/]/).pop()}`);
    });

  const saveAs = () =>
    guard("Saving…", async () => {
      if (!engine) return;
      const target = await saveDialog({
        title: "Save image as",
        defaultPath: fileName.replace(/\.[^.]+$/, "") + "-edited.png",
        filters: [
          { name: "PNG", extensions: ["png"] },
          { name: "JPEG", extensions: ["jpg", "jpeg"] },
          { name: "WebP", extensions: ["webp"] },
          { name: "Bitmap", extensions: ["bmp"] },
        ],
      });
      if (!target) return;
      await api.exportImage(engine.dataUrl("png"), target);
      await afterSave(`Saved ${target.split(/[\\/]/).pop()}`);
    });

  const exportAs = (format: "png" | "jpg" | "webp") =>
    guard("Exporting…", async () => {
      if (!engine) return;
      const saved = await api.exportImage(engine.dataUrl("png"), undefined, format);
      toast(`Exported ${saved.split(/[\\/]/).pop()}`, "success");
      await loadLibrary();
    });

  const exportPdf = () => {
    if (!engine) return;
    const dataUrl = engine.dataUrl("png");
    const probe = new Image();
    probe.onload = () => setPdfSource({ kind: "data", dataUrl, sizes: [[probe.naturalWidth, probe.naturalHeight]] });
    probe.onerror = () => toast("Could not read the picture", "error");
    probe.src = dataUrl;
  };

  const copy = () =>
    guard("Copying…", async () => {
      if (!engine) return;
      await api.copyImageData(engine.dataUrl("png"));
      toast("Copied to the clipboard", "success");
    });

  const addPicture = async () => {
    try {
      const file = await openDialog({
        multiple: false,
        title: "Add a picture as a layer",
        filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "bmp", "gif"] }],
      });
      if (typeof file !== "string" || !engine) return;
      await engine.addImageLayer(await api.readImageData(file));
      setTool("select");
    } catch (error) {
      toast(api.errorMessage(error), "error");
    }
  };

  // Paste a picture from the clipboard as a new layer.
  useEffect(() => {
    if (!engine) return;
    const onPaste = (event: ClipboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
      const item = Array.from(event.clipboardData?.items ?? []).find((entry) => entry.type.startsWith("image/"));
      const file = item?.getAsFile();
      if (!file) {
        // No picture on the system clipboard: paste annotations copied inside the editor.
        if (engine.hasObjectClipboard) {
          event.preventDefault();
          void engine.pasteObjects();
        }
        return;
      }
      event.preventDefault();
      const reader = new FileReader();
      reader.onload = () => {
        void engine.addImageLayer(String(reader.result)).then(() => setTool("select"));
      };
      reader.readAsDataURL(file);
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [engine, setTool]);

  // ── crop ─────────────────────────────────────────────────────────────────
  const applyCrop = () => {
    const box = cropBox.current;
    if (!engine || !box) return;
    const { left, top, width, height } = box;
    endCrop();
    engine.cropTo(left, top, width, height);
    userZoomed.current = false;
    setTool("select");
    toast(`Cropped to ${Math.round(width)} × ${Math.round(height)}`, "success");
  };

  const setCropField = (field: "left" | "top" | "width" | "height", value: number) => {
    const box = cropBox.current;
    if (!box || !engine) return;
    const next: any = { [field]: Math.max(field === "width" || field === "height" ? 8 : 0, value) };
    box.set(next);
    box.set({
      width: Math.min(box.width, engine.width),
      height: Math.min(box.height, engine.height),
    });
    box.set({
      left: Math.min(box.left, engine.width - box.width),
      top: Math.min(box.top, engine.height - box.height),
    });
    box.setCoords();
    engine.canvas.requestRenderAll();
    setTick((v) => v + 1);
  };

  const applyRatio = (ratio: number | null) => {
    setCropRatio(ratio);
    ratioRef.current = ratio;
    const box = cropBox.current;
    if (!box || !engine) return;
    if (ratio) {
      let w = Math.min(box.width, engine.width);
      let h = w / ratio;
      if (h > engine.height) {
        h = engine.height;
        w = h * ratio;
      }
      box.set({ width: w, height: h });
    }
    box.set({
      left: Math.min(Math.max(0, box.left), engine.width - box.width),
      top: Math.min(Math.max(0, box.top), engine.height - box.height),
    });
    box.setCoords();
    engine.canvas.requestRenderAll();
    setTick((v) => v + 1);
  };

  // ── keyboard ─────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!engine) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing =
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.tagName === "SELECT" ||
        (engine.canvas.getActiveObject() as any)?.isEditing;
      const meta = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();

      if (event.code === "Space" && !typing) {
        event.preventDefault();
        spaceRef.current = true;
        setSpaceHeld(true);
        return;
      }
      if (meta && key === "z" && !event.shiftKey) {
        event.preventDefault();
        void engine.undo();
      } else if (meta && (key === "y" || (key === "z" && event.shiftKey))) {
        event.preventDefault();
        void engine.redo();
      } else if (meta && key === "s") {
        event.preventDefault();
        if (event.shiftKey) void saveAs();
        else void saveOver();
      } else if (meta && key === "c" && !typing) {
        event.preventDefault();
        // Annotations selected: copy those; otherwise copy the whole picture.
        if (!engine.copySelected()) void copy();
      } else if (meta && key === "x" && !typing) {
        event.preventDefault();
        if (engine.copySelected()) engine.deleteSelected();
      } else if (meta && key === "a" && !typing) {
        event.preventDefault();
        engine.selectAll();
      } else if (!typing && event.key === "?") {
        setShowKeys((value) => !value);
      } else if (!typing && key === "g" && !meta) {
        setGrid((value) => !value);
      } else if (meta && key === "d" && !typing) {
        event.preventDefault();
        engine.duplicateSelected();
      } else if (meta && (key === "=" || key === "+")) {
        event.preventDefault();
        zoomBy(1.2);
      } else if (meta && key === "-") {
        event.preventDefault();
        zoomBy(1 / 1.2);
      } else if (meta && key === "0") {
        event.preventDefault();
        userZoomed.current = false;
        engine.fit();
      } else if (meta && key === "1") {
        event.preventDefault();
        userZoomed.current = true;
        engine.actualSize();
      } else if (!typing && (event.key === "Delete" || event.key === "Backspace")) {
        event.preventDefault();
        engine.deleteSelected();
      } else if (!typing && event.key === "Escape") {
        if (toolRef.current === "crop") setTool("select");
        else {
          engine.canvas.discardActiveObject();
          engine.canvas.requestRenderAll();
          if (toolRef.current !== "select") setTool("select");
        }
      } else if (!typing && event.key === "Enter" && toolRef.current === "crop") {
        applyCrop();
      } else if (!typing && event.key.startsWith("Arrow") && engine.canvas.getActiveObject()) {
        event.preventDefault();
        const step = event.shiftKey ? 10 : 1;
        const object: any = engine.canvas.getActiveObject();
        if (object.snapTemp) return;
        object.set({
          left: object.left + (event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0),
          top: object.top + (event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0),
        });
        object.setCoords();
        engine.canvas.requestRenderAll();
        commitSoon();
      } else if (!typing && !meta && !event.altKey && KEY_TO_TOOL[key]) {
        setTool(KEY_TO_TOOL[key]);
      } else if (!typing && (event.key === "[" || event.key === "]")) {
        patchStyle({ strokeWidth: Math.max(1, style.strokeWidth + (event.key === "]" ? 1 : -1)) });
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.code === "Space") {
        spaceRef.current = false;
        setSpaceHeld(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
    // The handlers read fresh values through refs and the engine; they are
    // re-created when those closures change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engine, currentPath, style.strokeWidth, settings?.format]);

  // ── closing / switching files with unsaved edits ─────────────────────────
  const requestClose = () => {
    if (engine?.dirty) setClosing(true);
    else onClose();
  };

  const panelProps: PanelProps | null = engine
    ? {
        engine,
        tick: 0,
        tool,
        style,
        shown,
        selectionKind,
        patchStyle,
        commitSoon,
        toast: (message, kind) => toast(message, kind),
      }
    : null;

  const dirty = Boolean(engine?.dirty);
  const paper = view && engine
    ? {
        left: view.x,
        top: view.y,
        width: engine.width * view.zoom,
        height: engine.height * view.zoom,
      }
    : null;
  const labels = !short && !narrow;
  const guides = engine?.guides ?? { x: [], y: [] };

  useEffect(() => {
    if (engine) engine.snap = snap;
  }, [engine, snap]);

  const panelNode = panelProps ? (
    <>
      <div className="flex border-b border-white/5 shrink-0">
        {(
          [
            ["style", "Style", "pen"],
            ["layers", "Layers", "layers"],
            ["image", "Image", "sliders"],
            ["effects", "Effects", "sparkles"],
          ] as [Tab, string, string][]
        ).map(([id, label, icon]) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={`flex-1 py-2 flex flex-col items-center gap-0.5 text-[9.5px] font-semibold border-b-2 transition-colors ${
              tab === id ? "border-violet-400 text-violet-100" : "border-transparent text-slate-500 hover:text-slate-300"
            }`}
          >
            <Icon name={icon} size={14} />
            {label}
          </button>
        ))}
      </div>
      <div className="flex-1 overflow-y-auto thin-scroll">
        {tab === "style" ? (
          <StylePanel {...panelProps} />
        ) : tab === "layers" ? (
          <LayersPanel {...panelProps} />
        ) : tab === "image" ? (
          <ImagePanel {...panelProps} />
        ) : (
          <EffectsPanel {...panelProps} plugins={plugins} />
        )}
      </div>
    </>
  ) : null;

  const barButton = (label: string, icon: string, title: string, onClick: () => void, extra = "") => (
    <button className={`ghost-btn shrink-0 ${extra}`} onClick={onClick} disabled={Boolean(busy)} title={title}>
      <Icon name={icon} size={13} />
      {narrow ? null : label}
    </button>
  );

  const tinyToggle = (on: boolean, icon: string, title: string, onClick: () => void) => (
    <button
      className={`win-ctrl shrink-0 ${on ? "!bg-violet-500/30 !text-violet-100" : ""}`}
      title={title}
      onClick={onClick}
    >
      <Icon name={icon} size={13} />
    </button>
  );

  return (
    <div className="h-screen w-screen p-1.5 overflow-hidden">
      {pdfSource ? <PdfDialog source={pdfSource} onClose={() => setPdfSource(null)} onDone={() => void loadLibrary()} /> : null}
      <div className="editor-shell glass-panel solid-panel h-full flex flex-col min-h-0">
        {/* ── title bar ── */}
        <div className="drag-handle flex items-center justify-between h-10 px-2 border-b border-white/5 shrink-0" data-tauri-drag-region>
          <div className="flex items-center gap-2.5 min-w-0" data-tauri-drag-region>
            <div className="brand-logo w-6 h-6 rounded-lg flex items-center justify-center shrink-0">
              <Icon name="logo" size={13} strokeWidth={2.3} stroke="#fff" />
            </div>
            {narrow ? null : <span className="text-[12px] font-semibold text-white">SnapPro Editor</span>}
            <span className="text-[10.5px] text-slate-300 truncate max-w-[260px]" title={currentPath}>
              {dirty ? "● " : ""}
              {fileName}
            </span>
            {engine && engine.width > 0 ? (
              <span className="text-[10px] font-mono text-slate-500 shrink-0">
                {engine.width}×{engine.height}
              </span>
            ) : null}
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <button className="win-ctrl" title="Keyboard shortcuts (?)" onClick={() => setShowKeys(true)}>
              <Icon name="keyboard" size={14} />
            </button>
            <button className="win-ctrl" title="Keep on top" onClick={() => void api.setAlwaysOnTop(true, "editor")}>
              <Icon name="pin" size={13} />
            </button>
            <button className="win-ctrl" title="Minimize" onClick={() => void nativeWindow()?.minimize()}>
              <Icon name="minimize" size={13} strokeWidth={2} />
            </button>
            <button className="win-ctrl" title="Maximize / restore" onClick={() => void api.windowAction("maximize")}>
              <Icon name="expand" size={12} strokeWidth={2} />
            </button>
            <button className="win-ctrl close" title="Close" onClick={requestClose}>
              <Icon name="close" size={13} strokeWidth={2} />
            </button>
          </div>
        </div>

        <div className="flex-1 flex min-h-0 relative">
          {/* ── left tool rail ── */}
          <div
            className={`${labels ? "w-[58px]" : "w-[44px]"} shrink-0 border-r border-white/5 bg-black/20 py-1.5 px-1 flex flex-col gap-0.5 overflow-y-auto thin-scroll`}
          >
            {TOOL_GROUPS.map((group, index) => (
              <div key={index} className="flex flex-col gap-0.5">
                {index > 0 ? <div className="divider my-1" /> : null}
                {group.map((item) => (
                  <button
                    key={item.id}
                    className={`tool-btn group ${labels ? "min-h-[42px]" : "min-h-[34px]"} rounded-lg flex flex-col items-center justify-center gap-0.5 ${activeTool === item.id ? "is-active" : ""}`}
                    onClick={() => setTool(item.id)}
                    title={`${item.label}${item.key ? ` (${item.key})` : ""}`}
                  >
                    <Icon name={item.icon} size={labels ? 16 : 17} strokeWidth={1.75} className="tool-icon" />
                    {labels ? <span className="tool-label !text-[8.5px]">{item.label}</span> : null}
                  </button>
                ))}
              </div>
            ))}
            <div className="divider my-1" />
            <button
              className={`tool-btn min-h-[32px] rounded-lg flex flex-col items-center justify-center ${sticky ? "is-active" : ""}`}
              onClick={() => setSticky(!sticky)}
              title="Sticky tools: stay on the same drawing tool after each shape"
            >
              <Icon name={sticky ? "lock" : "unlock"} size={14} className="tool-icon" />
            </button>
            <button
              className="tool-btn min-h-[32px] rounded-lg flex flex-col items-center justify-center"
              onClick={() => void addPicture()}
              title="Add a picture as a layer (or paste one with Ctrl+V)"
            >
              <Icon name="plus" size={14} className="tool-icon" />
            </button>
          </div>

          {/* ── centre: options bar + workspace ── */}
          <div className="flex-1 flex flex-col min-w-0">
            <div className="h-9 border-b border-white/5 flex items-center gap-1 px-2 overflow-x-auto thin-scroll shrink-0">
              <button className="win-ctrl shrink-0" title="Undo (Ctrl+Z)" onClick={() => void engine?.undo()} disabled={!engine?.canUndo}>
                <Icon name="undo" size={14} />
              </button>
              <button className="win-ctrl shrink-0" title="Redo (Ctrl+Y)" onClick={() => void engine?.redo()} disabled={!engine?.canRedo}>
                <Icon name="redo" size={14} />
              </button>
              <div className="w-px h-4 bg-white/10 mx-1 shrink-0" />
              <button className="win-ctrl shrink-0" title="Zoom out (Ctrl -)" onClick={() => zoomBy(1 / 1.2)}>
                <Icon name="zoomOut" size={14} />
              </button>
              <span className="text-[10px] font-mono text-slate-300 w-11 text-center shrink-0">{Math.round((view?.zoom ?? 1) * 100)}%</span>
              <button className="win-ctrl shrink-0" title="Zoom in (Ctrl +)" onClick={() => zoomBy(1.2)}>
                <Icon name="zoomIn" size={14} />
              </button>
              <button
                className="win-ctrl shrink-0"
                title="Fit to window (Ctrl 0)"
                onClick={() => {
                  userZoomed.current = false;
                  engine?.fit();
                }}
              >
                <Icon name="fullscreen" size={13} />
              </button>
              <button
                className="win-ctrl shrink-0"
                title="Actual size 100% (Ctrl 1)"
                onClick={() => {
                  userZoomed.current = true;
                  engine?.actualSize();
                }}
              >
                <span className="text-[9px] font-bold">1:1</span>
              </button>
              <div className="w-px h-4 bg-white/10 mx-1 shrink-0" />
              <button className="win-ctrl shrink-0" title="Rotate left" onClick={() => engine?.rotate90(false)}>
                <Icon name="rotateCcw" size={13} />
              </button>
              <button className="win-ctrl shrink-0" title="Rotate right" onClick={() => engine?.rotate90(true)}>
                <Icon name="rotateCw" size={13} />
              </button>
              <button className="win-ctrl shrink-0" title="Flip picture horizontally" onClick={() => engine?.flip("x")}>
                <Icon name="flipH" size={13} />
              </button>
              <button className="win-ctrl shrink-0" title="Flip picture vertically" onClick={() => engine?.flip("y")}>
                <Icon name="flipV" size={13} />
              </button>
              <div className="w-px h-4 bg-white/10 mx-1 shrink-0" />
              <button className="win-ctrl shrink-0" title="Duplicate (Ctrl+D)" onClick={() => engine?.duplicateSelected()} disabled={selected.length === 0}>
                <Icon name="copy" size={13} />
              </button>
              <button className="win-ctrl shrink-0" title="Delete selection (Del)" onClick={() => engine?.deleteSelected()} disabled={selected.length === 0}>
                <Icon name="trash" size={13} />
              </button>
              <div className="w-px h-4 bg-white/10 mx-1 shrink-0" />
              {tinyToggle(snap, "magnet", "Snap to edges and other items (hold Alt to skip)", () => setSnap(!snap))}
              {tinyToggle(grid, "grid", "Show a grid (G)", () => setGrid(!grid))}
              <button
                className="win-ctrl shrink-0"
                title="Trim away a plain border around the picture"
                onClick={() => {
                  if (!engine) return;
                  const done = engine.autoCrop();
                  toast(done ? "Border trimmed" : "No plain border found", done ? "success" : "info");
                  userZoomed.current = false;
                }}
              >
                <Icon name="trim" size={13} />
              </button>

              {tool === "crop" ? (
                <>
                  <div className="w-px h-4 bg-white/10 mx-1 shrink-0" />
                  {RATIOS.map((ratio) => (
                    <IconToggle key={ratio.label} on={cropRatio === ratio.value} text={ratio.label} title={`Crop ratio ${ratio.label}`} onClick={() => applyRatio(ratio.value)} />
                  ))}
                  {cropBox.current ? (
                    <>
                      {(["left", "top", "width", "height"] as const).map((field) => (
                        <label key={field} className="flex items-center gap-1 text-[9px] text-slate-500 shrink-0">
                          {field === "left" ? "X" : field === "top" ? "Y" : field === "width" ? "W" : "H"}
                          <NumberBox value={cropBox.current[field]} width={54} onChange={(value) => setCropField(field, value)} />
                        </label>
                      ))}
                    </>
                  ) : null}
                  <SmallButton primary onClick={applyCrop}>
                    Apply crop
                  </SmallButton>
                  <SmallButton onClick={() => setTool("select")}>Cancel</SmallButton>
                </>
              ) : null}

              <div className="ml-auto pl-2 shrink-0">
                <button
                  className={`win-ctrl ${panelOpen ? "!bg-violet-500/30 !text-violet-100" : ""}`}
                  title={panelOpen ? "Hide the side panel" : "Show the side panel (style, layers, image, effects)"}
                  onClick={() => setPanelOpen(!panelOpen)}
                >
                  <Icon name="panel" size={14} />
                </button>
              </div>
            </div>

            <div ref={host} className="relative flex-1 min-h-0 overflow-hidden bg-[#232838]" style={{ touchAction: "none" }}>
              {paper ? (
                <div
                  className="absolute checkerboard pointer-events-none"
                  style={{ ...paper, boxShadow: "0 8px 40px rgba(0,0,0,0.7), 0 0 0 1px rgba(255,255,255,0.08)" }}
                />
              ) : null}
              {/* Fabric re-parents its canvas, so it gets a wrapper React never touches. */}
              <div className="absolute inset-0">
                <canvas ref={canvasElement} />
              </div>
              {paper && grid ? (
                <div
                  className="absolute pointer-events-none"
                  style={{
                    ...paper,
                    backgroundImage:
                      "linear-gradient(to right, rgba(255,255,255,0.22) 1px, transparent 1px), linear-gradient(to bottom, rgba(255,255,255,0.22) 1px, transparent 1px)",
                    backgroundSize: `${50 * (view?.zoom ?? 1)}px ${50 * (view?.zoom ?? 1)}px`,
                  }}
                />
              ) : null}
              {view
                ? guides.x.map((gx) => (
                    <div key={`gx${gx}`} className="absolute top-0 bottom-0 w-px bg-fuchsia-400 pointer-events-none" style={{ left: view.x + gx * view.zoom }} />
                  ))
                : null}
              {view
                ? guides.y.map((gy) => (
                    <div key={`gy${gy}`} className="absolute left-0 right-0 h-px bg-fuchsia-400 pointer-events-none" style={{ top: view.y + gy * view.zoom }} />
                  ))
                : null}
              {loadError ? (
                <div className="absolute inset-0 flex items-center justify-center text-[12px] text-rose-300">{loadError}</div>
              ) : null}
            </div>
          </div>

          {/* ── side panel: docked when wide, a drawer when the window is narrow ── */}
          {panelOpen ? (
            <>
              {compact ? <div className="absolute inset-0 bg-black/40 z-20" onClick={() => setPanelOpen(false)} /> : null}
              <div
                className={`${compact ? "absolute right-0 top-0 bottom-0 z-30 shadow-2xl w-[min(300px,86vw)]" : "w-[284px] shrink-0"} border-l border-white/5 bg-[#0e1019] flex flex-col min-h-0`}
              >
                {panelNode}
              </div>
            </>
          ) : null}
        </div>

        {/* ── bottom bar ── */}
        <div className="h-12 border-t border-white/5 flex items-center gap-1.5 px-2.5 shrink-0 relative">
          <button className="primary-btn flex items-center gap-1.5 shrink-0" onClick={() => void saveOver()} disabled={Boolean(busy)} title="Overwrite the original file (Ctrl+S)">
            <Icon name="save" size={13} />
            Save
          </button>
          {barButton("Save copy", "plus", "Keep the original and save a new copy", () => void saveNew())}
          {barButton("Save as…", "folder", "Choose a name and place (Ctrl+Shift+S)", () => void saveAs())}
          {barButton("Copy", "copy", "Copy the picture to the clipboard (Ctrl+C with nothing selected)", () => void copy())}
          <div className="relative shrink-0">
            <button className="ghost-btn" onClick={() => setExportMenu(!exportMenu)} disabled={Boolean(busy)} title="Export a copy as PNG, JPG, WebP or PDF">
              <Icon name="download" size={13} />
              {narrow ? null : "Export"}
              <Icon name="chevronUp" size={11} />
            </button>
            {exportMenu ? (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setExportMenu(false)} />
                <div className="absolute bottom-10 left-0 z-50 glass-panel solid-panel rounded-xl p-1 w-[150px] shadow-2xl">
                  {(
                    [
                      ["PNG image", () => exportAs("png")],
                      ["JPG image", () => exportAs("jpg")],
                      ["WebP image", () => exportAs("webp")],
                      ["PDF page", () => exportPdf()],
                    ] as [string, () => void][]
                  ).map(([label, action]) => (
                    <button
                      key={label}
                      className="w-full text-left px-2.5 py-1.5 rounded-lg text-[11px] text-slate-200 hover:bg-violet-500/20"
                      onClick={() => {
                        setExportMenu(false);
                        action();
                      }}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </>
            ) : null}
          </div>

          <div className="flex-1 min-w-0 flex items-center justify-end gap-3 pl-2">
            {notice ? (
              <span
                className={`flex items-center gap-1.5 text-[11px] font-medium truncate max-w-full rounded-lg px-2.5 py-1 border ${
                  notice.kind === "error"
                    ? "text-rose-200 bg-rose-500/15 border-rose-400/40"
                    : notice.kind === "busy"
                      ? "text-violet-100 bg-violet-500/15 border-violet-400/40"
                      : "text-emerald-200 bg-emerald-500/15 border-emerald-400/40"
                }`}
              >
                <Icon name={notice.kind === "busy" ? "loading" : notice.kind === "error" ? "alert" : "check"} size={12} className={notice.kind === "busy" ? "spin" : ""} />
                <span className="truncate">{notice.text}</span>
              </span>
            ) : null}
            {narrow ? null : (
              <span className="text-[10px] font-mono text-slate-500 shrink-0">
                {cursor ? `${cursor.x}, ${cursor.y}` : ""} · {engine?.annotations().length ?? 0} layer(s)
              </span>
            )}
          </div>
        </div>
      </div>

      {/* ── unsaved-changes dialog ── */}
      {closing || pendingPath ? (
        <div className="fixed inset-0 z-[300] bg-black/60 flex items-center justify-center">
          <div className="glass-panel solid-panel rounded-2xl p-5 w-[340px] max-w-[92vw]">
            <div className="text-[13px] font-semibold text-white mb-1">Unsaved changes</div>
            <div className="text-[11px] text-slate-400 mb-4 leading-relaxed">
              {closing ? "Close the editor" : `Open ${pendingPath?.split(/[\\/]/).pop()}`} without saving {fileName}?
            </div>
            <div className="flex flex-wrap gap-2 justify-end">
              <SmallButton
                onClick={() => {
                  setClosing(false);
                  setPendingPath(null);
                }}
              >
                Keep editing
              </SmallButton>
              <SmallButton
                onClick={() => {
                  const next = pendingPath;
                  setClosing(false);
                  setPendingPath(null);
                  if (next) void loadPath(next);
                  else onClose();
                }}
              >
                Discard
              </SmallButton>
              <SmallButton
                primary
                onClick={async () => {
                  if (!engine) return;
                  try {
                    await api.overwriteImage(engine.dataUrl("png"), currentPath);
                    engine.markSaved();
                    await loadLibrary();
                  } catch (error) {
                    toast(api.errorMessage(error), "error");
                    return;
                  }
                  const next = pendingPath;
                  setClosing(false);
                  setPendingPath(null);
                  if (next) void loadPath(next);
                  else onClose();
                }}
              >
                Save
              </SmallButton>
            </div>
          </div>
        </div>
      ) : null}

      {/* ── keyboard shortcuts ── */}
      {showKeys ? (
        <div className="fixed inset-0 z-[300] bg-black/60 flex items-center justify-center p-4" onClick={() => setShowKeys(false)}>
          <div className="glass-panel solid-panel rounded-2xl p-5 w-[520px] max-w-full max-h-full overflow-y-auto thin-scroll" onClick={(event) => event.stopPropagation()}>
            <div className="flex items-center justify-between mb-3">
              <div className="text-[13px] font-semibold text-white">Keyboard shortcuts</div>
              <button className="win-ctrl" onClick={() => setShowKeys(false)}>
                <Icon name="close" size={13} />
              </button>
            </div>
            <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-[11px]">
              {SHORTCUTS.map(([keys, what]) => (
                <div key={keys} className="flex items-center justify-between gap-2 py-0.5 border-b border-white/5">
                  <span className="text-slate-300">{what}</span>
                  <span className="kbd !ml-0 whitespace-nowrap">{keys}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

const SHORTCUTS: [string, string][] = [
  ["V / H / C", "Select / Pan / Crop"],
  ["A / L", "Arrow / Line"],
  ["R / O", "Box / Oval"],
  ["P / K / M", "Pen / Marker pen / Highlight"],
  ["T / Q / N / S", "Text / Callout / Step / Stamp"],
  ["B / F / Z", "Blur / Focus / Magnify"],
  ["E / I", "Eraser / Colour picker"],
  ["Ctrl Z / Y", "Undo / Redo"],
  ["Ctrl C / X / V", "Copy / Cut / Paste"],
  ["Ctrl D", "Duplicate"],
  ["Ctrl A", "Select all"],
  ["Del", "Delete selection"],
  ["Arrows (+Shift)", "Nudge 1 px (10 px)"],
  ["Ctrl S", "Save"],
  ["Ctrl Shift S", "Save as…"],
  ["Ctrl wheel", "Zoom at pointer"],
  ["Space + drag", "Pan"],
  ["Ctrl 0 / Ctrl 1", "Fit / 100%"],
  ["Shift (drawing)", "Square / 15° angle"],
  ["Alt (moving)", "Ignore snapping"],
  ["[ and ]", "Thinner / thicker line"],
  ["G", "Grid on/off"],
  ["Enter", "Apply crop"],
  ["Esc", "Deselect / leave tool"],
];
