/* eslint-disable @typescript-eslint/no-explicit-any */
import { FabricObject, Textbox, classRegistry, util } from "fabric";

/**
 * Custom annotation objects for the editor.
 *
 * Fabric's own shapes cannot express an arrow that keeps its head shape while
 * it is stretched, or a "blur whatever is underneath me" region, so these small
 * subclasses draw themselves. They are registered with Fabric's class registry
 * so they survive the undo/redo JSON round trip.
 */

// The base typings are very strict about constructor options; the editor only
// ever passes plain objects, so the classes extend an `any`-typed base.
const Base: any = FabricObject;
const TextBase: any = Textbox;

/** Source bitmap the redaction / magnifier objects sample from. */
let baseSource: CanvasImageSource | null = null;
/** Size of the image area, used by the spotlight to clip its dimming layer. */
let sceneSize = { width: 0, height: 0 };

export function setBaseSource(source: CanvasImageSource | null) {
  baseSource = source;
}
export function setSceneSize(width: number, height: number) {
  sceneSize = { width, height };
}

export type ArrowHead = "triangle" | "open" | "none" | "both" | "circle";
export type RedactMode = "blur" | "pixelate" | "solid";

// ---------------------------------------------------------------------------
// Arrow / line
// ---------------------------------------------------------------------------

export class ArrowShape extends Base {
  static type = "ArrowShape";
  declare lineColor: string;
  declare thickness: number;
  declare headStyle: ArrowHead;
  declare dashed: boolean;

  constructor(options: any = {}) {
    super({
      originX: "left",
      originY: "center",
      objectCaching: false,
      lineColor: "#ef4444",
      thickness: 5,
      headStyle: "triangle",
      dashed: false,
      width: 120,
      height: 28,
      lockScalingFlip: true,
      ...options,
    });
    // Only the two ends and the rotate handle make sense for an arrow.
    this.setControlsVisibility({ mt: false, mb: false, tl: false, tr: false, bl: false, br: false });
  }

  headSize() {
    const t = this.thickness || 4;
    return { length: Math.max(14, t * 3.8), half: Math.max(8, t * 2) };
  }

  /** Keep the bounding box tall enough for the head whenever it changes. */
  syncHeight() {
    const { half } = this.headSize();
    this.set({ height: half * 2 + 4 });
  }

  _render(ctx: CanvasRenderingContext2D) {
    const w = Math.max(2, this.width);
    const t = this.thickness || 4;
    const { length: head, half } = this.headSize();
    const style: ArrowHead = this.headStyle ?? "triangle";
    const x0 = -w / 2;
    const x1 = w / 2;
    const filled = style === "triangle" || style === "both";
    const startHead = style === "both";

    ctx.save();
    ctx.strokeStyle = this.lineColor;
    ctx.fillStyle = this.lineColor;
    ctx.lineWidth = t;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    if (this.dashed) ctx.setLineDash([t * 2.6, t * 2]);

    const shaftStart = startHead ? x0 + head * 0.7 : x0;
    const shaftEnd = filled || style === "circle" ? x1 - head * 0.7 : x1;
    ctx.beginPath();
    ctx.moveTo(shaftStart, 0);
    ctx.lineTo(Math.max(shaftStart, shaftEnd), 0);
    ctx.stroke();
    ctx.setLineDash([]);

    const triangle = (tipX: number, dir: 1 | -1) => {
      ctx.beginPath();
      ctx.moveTo(tipX, 0);
      ctx.lineTo(tipX - dir * head, -half);
      ctx.lineTo(tipX - dir * head, half);
      ctx.closePath();
      ctx.fill();
    };

    if (filled) {
      triangle(x1, 1);
      if (startHead) triangle(x0, -1);
    } else if (style === "open") {
      ctx.beginPath();
      ctx.moveTo(x1 - head, -half);
      ctx.lineTo(x1, 0);
      ctx.lineTo(x1 - head, half);
      ctx.stroke();
    } else if (style === "circle") {
      ctx.beginPath();
      ctx.arc(x1 - half * 0.55, 0, half * 0.6, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  toObject(propertiesToInclude: string[] = []) {
    return super.toObject([...propertiesToInclude, "lineColor", "thickness", "headStyle", "dashed"]);
  }
}

// ---------------------------------------------------------------------------
// Redaction: blur / pixelate / solid block over the picture underneath
// ---------------------------------------------------------------------------

export class RedactShape extends Base {
  static type = "RedactShape";
  declare mode: RedactMode;
  declare strength: number;
  declare blockColor: string;

  constructor(options: any = {}) {
    super({
      objectCaching: false,
      mode: "pixelate",
      strength: 12,
      blockColor: "#000000",
      width: 160,
      height: 80,
      fill: "rgba(0,0,0,0)",
      stroke: "rgba(167,139,250,0.9)",
      strokeWidth: 0,
      lockRotation: true,
      ...options,
    });
    this.setControlsVisibility({ mtr: false });
  }

  _render(ctx: CanvasRenderingContext2D) {
    const w = Math.max(1, this.width);
    const h = Math.max(1, this.height);
    const source = baseSource;
    if (this.mode === "solid" || !source) {
      ctx.fillStyle = this.blockColor || "#000";
      ctx.fillRect(-w / 2, -h / 2, w, h);
      return;
    }
    // Local (0,0) is the box centre; the box sits at (left, top) in the image.
    const sx = this.left;
    const sy = this.top;
    ctx.save();
    ctx.beginPath();
    ctx.rect(-w / 2, -h / 2, w, h);
    ctx.clip();

    if (this.mode === "pixelate") {
      const cell = Math.max(2, this.strength);
      const tw = Math.max(1, Math.round(w / cell));
      const th = Math.max(1, Math.round(h / cell));
      const tiny = document.createElement("canvas");
      tiny.width = tw;
      tiny.height = th;
      const tctx = tiny.getContext("2d");
      if (tctx) {
        tctx.imageSmoothingEnabled = true;
        tctx.drawImage(source, sx, sy, w, h, 0, 0, tw, th);
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(tiny, 0, 0, tw, th, -w / 2, -h / 2, w, h);
      }
    } else {
      const radius = Math.max(2, this.strength);
      const hasFilter = typeof (ctx as any).filter === "string";
      if (hasFilter) {
        // Sample a margin around the box so the edges blur against real
        // pixels instead of fading to transparent.
        const m = radius * 3;
        (ctx as any).filter = `blur(${radius}px)`;
        ctx.drawImage(source, sx - m, sy - m, w + m * 2, h + m * 2, -w / 2 - m, -h / 2 - m, w + m * 2, h + m * 2);
        (ctx as any).filter = "none";
      } else {
        // WebKit has no canvas filter: shrink and enlarge twice for a soft blur.
        const f = Math.max(2, radius / 2);
        let cw = Math.max(1, Math.round(w / f));
        let ch = Math.max(1, Math.round(h / f));
        const a = document.createElement("canvas");
        a.width = cw;
        a.height = ch;
        const actx = a.getContext("2d");
        if (actx) {
          actx.imageSmoothingEnabled = true;
          actx.drawImage(source, sx, sy, w, h, 0, 0, cw, ch);
          cw = Math.max(1, Math.round(cw / 2));
          ch = Math.max(1, Math.round(ch / 2));
          const b = document.createElement("canvas");
          b.width = cw;
          b.height = ch;
          b.getContext("2d")?.drawImage(a, 0, 0, a.width, a.height, 0, 0, cw, ch);
          ctx.imageSmoothingEnabled = true;
          ctx.drawImage(b, 0, 0, cw, ch, -w / 2, -h / 2, w, h);
        }
      }
    }
    ctx.restore();
  }

  toObject(propertiesToInclude: string[] = []) {
    return super.toObject([...propertiesToInclude, "mode", "strength", "blockColor"]);
  }
}

// ---------------------------------------------------------------------------
// Spotlight (dim everything but one area). Also used as the crop frame.
// ---------------------------------------------------------------------------

export class SpotlightShape extends Base {
  static type = "SpotlightShape";
  declare shape: "rect" | "ellipse";
  declare dim: number;
  declare ring: string;
  declare cornerRadius: number;

  constructor(options: any = {}) {
    super({
      objectCaching: false,
      shape: "rect",
      dim: 0.7,
      ring: "#a78bfa",
      cornerRadius: 12,
      width: 240,
      height: 140,
      fill: "rgba(0,0,0,0)",
      ...options,
    });
  }

  _render(ctx: CanvasRenderingContext2D) {
    const w = this.width;
    const h = this.height;
    const matrix = this.calcTransformMatrix();
    const inverse = util.invertTransform(matrix);

    ctx.save();
    ctx.beginPath();
    // World-space rectangle covering the picture...
    ctx.transform(inverse[0], inverse[1], inverse[2], inverse[3], inverse[4], inverse[5]);
    ctx.rect(0, 0, sceneSize.width || 1e5, sceneSize.height || 1e5);
    // ...with the object-space hole punched through it (even-odd fill).
    ctx.transform(matrix[0], matrix[1], matrix[2], matrix[3], matrix[4], matrix[5]);
    this.tracePath(ctx, w, h);
    ctx.fillStyle = `rgba(2, 4, 12, ${this.dim})`;
    ctx.fill("evenodd");
    ctx.restore();

    if (this.ring) {
      ctx.save();
      ctx.beginPath();
      this.tracePath(ctx, w, h);
      ctx.strokeStyle = this.ring;
      ctx.lineWidth = 2.5;
      ctx.stroke();
      ctx.restore();
    }
  }

  tracePath(ctx: CanvasRenderingContext2D, w: number, h: number) {
    if (this.shape === "ellipse") {
      ctx.ellipse(0, 0, w / 2, h / 2, 0, 0, Math.PI * 2);
    } else {
      const r = Math.min(this.cornerRadius || 0, w / 2, h / 2);
      const x = -w / 2;
      const y = -h / 2;
      ctx.moveTo(x + r, y);
      ctx.arcTo(x + w, y, x + w, y + h, r);
      ctx.arcTo(x + w, y + h, x, y + h, r);
      ctx.arcTo(x, y + h, x, y, r);
      ctx.arcTo(x, y, x + w, y, r);
      ctx.closePath();
    }
  }

  toObject(propertiesToInclude: string[] = []) {
    return super.toObject([...propertiesToInclude, "shape", "dim", "ring", "cornerRadius"]);
  }
}

// ---------------------------------------------------------------------------
// Magnifier loupe
// ---------------------------------------------------------------------------

export class MagnifierShape extends Base {
  static type = "MagnifierShape";
  declare zoom: number;
  declare ringColor: string;
  declare round: boolean;

  constructor(options: any = {}) {
    super({
      objectCaching: false,
      zoom: 2,
      ringColor: "#ffffff",
      round: true,
      width: 170,
      height: 170,
      lockRotation: true,
      ...options,
    });
  }

  _render(ctx: CanvasRenderingContext2D) {
    const w = this.width;
    const h = this.height;
    const source = baseSource;
    ctx.save();
    ctx.beginPath();
    if (this.round) ctx.ellipse(0, 0, w / 2, h / 2, 0, 0, Math.PI * 2);
    else ctx.rect(-w / 2, -h / 2, w, h);
    ctx.clip();
    if (source) {
      const z = Math.max(1, this.zoom);
      const cx = this.left + w / 2;
      const cy = this.top + h / 2;
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(source, cx - w / z / 2, cy - h / z / 2, w / z, h / z, -w / 2, -h / 2, w, h);
    }
    ctx.restore();
    ctx.save();
    ctx.beginPath();
    if (this.round) ctx.ellipse(0, 0, w / 2, h / 2, 0, 0, Math.PI * 2);
    else ctx.rect(-w / 2, -h / 2, w, h);
    ctx.lineWidth = 4;
    ctx.strokeStyle = this.ringColor;
    ctx.stroke();
    ctx.restore();
  }

  toObject(propertiesToInclude: string[] = []) {
    return super.toObject([...propertiesToInclude, "zoom", "ringColor", "round"]);
  }
}

// ---------------------------------------------------------------------------
// Numbered step badge
// ---------------------------------------------------------------------------

export class StepBadge extends Base {
  static type = "StepBadge";
  declare value: number;
  declare badgeColor: string;
  declare textColor: string;

  constructor(options: any = {}) {
    super({
      objectCaching: false,
      value: 1,
      badgeColor: "#ef4444",
      textColor: "#ffffff",
      width: 44,
      height: 44,
      lockUniScaling: true,
      ...options,
    });
    this.setControlsVisibility({ ml: false, mr: false, mt: false, mb: false });
  }

  _render(ctx: CanvasRenderingContext2D) {
    const r = Math.min(this.width, this.height) / 2;
    ctx.save();
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.fillStyle = this.badgeColor;
    ctx.fill();
    ctx.lineWidth = Math.max(2, r * 0.12);
    ctx.strokeStyle = "rgba(255,255,255,0.95)";
    ctx.stroke();
    ctx.fillStyle = this.textColor;
    const text = String(this.value);
    const size = r * (text.length > 2 ? 0.8 : text.length > 1 ? 1.0 : 1.15);
    ctx.font = `700 ${size}px Inter, "Segoe UI", system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(text, 0, size * 0.04);
    ctx.restore();
  }

  toObject(propertiesToInclude: string[] = []) {
    return super.toObject([...propertiesToInclude, "value", "badgeColor", "textColor"]);
  }
}

// ---------------------------------------------------------------------------
// Callout / speech bubble (an editable text box with a rounded background)
// ---------------------------------------------------------------------------

export type CalloutTail = "none" | "bl" | "br" | "tl" | "tr";

export class CalloutBox extends TextBase {
  static type = "CalloutBox";
  declare boxFill: string;
  declare boxStroke: string;
  declare boxStrokeWidth: number;
  declare boxRadius: number;
  declare boxPad: number;
  declare tail: CalloutTail;

  constructor(text: string, options: any = {}) {
    super(text, {
      boxFill: "#fffbe6",
      boxStroke: "#f59e0b",
      boxStrokeWidth: 3,
      boxRadius: 14,
      boxPad: 14,
      tail: "bl",
      fill: "#1f2937",
      fontSize: 24,
      fontWeight: "600",
      textAlign: "left",
      padding: 14,
      ...options,
    });
  }

  _renderBackground(ctx: CanvasRenderingContext2D) {
    const pad = this.boxPad ?? 14;
    const w = this.width + pad * 2;
    const h = this.height + pad * 2;
    const x = -w / 2;
    const y = -h / 2;
    const r = Math.min(this.boxRadius ?? 12, w / 2, h / 2);
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
    ctx.fillStyle = this.boxFill;
    ctx.fill();
    if (this.boxStrokeWidth > 0) {
      ctx.lineWidth = this.boxStrokeWidth;
      ctx.strokeStyle = this.boxStroke;
      ctx.stroke();
    }
    const tailSize = Math.min(30, h * 0.45);
    if (this.tail && this.tail !== "none") {
      const bottom = this.tail === "bl" || this.tail === "br";
      const left = this.tail === "bl" || this.tail === "tl";
      const baseY = bottom ? y + h : y;
      const dir = bottom ? 1 : -1;
      const startX = left ? x + r + 6 : x + w - r - 6;
      const endX = left ? startX + 24 : startX - 24;
      const tipX = left ? startX - 8 : startX + 8;
      ctx.beginPath();
      ctx.moveTo(startX, baseY);
      ctx.lineTo(tipX, baseY + dir * tailSize);
      ctx.lineTo(endX, baseY);
      ctx.closePath();
      ctx.fillStyle = this.boxFill;
      ctx.fill();
      if (this.boxStrokeWidth > 0) {
        ctx.beginPath();
        ctx.moveTo(startX, baseY);
        ctx.lineTo(tipX, baseY + dir * tailSize);
        ctx.lineTo(endX, baseY);
        ctx.strokeStyle = this.boxStroke;
        ctx.lineWidth = this.boxStrokeWidth;
        ctx.stroke();
        // Hide the seam where the tail meets the bubble.
        ctx.beginPath();
        ctx.moveTo(startX + (left ? 1 : -1), baseY);
        ctx.lineTo(endX + (left ? -1 : 1), baseY);
        ctx.strokeStyle = this.boxFill;
        ctx.lineWidth = this.boxStrokeWidth + 1;
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  toObject(propertiesToInclude: string[] = []) {
    return super.toObject([
      ...propertiesToInclude,
      "boxFill",
      "boxStroke",
      "boxStrokeWidth",
      "boxRadius",
      "boxPad",
      "tail",
    ]);
  }
}

let registered = false;
export function registerCustomShapes() {
  if (registered) return;
  registered = true;
  for (const cls of [ArrowShape, RedactShape, SpotlightShape, MagnifierShape, StepBadge, CalloutBox]) {
    classRegistry.setClass(cls, (cls as any).type);
  }
}

/** Properties that must survive the history JSON round trip. */
export const SERIALIZED_PROPS = [
  "snapName",
  "snapLocked",
  "name",
  "globalCompositeOperation",
];

export function isCustomKind(object: any, kind: string): boolean {
  return object?.constructor?.type === kind || object?.type?.toLowerCase() === kind.toLowerCase();
}

// ---------------------------------------------------------------------------
// Preset polygons: triangle, diamond, star, ... (normal Fabric fill and stroke)
// ---------------------------------------------------------------------------

export type PolyKind = "triangle" | "diamond" | "pentagon" | "hexagon" | "star" | "cross" | "heart" | "pill";

export const POLY_KINDS: { id: PolyKind; label: string }[] = [
  { id: "triangle", label: "Triangle" },
  { id: "diamond", label: "Diamond" },
  { id: "pentagon", label: "Pentagon" },
  { id: "hexagon", label: "Hexagon" },
  { id: "star", label: "Star" },
  { id: "cross", label: "Cross" },
  { id: "heart", label: "Heart" },
  { id: "pill", label: "Pill" },
];

/** Trace the outline of a preset shape centred on (0, 0) inside a w x h box. */
export function tracePoly(ctx: CanvasRenderingContext2D, kind: PolyKind, w: number, h: number) {
  const hw = w / 2;
  const hh = h / 2;
  const polygon = (points: [number, number][]) => {
    ctx.moveTo(points[0][0], points[0][1]);
    for (let i = 1; i < points.length; i += 1) ctx.lineTo(points[i][0], points[i][1]);
    ctx.closePath();
  };
  const regular = (sides: number, rotation = -Math.PI / 2) =>
    polygon(
      Array.from({ length: sides }, (_, i) => {
        const a = rotation + (i * 2 * Math.PI) / sides;
        return [Math.cos(a) * hw, Math.sin(a) * hh] as [number, number];
      }),
    );

  switch (kind) {
    case "triangle":
      polygon([[0, -hh], [hw, hh], [-hw, hh]]);
      break;
    case "diamond":
      polygon([[0, -hh], [hw, 0], [0, hh], [-hw, 0]]);
      break;
    case "pentagon":
      regular(5);
      break;
    case "hexagon":
      regular(6, 0);
      break;
    case "star": {
      const points: [number, number][] = [];
      for (let i = 0; i < 10; i += 1) {
        const a = -Math.PI / 2 + (i * Math.PI) / 5;
        const r = i % 2 === 0 ? 1 : 0.42;
        points.push([Math.cos(a) * hw * r, Math.sin(a) * hh * r]);
      }
      polygon(points);
      break;
    }
    case "cross": {
      const tx = w / 6;
      const ty = h / 6;
      polygon([
        [-tx, -hh], [tx, -hh], [tx, -ty], [hw, -ty], [hw, ty], [tx, ty],
        [tx, hh], [-tx, hh], [-tx, ty], [-hw, ty], [-hw, -ty], [-tx, -ty],
      ]);
      break;
    }
    case "heart":
      ctx.moveTo(0, hh);
      ctx.bezierCurveTo(-w * 0.62, h * 0.12, -w * 0.5, -hh, 0, -h * 0.18);
      ctx.bezierCurveTo(w * 0.5, -hh, w * 0.62, h * 0.12, 0, hh);
      ctx.closePath();
      break;
    case "pill": {
      const r = Math.min(hw, hh);
      ctx.moveTo(-hw + r, -hh);
      ctx.arcTo(hw, -hh, hw, hh, r);
      ctx.arcTo(hw, hh, -hw, hh, r);
      ctx.arcTo(-hw, hh, -hw, -hh, r);
      ctx.arcTo(-hw, -hh, hw, -hh, r);
      ctx.closePath();
      break;
    }
  }
}

export class PolyShape extends Base {
  static type = "PolyShape";
  declare poly: PolyKind;

  constructor(options: any = {}) {
    super({
      objectCaching: false,
      poly: "triangle",
      width: 120,
      height: 120,
      fill: "rgba(0,0,0,0)",
      stroke: "#ef4444",
      strokeWidth: 4,
      strokeUniform: true,
      strokeLineJoin: "round",
      ...options,
    });
  }

  _render(ctx: CanvasRenderingContext2D) {
    ctx.beginPath();
    tracePoly(ctx, this.poly, this.width, this.height);
    this._renderPaintInOrder(ctx);
  }

  toObject(propertiesToInclude: string[] = []) {
    return super.toObject([...propertiesToInclude, "poly"]);
  }
}

classRegistry.setClass(PolyShape, "PolyShape");
