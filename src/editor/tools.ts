/* eslint-disable @typescript-eslint/no-explicit-any */
import { Ellipse, FabricText, Gradient, Rect, Shadow, Textbox } from "fabric";
import type { EditorEngine } from "./engine";
import { hexToRgba, rgbaToHex } from "./color";
import {
  ArrowShape,
  CalloutBox,
  MagnifierShape,
  PolyShape,
  RedactShape,
  SpotlightShape,
  StepBadge,
  type ArrowHead,
  type CalloutTail,
  type PolyKind,
  type RedactMode,
} from "./shapes";

export type Tool =
  | "select"
  | "hand"
  | "crop"
  | "arrow"
  | "line"
  | "rect"
  | "ellipse"
  | "poly"
  | "pen"
  | "highlighter"
  | "marker"
  | "text"
  | "callout"
  | "step"
  | "redact"
  | "spotlight"
  | "magnifier"
  | "stamp"
  | "eraser"
  | "eyedropper";

/** Tools that draw one shape and then hand control back to Select. */
export const ONE_SHOT: Tool[] = [
  "arrow",
  "line",
  "rect",
  "ellipse",
  "poly",
  "marker",
  "text",
  "callout",
  "redact",
  "spotlight",
  "magnifier",
];

export interface ToolStyle {
  stroke: string;
  fill: string | null;
  fillAlpha: number;
  strokeWidth: number;
  opacity: number;
  radius: number;
  shadow: boolean;
  fontFamily: string;
  fontSize: number;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  textAlign: "left" | "center" | "right";
  textBg: string | null;
  arrowHead: ArrowHead;
  dashed: boolean;
  redactMode: RedactMode;
  redactStrength: number;
  blockColor: string;
  spotlightShape: "rect" | "ellipse";
  spotlightDim: number;
  magnifierZoom: number;
  magnifierRound: boolean;
  stamp: string;
  stepValue: number;
  calloutTail: CalloutTail;
  polyKind: PolyKind;
  dashedOutline: boolean;
  gradient: boolean;
  fill2: string;
  blend: string;
  shadowBlur: number;
  textOutline: string | null;
  textOutlineWidth: number;
  charSpacing: number;
  lineHeight: number;
}

export const DEFAULT_STYLE: ToolStyle = {
  stroke: "#ef4444",
  fill: null,
  fillAlpha: 0.25,
  strokeWidth: 4,
  opacity: 1,
  radius: 6,
  shadow: false,
  fontFamily: 'Inter, "Segoe UI", "Noto Sans Bengali", system-ui, sans-serif',
  fontSize: 32,
  bold: true,
  italic: false,
  underline: false,
  textAlign: "left",
  textBg: null,
  arrowHead: "triangle",
  dashed: false,
  redactMode: "pixelate",
  redactStrength: 12,
  blockColor: "#000000",
  spotlightShape: "rect",
  spotlightDim: 0.7,
  magnifierZoom: 2,
  magnifierRound: true,
  stamp: "✅",
  stepValue: 1,
  calloutTail: "bl",
  polyKind: "star",
  dashedOutline: false,
  gradient: false,
  fill2: "#8b5cf6",
  blend: "source-over",
  shadowBlur: 12,
  textOutline: null,
  textOutlineWidth: 3,
  charSpacing: 0,
  lineHeight: 1.16,
};

export const FONT_CHOICES: { label: string; value: string }[] = [
  { label: "Inter / System", value: 'Inter, "Segoe UI", "Noto Sans Bengali", system-ui, sans-serif' },
  { label: "Arial", value: "Arial, Helvetica, sans-serif" },
  { label: "Segoe UI", value: '"Segoe UI", Roboto, sans-serif' },
  { label: "Georgia", value: "Georgia, serif" },
  { label: "Times New Roman", value: '"Times New Roman", Times, serif' },
  { label: "Courier New", value: '"Courier New", Courier, monospace' },
  { label: "Consolas", value: "Consolas, Menlo, monospace" },
  { label: "Impact", value: "Impact, Haettenschweiler, sans-serif" },
  { label: "Comic / Handwriting", value: '"Comic Sans MS", "Segoe Print", cursive' },
  { label: "Nirmala UI (Bangla)", value: '"Nirmala UI", "Noto Sans Bengali", "Kalpurush", sans-serif' },
];

export const STAMPS = ["✅", "❌", "⚠️", "❓", "❗", "👍", "👎", "⭐", "❤️", "🔥", "💡", "🎯", "📌", "🔒", "➡️", "🐞", "🟢", "🔴"];

export { hexToRgba, rgbaToHex };

function shadowFor(on: boolean, blur = 12) {
  return on ? new Shadow({ color: "rgba(0,0,0,0.45)", blur, offsetX: 0, offsetY: Math.round(blur / 3) }) : null;
}

/** Solid colour or a top-to-bottom two colour gradient for a filled shape. */
function fillFor(color: string | null, alpha: number, second: string | null, height: number): any {
  if (!color) return "rgba(0,0,0,0)";
  if (!second) return hexToRgba(color, alpha);
  return new Gradient({
    type: "linear",
    gradientUnits: "pixels",
    coords: { x1: 0, y1: 0, x2: 0, y2: Math.max(1, height) },
    colorStops: [
      { offset: 0, color: hexToRgba(color, alpha) },
      { offset: 1, color: hexToRgba(second, alpha) },
    ],
  } as any);
}

// ---------------------------------------------------------------------------
// Reading / writing the look of an existing object
// ---------------------------------------------------------------------------

export type ObjectKind =
  | "rect"
  | "ellipse"
  | "poly"
  | "arrow"
  | "text"
  | "callout"
  | "step"
  | "redact"
  | "spotlight"
  | "magnifier"
  | "path"
  | "image"
  | "other";

export function kindOf(object: any): ObjectKind {
  const type = object?.constructor?.type ?? object?.type ?? "";
  switch (type) {
    case "ArrowShape":
      return "arrow";
    case "PolyShape":
      return "poly";
    case "RedactShape":
      return "redact";
    case "SpotlightShape":
      return "spotlight";
    case "MagnifierShape":
      return "magnifier";
    case "StepBadge":
      return "step";
    case "CalloutBox":
      return "callout";
    case "Textbox":
    case "textbox":
    case "IText":
    case "itext":
    case "Text":
    case "text":
      return "text";
    case "Rect":
    case "rect":
      return "rect";
    case "Ellipse":
    case "ellipse":
      return "ellipse";
    case "Path":
    case "path":
      return "path";
    case "Image":
    case "image":
      return "image";
    default:
      return "other";
  }
}

/** First and last colour of a Fabric gradient, as hex. */
function gradientColors(fill: any): { a: string | null; b: string | null; alpha: number } | null {
  if (!fill || typeof fill !== "object" || !Array.isArray(fill.colorStops) || fill.colorStops.length < 2) return null;
  const first = fill.colorStops[0].color as string;
  const last = fill.colorStops[fill.colorStops.length - 1].color as string;
  const alpha = String(first).match(/rgba\([^)]*,\s*([\d.]+)\)/);
  return { a: rgbaToHex(first), b: rgbaToHex(last), alpha: alpha ? Number(alpha[1]) : 1 };
}

const FILLED_SHAPES: ObjectKind[] = ["rect", "ellipse", "poly"];

/** Current look of an object, expressed in the same terms as `ToolStyle`. */
export function readStyle(object: any): Partial<ToolStyle> & { kind: ObjectKind } {
  const kind = kindOf(object);
  const out: Partial<ToolStyle> & { kind: ObjectKind } = {
    kind,
    opacity: object.opacity ?? 1,
    shadow: Boolean(object.shadow),
    shadowBlur: object.shadow?.blur ?? 12,
    blend: object.globalCompositeOperation || "source-over",
  };
  if (FILLED_SHAPES.includes(kind)) {
    out.stroke = rgbaToHex(object.stroke) ?? "#ef4444";
    out.strokeWidth = object.strokeWidth ?? 0;
    out.dashedOutline = Array.isArray(object.strokeDashArray) && object.strokeDashArray.length > 0;
    const gradient = gradientColors(object.fill);
    if (gradient) {
      out.gradient = true;
      out.fill = gradient.a;
      out.fill2 = gradient.b ?? "#8b5cf6";
      out.fillAlpha = gradient.alpha;
    } else {
      out.gradient = false;
      out.fill = rgbaToHex(object.fill);
      const alpha = String(object.fill ?? "").match(/rgba\([^)]*,\s*([\d.]+)\)/);
      out.fillAlpha = alpha ? Number(alpha[1]) : 1;
    }
    if (kind === "rect") out.radius = object.rx ?? 0;
    if (kind === "poly") out.polyKind = object.poly;
  }
  switch (kind) {
    case "arrow":
      out.stroke = object.lineColor;
      out.strokeWidth = object.thickness;
      out.arrowHead = object.headStyle;
      out.dashed = object.dashed;
      break;
    case "text":
    case "callout":
      out.stroke = rgbaToHex(object.fill) ?? "#ffffff";
      out.fontFamily = object.fontFamily;
      out.fontSize = object.fontSize;
      out.bold = String(object.fontWeight) === "bold" || Number(object.fontWeight) >= 600;
      out.italic = object.fontStyle === "italic";
      out.underline = Boolean(object.underline);
      out.textAlign = object.textAlign;
      out.charSpacing = object.charSpacing ?? 0;
      out.lineHeight = object.lineHeight ?? 1.16;
      out.textOutline = (object.strokeWidth ?? 0) > 0 ? rgbaToHex(object.stroke) : null;
      out.textOutlineWidth = object.strokeWidth || 3;
      out.textBg = kind === "callout" ? rgbaToHex(object.boxFill) : rgbaToHex(object.backgroundColor);
      if (kind === "callout") {
        out.fill = rgbaToHex(object.boxFill);
        out.calloutTail = object.tail;
        out.radius = object.boxRadius;
        out.strokeWidth = object.boxStrokeWidth;
      }
      break;
    case "step":
      out.stroke = object.badgeColor;
      out.stepValue = object.value;
      break;
    case "redact":
      out.redactMode = object.mode;
      out.redactStrength = object.strength;
      out.blockColor = object.blockColor;
      break;
    case "spotlight":
      out.spotlightShape = object.shape;
      out.spotlightDim = object.dim;
      break;
    case "magnifier":
      out.magnifierZoom = object.zoom;
      out.magnifierRound = object.round;
      break;
    case "path":
      out.stroke = rgbaToHex(object.stroke) ?? "#ef4444";
      out.strokeWidth = object.strokeWidth;
      break;
    default:
      break;
  }
  return out;
}

/** Apply style changes to one object. `merged` is the full style after the change. */
export function writeStyle(object: any, patch: Partial<ToolStyle>, merged: ToolStyle) {
  const kind = kindOf(object);
  const has = (key: keyof ToolStyle) => key in patch;

  if (has("opacity")) object.set({ opacity: patch.opacity });
  if (has("shadow") || has("shadowBlur")) {
    const on = has("shadow") ? Boolean(patch.shadow) : Boolean(object.shadow);
    object.set({ shadow: shadowFor(on, merged.shadowBlur) });
  }
  if (has("blend")) object.set({ globalCompositeOperation: patch.blend });

  if (FILLED_SHAPES.includes(kind)) {
    if (has("stroke")) object.set({ stroke: patch.stroke });
    if (has("strokeWidth")) object.set({ strokeWidth: patch.strokeWidth });
    if (has("dashedOutline")) {
      const width = Math.max(1, object.strokeWidth || merged.strokeWidth);
      object.set({ strokeDashArray: patch.dashedOutline ? [width * 3, width * 2] : null });
    }
    if (has("fill") || has("fillAlpha") || has("gradient") || has("fill2")) {
      const current = readStyle(object);
      const color = has("fill") ? patch.fill ?? null : current.fill ?? null;
      const alpha = has("fillAlpha") ? patch.fillAlpha! : current.fillAlpha ?? merged.fillAlpha;
      const useGradient = has("gradient") ? Boolean(patch.gradient) : Boolean(current.gradient);
      const second = has("fill2") ? patch.fill2! : current.fill2 ?? merged.fill2;
      object.set({ fill: fillFor(color, alpha, useGradient ? second : null, object.height) });
    }
    if (has("radius") && kind === "rect") object.set({ rx: patch.radius, ry: patch.radius });
    if (has("polyKind") && kind === "poly") object.set({ poly: patch.polyKind });
  }

  switch (kind) {
    case "arrow":
      if (has("stroke")) object.set({ lineColor: patch.stroke });
      if (has("strokeWidth")) object.set({ thickness: patch.strokeWidth });
      if (has("arrowHead")) object.set({ headStyle: patch.arrowHead });
      if (has("dashed")) object.set({ dashed: patch.dashed });
      object.syncHeight?.();
      break;
    case "text":
    case "callout":
      if (has("stroke")) object.set({ fill: patch.stroke });
      if (has("fontFamily")) object.set({ fontFamily: patch.fontFamily });
      if (has("fontSize")) object.set({ fontSize: patch.fontSize });
      if (has("bold")) object.set({ fontWeight: patch.bold ? "700" : "400" });
      if (has("italic")) object.set({ fontStyle: patch.italic ? "italic" : "normal" });
      if (has("underline")) object.set({ underline: patch.underline });
      if (has("textAlign")) object.set({ textAlign: patch.textAlign });
      if (has("charSpacing")) object.set({ charSpacing: patch.charSpacing });
      if (has("lineHeight")) object.set({ lineHeight: patch.lineHeight });
      if (has("textOutline") || has("textOutlineWidth")) {
        const color = has("textOutline") ? patch.textOutline : readStyle(object).textOutline;
        object.set({
          stroke: color ?? null,
          strokeWidth: color ? merged.textOutlineWidth : 0,
          paintFirst: "stroke",
          strokeLineJoin: "round",
        });
      }
      if (kind === "text" && has("textBg")) object.set({ backgroundColor: patch.textBg ?? "" });
      if (kind === "callout") {
        if (has("textBg")) object.set({ boxFill: patch.textBg ?? "#fffbe6" });
        if (has("fill") && patch.fill) object.set({ boxFill: patch.fill });
        if (has("calloutTail")) object.set({ tail: patch.calloutTail });
        if (has("radius")) object.set({ boxRadius: patch.radius });
        if (has("strokeWidth")) object.set({ boxStrokeWidth: patch.strokeWidth });
      }
      object.initDimensions?.();
      break;
    case "step":
      if (has("stroke")) object.set({ badgeColor: patch.stroke });
      if (has("stepValue")) object.set({ value: patch.stepValue });
      break;
    case "redact":
      if (has("redactMode")) object.set({ mode: patch.redactMode });
      if (has("redactStrength")) object.set({ strength: patch.redactStrength });
      if (has("blockColor")) object.set({ blockColor: patch.blockColor });
      break;
    case "spotlight":
      if (has("spotlightShape")) object.set({ shape: patch.spotlightShape });
      if (has("spotlightDim")) object.set({ dim: patch.spotlightDim });
      break;
    case "magnifier":
      if (has("magnifierZoom")) object.set({ zoom: patch.magnifierZoom });
      if (has("magnifierRound")) object.set({ round: patch.magnifierRound });
      break;
    case "path":
      if (has("stroke")) object.set({ stroke: patch.stroke });
      if (has("strokeWidth")) object.set({ strokeWidth: patch.strokeWidth });
      break;
    default:
      break;
  }
  object.setCoords?.();
}

// ---------------------------------------------------------------------------
// Drawing by dragging
// ---------------------------------------------------------------------------

interface Point2 {
  x: number;
  y: number;
}

function textOptions(style: ToolStyle) {
  return {
    fontFamily: style.fontFamily,
    fontSize: style.fontSize,
    fontWeight: style.bold ? "700" : "400",
    fontStyle: style.italic ? "italic" : "normal",
    underline: style.underline,
    textAlign: style.textAlign,
    fill: style.stroke,
    charSpacing: style.charSpacing,
    lineHeight: style.lineHeight,
    ...(style.textOutline
      ? { stroke: style.textOutline, strokeWidth: style.textOutlineWidth, paintFirst: "stroke", strokeLineJoin: "round" }
      : {}),
  };
}

function createDraft(tool: Tool, p: Point2, style: ToolStyle): any | null {
  const fill = fillFor(style.fill, style.fillAlpha, style.gradient ? style.fill2 : null, 100);
  const common = { left: p.x, top: p.y, opacity: style.opacity, shadow: shadowFor(style.shadow, style.shadowBlur) };
  const dash = style.dashedOutline ? [style.strokeWidth * 3, style.strokeWidth * 2] : null;
  switch (tool) {
    case "rect":
      return new Rect({
        ...common,
        width: 1,
        height: 1,
        fill,
        stroke: style.stroke,
        strokeWidth: style.strokeWidth,
        strokeUniform: true,
        strokeDashArray: dash,
        rx: style.radius,
        ry: style.radius,
      });
    case "poly":
      return new PolyShape({
        ...common,
        width: 1,
        height: 1,
        poly: style.polyKind,
        fill,
        stroke: style.stroke,
        strokeWidth: style.strokeWidth,
        strokeDashArray: dash,
      });
    case "ellipse":
      return new Ellipse({
        ...common,
        rx: 1,
        ry: 1,
        fill,
        stroke: style.stroke,
        strokeWidth: style.strokeWidth,
        strokeUniform: true,
        strokeDashArray: dash,
      });
    case "marker":
      return new Rect({
        ...common,
        width: 1,
        height: 1,
        fill: hexToRgba(style.stroke, 0.45),
        strokeWidth: 0,
        globalCompositeOperation: "multiply",
      });
    case "arrow":
    case "line":
      return new ArrowShape({
        ...common,
        width: 1,
        lineColor: style.stroke,
        thickness: style.strokeWidth,
        headStyle: tool === "line" ? "none" : style.arrowHead,
        dashed: style.dashed,
      });
    case "callout":
      return new CalloutBox("Your text", {
        ...common,
        ...textOptions(style),
        fill: "#1f2937",
        boxFill: style.textBg ?? "#fffbe6",
        boxStroke: style.stroke,
        boxStrokeWidth: Math.max(0, Math.min(8, style.strokeWidth)),
        boxRadius: style.radius + 8,
        tail: style.calloutTail,
        width: 40,
      });
    case "redact":
      return new RedactShape({
        left: p.x,
        top: p.y,
        width: 1,
        height: 1,
        mode: style.redactMode,
        strength: style.redactStrength,
        blockColor: style.blockColor,
      });
    case "spotlight":
      return new SpotlightShape({
        left: p.x,
        top: p.y,
        width: 1,
        height: 1,
        shape: style.spotlightShape,
        dim: style.spotlightDim,
      });
    case "magnifier":
      return new MagnifierShape({
        left: p.x,
        top: p.y,
        width: 1,
        height: 1,
        zoom: style.magnifierZoom,
        round: style.magnifierRound,
      });
    default:
      return null;
  }
}

const DEFAULT_SIZE: Partial<Record<Tool, [number, number]>> = {
  rect: [180, 110],
  ellipse: [180, 110],
  poly: [140, 140],
  marker: [220, 34],
  callout: [280, 90],
  redact: [200, 64],
  spotlight: [280, 170],
  magnifier: [170, 170],
};

function updateDraft(tool: Tool, object: any, start: Point2, p: Point2, shift: boolean) {
  let dx = p.x - start.x;
  let dy = p.y - start.y;

  if (tool === "arrow" || tool === "line") {
    let angle = Math.atan2(dy, dx);
    if (shift) angle = Math.round(angle / (Math.PI / 12)) * (Math.PI / 12);
    const length = Math.hypot(dx, dy);
    object.set({ left: start.x, top: start.y, width: Math.max(1, length), angle: (angle * 180) / Math.PI });
    object.syncHeight?.();
    object.setCoords();
    return;
  }

  if (shift || tool === "magnifier") {
    const size = Math.max(Math.abs(dx), Math.abs(dy));
    dx = Math.sign(dx || 1) * size;
    dy = Math.sign(dy || 1) * size;
  }
  const left = Math.min(start.x, start.x + dx);
  const top = Math.min(start.y, start.y + dy);
  const width = Math.max(1, Math.abs(dx));
  const height = Math.max(1, Math.abs(dy));
  if (tool === "ellipse") object.set({ left, top, rx: width / 2, ry: height / 2 });
  else if (tool === "callout") object.set({ left, top, width: Math.max(80, width) });
  else object.set({ left, top, width, height });
  object.setCoords();
}

function finishDraft(tool: Tool, object: any, start: Point2, moved: number) {
  if (moved >= 6) return;
  // A plain click: give the shape a sensible default size.
  if (tool === "arrow" || tool === "line") {
    object.set({ left: start.x, top: start.y, width: 160, angle: 0 });
    object.syncHeight?.();
  } else {
    const [w, h] = DEFAULT_SIZE[tool] ?? [160, 100];
    if (tool === "ellipse") object.set({ left: start.x, top: start.y, rx: w / 2, ry: h / 2 });
    else if (tool === "callout") object.set({ left: start.x, top: start.y, width: w });
    else object.set({ left: start.x, top: start.y, width: w, height: h });
  }
  object.setCoords();
}

// ---------------------------------------------------------------------------
// Event wiring
// ---------------------------------------------------------------------------

export interface ToolContext {
  tool: () => Tool;
  style: () => ToolStyle;
  sticky: () => boolean;
  setTool: (tool: Tool) => void;
  patchStyle: (patch: Partial<ToolStyle>) => void;
  toast: (message: string, kind?: "info" | "success" | "error") => void;
  copyText: (text: string) => void;
}

export function attachTools(engine: EditorEngine, ctx: ToolContext): () => void {
  const canvas = engine.canvas;
  let draft: any = null;
  let start: Point2 = { x: 0, y: 0 };
  let moved = 0;
  let erasing = false;

  const scenePoint = (event: any): Point2 => {
    const point = canvas.getScenePoint(event.e ?? event);
    return { x: point.x, y: point.y };
  };

  const finishAndReturn = (object: any, tool: Tool) => {
    engine.commit();
    if (ONE_SHOT.includes(tool) && !ctx.sticky()) {
      ctx.setTool("select");
      engine.setInteractive("select");
      canvas.setActiveObject(object);
      canvas.requestRenderAll();
    }
  };

  const onDown = (event: any) => {
    const tool = ctx.tool();
    if (event.e?.button === 2 || event.e?.button === 1) return;
    const p = scenePoint(event);

    switch (tool) {
      case "select":
      case "hand":
      case "crop":
      case "pen":
      case "highlighter":
        return;
      case "eraser": {
        erasing = true;
        const target = event.target;
        if (target && target !== engine.base) {
          canvas.remove(target);
        }
        return;
      }
      case "eyedropper": {
        const pixel = engine.pixelAt(p.x, p.y);
        if (pixel) {
          ctx.patchStyle({ stroke: pixel.hex });
          ctx.copyText(pixel.hex);
          ctx.toast(`${pixel.hex.toUpperCase()} picked and copied`, "success");
        }
        ctx.setTool("select");
        return;
      }
      case "step": {
        const style = ctx.style();
        const badge = new StepBadge({
          left: p.x - 22,
          top: p.y - 22,
          value: style.stepValue,
          badgeColor: style.stroke,
          opacity: style.opacity,
          shadow: shadowFor(style.shadow),
        });
        engine.add(badge, false);
        ctx.patchStyle({ stepValue: style.stepValue + 1 });
        engine.commit();
        return;
      }
      case "stamp": {
        const style = ctx.style();
        const stamp = new FabricText(style.stamp, {
          left: p.x - 28,
          top: p.y - 28,
          fontSize: 56,
          fontFamily: '"Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", sans-serif',
          opacity: style.opacity,
        });
        engine.add(stamp, false);
        engine.commit();
        return;
      }
      case "text": {
        const style = ctx.style();
        engine.setInteractive("select");
        const box = new Textbox("Text", {
          left: p.x,
          top: p.y,
          width: 320,
          ...textOptions(style),
          backgroundColor: style.textBg ?? "",
          opacity: style.opacity,
          shadow: shadowFor(style.shadow),
        } as any);
        engine.add(box);
        ctx.setTool("select");
        box.enterEditing();
        box.selectAll();
        canvas.requestRenderAll();
        return;
      }
      default: {
        draft = createDraft(tool, p, ctx.style());
        if (!draft) return;
        start = p;
        moved = 0;
        engine.add(draft, false);
        draft.set({ evented: false, selectable: false });
      }
    }
  };

  const onMove = (event: any) => {
    const tool = ctx.tool();
    if (tool === "eraser" && erasing) {
      const target = event.target;
      if (target && target !== engine.base) canvas.remove(target);
      return;
    }
    if (!draft) return;
    const p = scenePoint(event);
    moved = Math.max(moved, Math.hypot(p.x - start.x, p.y - start.y));
    updateDraft(tool, draft, start, p, Boolean(event.e?.shiftKey));
    canvas.requestRenderAll();
  };

  const onUp = () => {
    const tool = ctx.tool();
    if (erasing) {
      erasing = false;
      engine.commit();
      return;
    }
    if (!draft) return;
    const object = draft;
    draft = null;
    finishDraft(tool, object, start, moved);
    object.set({ evented: true, selectable: true });
    if (tool === "callout") {
      engine.setInteractive("select");
      canvas.setActiveObject(object);
      ctx.setTool("select");
      object.enterEditing?.();
      object.selectAll?.();
      engine.commit();
      return;
    }
    finishAndReturn(object, tool);
  };

  canvas.on("mouse:down", onDown);
  canvas.on("mouse:move", onMove);
  canvas.on("mouse:up", onUp);
  return () => {
    canvas.off("mouse:down", onDown);
    canvas.off("mouse:move", onMove);
    canvas.off("mouse:up", onUp);
  };
}
