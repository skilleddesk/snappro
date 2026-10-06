/* eslint-disable @typescript-eslint/no-explicit-any */
import { ActiveSelection, Canvas, FabricImage, FabricObject, Point, filters, util, config } from "fabric";
import {
  cropCanvas,
  flipCanvas,
  makeCanvas,
  padCanvas,
  resizeCanvas,
  rotateCanvas90,
  computeLevels,
  fitZoom,
  type Levels,
} from "./effects";
import { SERIALIZED_PROPS, registerCustomShapes, setBaseSource, setSceneSize } from "./shapes";

registerCustomShapes();
// Big screenshots (scrolling captures!) exceed the default GPU texture size;
// Fabric then falls back to the 2D filter backend by itself.
config.configure({ textureSize: 4096 });

export interface Adjustments {
  brightness: number; // -1 .. 1
  contrast: number; // -1 .. 1
  saturation: number; // -1 .. 1
  hue: number; // -1 .. 1 (full turn)
  gamma: number; // 0.2 .. 2.2
  blur: number; // 0 .. 1
  sharpen: boolean;
  grayscale: boolean;
  sepia: boolean;
  invert: boolean;
  levels: Levels | null;
}

export const NO_ADJUSTMENTS: Adjustments = {
  brightness: 0,
  contrast: 0,
  saturation: 0,
  hue: 0,
  gamma: 1,
  blur: 0,
  sharpen: false,
  grayscale: false,
  sepia: false,
  invert: false,
  levels: null,
};

export function hasAdjustments(values: Adjustments): boolean {
  return JSON.stringify(values) !== JSON.stringify(NO_ADJUSTMENTS);
}

/** Fabric filter instances for a set of adjustment values. */
export function buildFilters(values: Adjustments): any[] {
  const list: any[] = [];
  if (values.levels) {
    const { min, max } = values.levels;
    const scale = [0, 1, 2].map((c) => 255 / Math.max(1, max[c] - min[c]));
    const offset = [0, 1, 2].map((c) => (-min[c] * scale[c]) / 255);
    // 4x5 colour matrix: per-channel gain and offset (offsets are 0..1).
    list.push(
      new filters.ColorMatrix({
        matrix: [
          scale[0], 0, 0, 0, offset[0],
          0, scale[1], 0, 0, offset[1],
          0, 0, scale[2], 0, offset[2],
          0, 0, 0, 1, 0,
        ],
      }),
    );
  }
  if (values.brightness) list.push(new filters.Brightness({ brightness: values.brightness }));
  if (values.contrast) list.push(new filters.Contrast({ contrast: values.contrast }));
  if (values.saturation) list.push(new filters.Saturation({ saturation: values.saturation }));
  if (values.hue) list.push(new filters.HueRotation({ rotation: values.hue }));
  if (values.gamma !== 1) list.push(new filters.Gamma({ gamma: [values.gamma, values.gamma, values.gamma] }));
  if (values.sharpen) {
    list.push(new filters.Convolute({ matrix: [0, -1, 0, -1, 5, -1, 0, -1, 0] }));
  }
  if (values.blur > 0) list.push(new filters.Blur({ blur: values.blur }));
  if (values.grayscale) list.push(new filters.Grayscale());
  if (values.sepia) list.push(new filters.Sepia());
  if (values.invert) list.push(new filters.Invert());
  return list;
}

interface HistoryEntry {
  width: number;
  height: number;
  baseId: number;
  adjust: Adjustments;
  objects: any[];
}

export interface EngineView {
  zoom: number;
  x: number;
  y: number;
  viewportWidth: number;
  viewportHeight: number;
}

type Listener = () => void;

/** Custom shapes keep a scale of 1 and store their size in width/height. */
const SIZE_BAKED = ["ArrowShape", "RedactShape", "SpotlightShape", "MagnifierShape", "StepBadge"];

export function normalizeScale(object: any) {
  const kind = object?.constructor?.type ?? object?.type;
  if (!SIZE_BAKED.includes(kind) || object.group) return;
  const sx = object.scaleX ?? 1;
  const sy = object.scaleY ?? 1;
  if (sx === 1 && sy === 1) return;
  const width = Math.max(2, object.width * sx);
  const height = Math.max(2, object.height * sy);
  object.set({ width, height, scaleX: 1, scaleY: 1 });
  if (kind === "ArrowShape" && typeof object.syncHeight === "function") object.syncHeight();
  object.setCoords();
}

export class EditorEngine {
  readonly canvas: Canvas;
  base!: FabricImage;
  width = 0;
  height = 0;
  adjust: Adjustments = { ...NO_ADJUSTMENTS };
  interactive: "select" | "erase" | "none" = "select";

  private bases = new Map<number, HTMLCanvasElement>();
  private baseId = 0;
  private stack: HistoryEntry[] = [];
  private index = -1;
  private savedIndex = 0;
  private listeners = new Set<Listener>();
  private restoring = false;
  private viewport = { width: 800, height: 600 };
  private disposed = false;

  constructor(element: HTMLCanvasElement) {
    this.canvas = new Canvas(element, {
      width: 800,
      height: 600,
      selection: true,
      preserveObjectStacking: true,
      stopContextMenu: true,
      fireRightClick: true,
      enableRetinaScaling: true,
      renderOnAddRemove: true,
      selectionColor: "rgba(56,189,248,0.12)",
      selectionBorderColor: "rgba(56,189,248,0.9)",
      selectionLineWidth: 1.2,
    });
    // Friendlier handles than Fabric's defaults.
    Object.assign(FabricObject.ownDefaults, {
      cornerColor: "#0ea5e9",
      cornerStrokeColor: "#ffffff",
      cornerStyle: "circle",
      cornerSize: 11,
      transparentCorners: false,
      borderColor: "rgba(56,189,248,0.95)",
      borderScaleFactor: 1.6,
      padding: 2,
    });

    const changed = () => this.emit();
    this.canvas.on("selection:created", changed);
    this.canvas.on("selection:updated", changed);
    this.canvas.on("selection:cleared", changed);
    this.canvas.on("object:added", changed);
    this.canvas.on("object:removed", changed);
    this.canvas.on("object:modified", (event: any) => {
      const target = event.target;
      if (target?.type === "activeselection") target.getObjects().forEach(normalizeScale);
      else normalizeScale(target);
      this.commit();
    });
    this.canvas.on("object:moving", (event: any) => this.onMoving(event));
    this.canvas.on("mouse:up", () => {
      if (this.guides.x.length || this.guides.y.length) {
        this.guides = { x: [], y: [] };
        this.emit();
      }
    });
    this.canvas.on("object:scaling", (event: any) => {
      const target = event.target;
      if (target && target.type !== "activeselection") {
        normalizeScale(target);
      }
    });
    this.canvas.on("path:created", (event: any) => {
      const path = event.path;
      if (path) path.set({ objectCaching: false });
      this.commit();
    });
    this.canvas.on("text:editing:exited", (event: any) => {
      const target = event.target;
      if (target && typeof target.text === "string" && target.text.trim() === "") {
        this.canvas.remove(target);
      }
      this.commit();
    });
  }

  // ── events ───────────────────────────────────────────────────────────────
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit() {
    if (this.disposed) return;
    this.listeners.forEach((listener) => listener());
  }

  // ── scene ────────────────────────────────────────────────────────────────
  /** Replace the picture (and optionally keep the existing annotations). */
  private installBase(bitmap: HTMLCanvasElement, adjust: Adjustments, id?: number) {
    if (this.base) this.canvas.remove(this.base);
    const baseId = id ?? ++this.baseId;
    this.bases.set(baseId, bitmap);
    this.currentBaseId = baseId;
    this.width = bitmap.width;
    this.height = bitmap.height;
    const image = new FabricImage(bitmap, {
      left: 0,
      top: 0,
      selectable: false,
      evented: false,
      hasControls: false,
      hoverCursor: "default",
      objectCaching: false,
    } as any);
    (image as any).snapRole = "base";
    this.base = image;
    this.adjust = { ...adjust };
    this.canvas.add(image);
    this.canvas.sendObjectToBack(image);
    this.applyFilterList();
    setBaseSource(this.baseElement());
    setSceneSize(this.width, this.height);
  }
  private currentBaseId = 0;

  /** The (filtered) bitmap currently shown as the picture. */
  private baseElement(): HTMLCanvasElement | HTMLImageElement {
    return this.base.getElement() as any;
  }

  private applyFilterList() {
    (this.base as any).filters = buildFilters(this.adjust);
    this.base.applyFilters();
    setBaseSource(this.baseElement());
    this.canvas.requestRenderAll();
  }

  /** Load a fresh picture, dropping every annotation and the undo history. */
  loadPicture(bitmap: HTMLCanvasElement) {
    this.restoring = true;
    this.canvas.getObjects().slice().forEach((object) => this.canvas.remove(object));
    this.bases.clear();
    this.installBase(bitmap, { ...NO_ADJUSTMENTS });
    this.restoring = false;
    this.stack = [];
    this.index = -1;
    this.commit();
    this.savedIndex = this.index;
    this.fit();
  }

  annotations(): FabricObject[] {
    return this.canvas.getObjects().filter((object: any) => object !== this.base && !object.snapTemp);
  }

  // ── undo / redo ──────────────────────────────────────────────────────────
  private snapshot(): HistoryEntry {
    return {
      width: this.width,
      height: this.height,
      baseId: this.currentBaseId,
      adjust: { ...this.adjust },
      objects: this.annotations().map((object) => object.toObject(SERIALIZED_PROPS as string[])),
    };
  }

  commit() {
    if (this.restoring || this.disposed) return;
    const entry = this.snapshot();
    const last = this.stack[this.index];
    if (last && JSON.stringify(last) === JSON.stringify(entry)) {
      this.emit();
      return;
    }
    const next = [...this.stack.slice(0, this.index + 1), entry];
    const dropped = Math.max(0, next.length - 60);
    // A saved state that was cut off (redo branch) or aged out is gone: stay dirty.
    if (this.savedIndex > this.index) this.savedIndex = -1;
    this.savedIndex -= dropped;
    this.stack = next.slice(dropped);
    this.index = this.stack.length - 1;
    // Forget pictures no history entry points at any more.
    const used = new Set(this.stack.map((item) => item.baseId));
    for (const id of [...this.bases.keys()]) if (!used.has(id)) this.bases.delete(id);
    this.emit();
  }

  /** True when the picture differs from what was last saved or loaded. */
  get dirty() {
    return this.index !== this.savedIndex;
  }

  markSaved() {
    this.savedIndex = this.index;
    this.emit();
  }

  get canUndo() {
    return this.index > 0;
  }
  get canRedo() {
    return this.index < this.stack.length - 1;
  }

  async undo() {
    if (!this.canUndo) return;
    this.index -= 1;
    await this.restore(this.stack[this.index]);
  }

  async redo() {
    if (!this.canRedo) return;
    this.index += 1;
    await this.restore(this.stack[this.index]);
  }

  private async restore(entry: HistoryEntry) {
    this.restoring = true;
    try {
      this.canvas.discardActiveObject();
      this.annotations().forEach((object) => this.canvas.remove(object));
      this.canvas.getObjects().filter((o: any) => o.snapTemp).forEach((o) => this.canvas.remove(o));
      const bitmap = this.bases.get(entry.baseId);
      if (bitmap && (entry.baseId !== this.currentBaseId || !this.base)) {
        this.installBase(bitmap, entry.adjust, entry.baseId);
      } else {
        this.adjust = { ...entry.adjust };
        this.applyFilterList();
      }
      const objects = await util.enlivenObjects(entry.objects.map((o) => ({ ...o })));
      objects.forEach((object: any) => this.canvas.add(object));
      this.refreshInteractivity();
      this.canvas.requestRenderAll();
    } finally {
      this.restoring = false;
    }
    this.emit();
  }

  // ── interactivity (which tool is allowed to touch objects) ───────────────
  setInteractive(mode: "select" | "erase" | "none") {
    this.interactive = mode;
    this.refreshInteractivity();
  }

  refreshInteractivity() {
    const mode = this.interactive;
    this.canvas.selection = mode === "select";
    this.canvas.forEachObject((object: any) => {
      if (object === this.base || object.snapTemp) return;
      const locked = Boolean(object.snapLocked);
      object.selectable = mode === "select" && !locked && !object.snapTempLocked;
      object.evented = (mode === "select" && !locked) || mode === "erase";
    });
    if (mode !== "select") this.canvas.discardActiveObject();
    this.canvas.requestRenderAll();
  }

  /** Add an annotation and make it behave like the current tool allows. */
  add(object: any, select = true) {
    object.set({ objectCaching: false });
    this.canvas.add(object);
    this.refreshInteractivity();
    if (select && this.interactive === "select") {
      this.canvas.setActiveObject(object);
    }
    this.canvas.requestRenderAll();
  }

  // ── view (zoom / pan) ────────────────────────────────────────────────────
  get view(): EngineView {
    const v = this.canvas.viewportTransform;
    return { zoom: v[0], x: v[4], y: v[5], viewportWidth: this.viewport.width, viewportHeight: this.viewport.height };
  }

  resizeViewport(width: number, height: number) {
    this.viewport = { width: Math.max(100, width), height: Math.max(100, height) };
    this.canvas.setDimensions({ width: this.viewport.width, height: this.viewport.height });
    this.canvas.requestRenderAll();
    this.emit();
  }

  setView(zoom: number, x: number, y: number) {
    this.canvas.setViewportTransform([zoom, 0, 0, zoom, x, y]);
    // Zoomed in, show real pixels; zoomed out, smooth them.
    (this.base as any).imageSmoothing = zoom < 1.5;
    this.canvas.requestRenderAll();
    this.emit();
  }

  fit() {
    const zoom = fitZoom({ width: this.width, height: this.height }, this.viewport, 56, 1);
    this.setView(zoom, (this.viewport.width - this.width * zoom) / 2, (this.viewport.height - this.height * zoom) / 2);
  }

  actualSize() {
    this.zoomTo(1);
  }

  zoomTo(zoom: number, anchor?: { x: number; y: number }) {
    const next = Math.min(16, Math.max(0.02, zoom));
    const { zoom: current, x, y } = this.view;
    const ax = anchor?.x ?? this.viewport.width / 2;
    const ay = anchor?.y ?? this.viewport.height / 2;
    const sceneX = (ax - x) / current;
    const sceneY = (ay - y) / current;
    this.setView(next, ax - sceneX * next, ay - sceneY * next);
  }

  panBy(dx: number, dy: number) {
    const { zoom, x, y } = this.view;
    this.setView(zoom, x + dx, y + dy);
  }

  // ── rendering / export ───────────────────────────────────────────────────
  /** Everything (picture + annotations) flattened to a canvas at 1:1. */
  renderFlat(): HTMLCanvasElement {
    this.canvas.discardActiveObject();
    // Rendering goes through the viewport, so a zoomed or panned view would be
    // baked into the export. Reset it for the render and put it back after.
    const viewport = this.canvas.viewportTransform.slice() as any;
    this.canvas.viewportTransform = [1, 0, 0, 1, 0, 0];
    try {
      const out = this.canvas.toCanvasElement(1, {
        left: 0,
        top: 0,
        width: this.width,
        height: this.height,
        filter: (object: any) => !object.snapTemp,
      });
      if (out.width === this.width && out.height === this.height) return out;
      // A HiDPI display renders at device resolution: bring it back to 1:1.
      const exact = makeCanvas(this.width, this.height);
      exact.getContext("2d")?.drawImage(out, 0, 0, exact.width, exact.height);
      return exact;
    } finally {
      this.canvas.viewportTransform = viewport;
      this.canvas.requestRenderAll();
    }
  }

  /** The picture alone (adjustments baked in), as an independent canvas. */
  private pictureCopy(): HTMLCanvasElement {
    const out = makeCanvas(this.width, this.height);
    out.getContext("2d")?.drawImage(this.baseElement() as CanvasImageSource, 0, 0, this.width, this.height);
    return out;
  }

  pixelAt(x: number, y: number): { r: number; g: number; b: number; a: number; hex: string } | null {
    const flat = this.renderFlat();
    const px = Math.min(flat.width - 1, Math.max(0, Math.round(x)));
    const py = Math.min(flat.height - 1, Math.max(0, Math.round(y)));
    const data = flat.getContext("2d")?.getImageData(px, py, 1, 1).data;
    if (!data) return null;
    const hex = `#${[data[0], data[1], data[2]].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
    return { r: data[0], g: data[1], b: data[2], a: data[3], hex };
  }

  dataUrl(format: "png" | "jpeg" = "png", quality = 0.92): string {
    const flat = this.renderFlat();
    if (format === "jpeg") {
      const white = makeCanvas(flat.width, flat.height);
      const ctx = white.getContext("2d");
      if (ctx) {
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, white.width, white.height);
        ctx.drawImage(flat, 0, 0);
      }
      return white.toDataURL("image/jpeg", quality);
    }
    return flat.toDataURL("image/png");
  }

  // ── adjustments ──────────────────────────────────────────────────────────
  setAdjustments(patch: Partial<Adjustments>, commit = false) {
    this.adjust = { ...this.adjust, ...patch };
    this.applyFilterList();
    if (commit) this.commit();
    else this.emit();
  }

  resetAdjustments() {
    this.adjust = { ...NO_ADJUSTMENTS };
    this.applyFilterList();
    this.commit();
  }

  autoLevels() {
    const bitmap = this.pictureCopy();
    const data = bitmap.getContext("2d")?.getImageData(0, 0, bitmap.width, bitmap.height).data;
    if (!data) return;
    // Levels are computed on the unfiltered picture so repeating the action is stable.
    const raw = this.bases.get(this.currentBaseId);
    const source = raw?.getContext("2d")?.getImageData(0, 0, raw.width, raw.height).data ?? data;
    this.setAdjustments({ levels: computeLevels(source) }, true);
  }

  // ── geometry (these bake the picture; annotations move with it) ──────────
  private replacePicture(bitmap: HTMLCanvasElement, moveObjects: (object: any) => void) {
    this.restoring = true;
    this.annotations().forEach((object) => {
      moveObjects(object);
      object.setCoords();
    });
    this.installBase(bitmap, { ...NO_ADJUSTMENTS });
    this.restoring = false;
    this.canvas.discardActiveObject();
    this.commit();
    this.fit();
  }

  cropTo(x: number, y: number, w: number, h: number) {
    const rx = Math.max(0, Math.min(this.width - 1, Math.round(x)));
    const ry = Math.max(0, Math.min(this.height - 1, Math.round(y)));
    const rw = Math.max(1, Math.min(this.width - rx, Math.round(w)));
    const rh = Math.max(1, Math.min(this.height - ry, Math.round(h)));
    const bitmap = cropCanvas(this.pictureCopy(), rx, ry, rw, rh);
    this.replacePicture(bitmap, (object) => object.set({ left: object.left - rx, top: object.top - ry }));
  }

  resizeTo(width: number, height: number) {
    const w = Math.max(1, Math.min(16000, Math.round(width)));
    const h = Math.max(1, Math.min(16000, Math.round(height)));
    const sx = w / this.width;
    const sy = h / this.height;
    const bitmap = resizeCanvas(this.pictureCopy(), w, h);
    this.replacePicture(bitmap, (object) => {
      object.set({
        left: object.left * sx,
        top: object.top * sy,
        scaleX: (object.scaleX ?? 1) * sx,
        scaleY: (object.scaleY ?? 1) * sy,
      });
      normalizeScale(object);
    });
  }

  padBy(pad: { top: number; right: number; bottom: number; left: number }, color: string | null) {
    const bitmap = padCanvas(this.pictureCopy(), pad, color);
    this.replacePicture(bitmap, (object) =>
      object.set({ left: object.left + pad.left, top: object.top + pad.top }),
    );
  }

  rotate90(clockwise: boolean) {
    const oldW = this.width;
    const oldH = this.height;
    const bitmap = rotateCanvas90(this.pictureCopy(), clockwise);
    // (x, y) -> (H - y, x) clockwise, (y, W - x) counter-clockwise.
    const matrix: number[] = clockwise ? [0, 1, -1, 0, oldH, 0] : [0, -1, 1, 0, 0, oldW];
    this.replacePicture(bitmap, (object) => this.transformObject(object, matrix));
  }

  flip(axis: "x" | "y") {
    const bitmap = flipCanvas(this.pictureCopy(), axis);
    const matrix = axis === "x" ? [-1, 0, 0, 1, this.width, 0] : [1, 0, 0, -1, 0, this.height];
    this.replacePicture(bitmap, (object) => this.transformObject(object, matrix));
  }

  /** Apply a scene-level matrix to one annotation. */
  private transformObject(object: any, matrix: number[]) {
    const kind = object?.constructor?.type ?? object?.type;
    const quarter = Math.abs(matrix[1]) === 1; // 90 degree turn
    if (["RedactShape", "MagnifierShape", "SpotlightShape"].includes(kind)) {
      // These sample the picture by position, so keep them axis aligned.
      const center = util.transformPoint(
        new Point(object.left + object.width / 2, object.top + object.height / 2),
        matrix as any,
      );
      const w = quarter ? object.height : object.width;
      const h = quarter ? object.width : object.height;
      object.set({ width: w, height: h, left: center.x - w / 2, top: center.y - h / 2 });
      return;
    }
    const current = object.calcTransformMatrix();
    const next = util.multiplyTransformMatrices(matrix as any, current);
    const parts = util.qrDecompose(next);
    const mirrored = parts.scaleY < 0 || parts.scaleX < 0;
    object.set({
      angle: parts.angle,
      scaleX: Math.abs(parts.scaleX),
      scaleY: Math.abs(parts.scaleY),
      skewX: parts.skewX,
      skewY: parts.skewY,
      flipX: parts.scaleX < 0 ? !object.flipX : object.flipX && !mirrored,
      flipY: parts.scaleY < 0 ? !object.flipY : object.flipY && !mirrored,
    });
    object.setPositionByOrigin(new Point(parts.translateX, parts.translateY), "center", "center");
  }

  /** Flatten the scene, run an effect on it, and make the result the new picture. */
  bake(effect: (flat: HTMLCanvasElement) => HTMLCanvasElement) {
    const result = effect(this.renderFlat());
    this.restoring = true;
    this.annotations().forEach((object) => this.canvas.remove(object));
    this.installBase(result, { ...NO_ADJUSTMENTS });
    this.restoring = false;
    this.canvas.discardActiveObject();
    this.commit();
    this.fit();
  }

  /** Use an uploaded or pasted image as a new movable layer. */
  async addImageLayer(source: string | HTMLCanvasElement, at?: { x: number; y: number }) {
    const image: any = await FabricImage.fromURL(
      typeof source === "string" ? source : source.toDataURL("image/png"),
    );
    const maxSide = Math.max(this.width, this.height) * 0.6;
    const scale = Math.min(1, maxSide / Math.max(image.width, image.height));
    image.set({
      scaleX: scale,
      scaleY: scale,
      left: at ? at.x : (this.width - image.width * scale) / 2,
      top: at ? at.y : (this.height - image.height * scale) / 2,
    });
    this.add(image);
    this.commit();
  }

  // ── layer helpers ────────────────────────────────────────────────────────
  moveLayer(object: FabricObject, direction: "up" | "down" | "top" | "bottom") {
    const objects = this.canvas.getObjects();
    const index = objects.indexOf(object);
    if (index < 0) return;
    const last = objects.length - 1;
    const target =
      direction === "up" ? index + 1 : direction === "down" ? index - 1 : direction === "top" ? last : 1;
    // Index 0 is the picture, which always stays at the bottom.
    this.canvas.moveObjectTo(object, Math.max(1, Math.min(last, target)));
    this.commit();
  }

  deleteSelected() {
    const active = this.canvas.getActiveObjects();
    if (!active.length) return;
    this.canvas.discardActiveObject();
    active.forEach((object) => this.canvas.remove(object));
    this.commit();
  }

  duplicateSelected() {
    const active = this.canvas.getActiveObject() as any;
    if (!active || active === this.base) return;
    void active.clone(SERIALIZED_PROPS).then((copy: any) => {
      copy.set({ left: (copy.left ?? 0) + 24, top: (copy.top ?? 0) + 24 });
      this.canvas.discardActiveObject();
      this.add(copy);
      this.commit();
    });
  }

  // ── arranging, snapping, clipboard ───────────────────────────────────────
  snap = true;
  guides: { x: number[]; y: number[] } = { x: [], y: [] };
  private objectClipboard: any[] = [];
  private pasteCount = 0;

  /** Axis aligned box of an object, in picture coordinates. */
  boxOf(object: any): { x: number; y: number; w: number; h: number } {
    const rect = object.getBoundingRect();
    return { x: rect.left, y: rect.top, w: rect.width, h: rect.height };
  }

  /** Move / resize / rotate an object by numbers. Size changes keep the top-left corner. */
  setBox(object: any, box: Partial<{ x: number; y: number; w: number; h: number; angle: number }>) {
    const before = this.boxOf(object);
    if (box.angle !== undefined) {
      const centre = object.getCenterPoint();
      object.set({ angle: box.angle });
      object.setPositionByOrigin(centre, "center", "center");
    }
    const resizing = box.w !== undefined || box.h !== undefined;
    if (resizing) {
      const kind = object?.constructor?.type ?? object?.type;
      const w = Math.max(2, box.w ?? before.w);
      const h = Math.max(2, box.h ?? before.h);
      if (SIZE_BAKED.includes(kind)) {
        object.set(kind === "ArrowShape" ? { width: w } : { width: w, height: h });
        if (kind === "ArrowShape") object.syncHeight?.();
      } else if (kind === "CalloutBox" || kind === "Textbox" || kind === "textbox") {
        object.set({ width: Math.max(40, w) });
        object.initDimensions?.();
      } else {
        const current = this.boxOf(object);
        object.set({
          scaleX: (object.scaleX ?? 1) * (w / Math.max(1, current.w)),
          scaleY: (object.scaleY ?? 1) * (h / Math.max(1, current.h)),
        });
      }
      object.setCoords();
    }
    const now = this.boxOf(object);
    const targetX = box.x ?? (resizing ? before.x : now.x);
    const targetY = box.y ?? (resizing ? before.y : now.y);
    object.set({ left: object.left + (targetX - now.x), top: object.top + (targetY - now.y) });
    object.setCoords();
    this.canvas.requestRenderAll();
    this.emit();
  }

  /** Align the selection to the picture (one object) or to each other (several). */
  align(mode: "left" | "hcenter" | "right" | "top" | "vcenter" | "bottom") {
    const active = this.canvas.getActiveObjects().filter((o: any) => !o.snapTemp);
    if (active.length === 0) return;
    this.canvas.discardActiveObject();
    const boxes = active.map((o) => this.boxOf(o));
    const bounds =
      active.length === 1
        ? { x: 0, y: 0, w: this.width, h: this.height }
        : {
            x: Math.min(...boxes.map((b) => b.x)),
            y: Math.min(...boxes.map((b) => b.y)),
            w: Math.max(...boxes.map((b) => b.x + b.w)) - Math.min(...boxes.map((b) => b.x)),
            h: Math.max(...boxes.map((b) => b.y + b.h)) - Math.min(...boxes.map((b) => b.y)),
          };
    active.forEach((object: any, index) => {
      const b = boxes[index];
      let x = b.x;
      let y = b.y;
      if (mode === "left") x = bounds.x;
      if (mode === "hcenter") x = bounds.x + (bounds.w - b.w) / 2;
      if (mode === "right") x = bounds.x + bounds.w - b.w;
      if (mode === "top") y = bounds.y;
      if (mode === "vcenter") y = bounds.y + (bounds.h - b.h) / 2;
      if (mode === "bottom") y = bounds.y + bounds.h - b.h;
      object.set({ left: object.left + (x - b.x), top: object.top + (y - b.y) });
      object.setCoords();
    });
    this.canvas.setActiveObject(
      active.length > 1 ? new ActiveSelection(active, { canvas: this.canvas }) : active[0],
    );
    this.canvas.requestRenderAll();
    this.commit();
  }

  selectAll() {
    const objects = this.annotations().filter((o: any) => o.selectable !== false && o.visible !== false);
    if (objects.length === 0) return;
    this.setInteractive("select");
    this.canvas.discardActiveObject();
    this.canvas.setActiveObject(
      objects.length === 1 ? objects[0] : new ActiveSelection(objects, { canvas: this.canvas }),
    );
    this.canvas.requestRenderAll();
  }

  /** Copy the selected annotations into the editor clipboard. */
  copySelected(): boolean {
    const active = this.canvas.getActiveObjects().filter((o: any) => !o.snapTemp);
    if (active.length === 0) return false;
    this.canvas.discardActiveObject(); // objects report picture coordinates again
    this.objectClipboard = active.map((object) => object.toObject(SERIALIZED_PROPS as string[]));
    this.pasteCount = 0;
    this.canvas.setActiveObject(
      active.length === 1 ? active[0] : new ActiveSelection(active, { canvas: this.canvas }),
    );
    this.canvas.requestRenderAll();
    return true;
  }

  get hasObjectClipboard() {
    return this.objectClipboard.length > 0;
  }

  async pasteObjects() {
    if (this.objectClipboard.length === 0) return;
    this.pasteCount += 1;
    const offset = 24 * this.pasteCount;
    const objects: any[] = await util.enlivenObjects(this.objectClipboard.map((o) => ({ ...o })));
    this.setInteractive("select");
    this.canvas.discardActiveObject();
    objects.forEach((object) => {
      object.set({ left: object.left + offset, top: object.top + offset });
      this.add(object, false);
    });
    this.canvas.setActiveObject(
      objects.length === 1 ? objects[0] : new ActiveSelection(objects, { canvas: this.canvas }),
    );
    this.commit();
  }

  /** Mirror one annotation on its own (the picture stays put). */
  flipObject(axis: "x" | "y") {
    const object: any = this.canvas.getActiveObject();
    if (!object || object.snapTemp) return;
    object.set(axis === "x" ? { flipX: !object.flipX } : { flipY: !object.flipY });
    object.setCoords();
    this.canvas.requestRenderAll();
    this.commit();
  }

  /** Cut away a plain border (the colour of the top-left pixel). Returns false when there is none. */
  autoCrop(tolerance = 14): boolean {
    const flat = this.renderFlat();
    const ctx = flat.getContext("2d");
    if (!ctx) return false;
    const { width, height } = flat;
    const data = ctx.getImageData(0, 0, width, height).data;
    const bg = [data[0], data[1], data[2], data[3]];
    const differs = (i: number) =>
      Math.abs(data[i] - bg[0]) +
        Math.abs(data[i + 1] - bg[1]) +
        Math.abs(data[i + 2] - bg[2]) +
        Math.abs(data[i + 3] - bg[3]) >
      tolerance;
    let top = height;
    let bottom = -1;
    let left = width;
    let right = -1;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        if (differs((y * width + x) * 4)) {
          if (y < top) top = y;
          if (y > bottom) bottom = y;
          if (x < left) left = x;
          if (x > right) right = x;
        }
      }
    }
    if (bottom < 0 || (top === 0 && left === 0 && right === width - 1 && bottom === height - 1)) return false;
    this.bake((source) => cropCanvas(source, left, top, right - left + 1, bottom - top + 1));
    return true;
  }

  private onMoving(event: any) {
    const target = event.target;
    if (!target || target.snapTemp || !this.snap || event.e?.altKey) {
      if (this.guides.x.length || this.guides.y.length) {
        this.guides = { x: [], y: [] };
        this.emit();
      }
      return;
    }
    const members = new Set<any>(target.type === "activeselection" ? target.getObjects() : [target]);
    const others = this.annotations().filter((o: any) => !members.has(o) && o.visible !== false);
    const xs = [0, this.width / 2, this.width];
    const ys = [0, this.height / 2, this.height];
    others.forEach((o: any) => {
      const b = this.boxOf(o);
      xs.push(b.x, b.x + b.w / 2, b.x + b.w);
      ys.push(b.y, b.y + b.h / 2, b.y + b.h);
    });
    const box = this.boxOf(target);
    const threshold = 7 / Math.max(0.05, this.view.zoom);
    const best = (points: number[], edges: number[]) => {
      let delta = 0;
      let line: number | null = null;
      let distance = threshold;
      for (const edge of edges) {
        for (const point of points) {
          const d = point - edge;
          if (Math.abs(d) < distance) {
            distance = Math.abs(d);
            delta = d;
            line = point;
          }
        }
      }
      return { delta, line };
    };
    const sx = best(xs, [box.x, box.x + box.w / 2, box.x + box.w]);
    const sy = best(ys, [box.y, box.y + box.h / 2, box.y + box.h]);
    if (sx.line !== null || sy.line !== null) {
      target.set({ left: target.left + sx.delta, top: target.top + sy.delta });
      target.setCoords();
    }
    this.guides = { x: sx.line !== null ? [sx.line] : [], y: sy.line !== null ? [sy.line] : [] };
    this.emit();
  }

  dispose() {
    this.disposed = true;
    this.listeners.clear();
    setBaseSource(null);
    void this.canvas.dispose();
  }
}
