/**
 * Image effects that work on plain canvases.
 *
 * Every function takes a source canvas and returns a new one, so the editor
 * can bake an effect into the picture and keep the old bitmap for undo.
 */

export type Edges = { top: boolean; right: boolean; bottom: boolean; left: boolean };

export function makeCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  return canvas;
}

function context(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("This system cannot create a drawing surface");
  return ctx;
}

/** Path of a rounded rectangle (radius is clamped to what fits). */
export function roundedRectPath(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  radius: number,
) {
  const r = Math.max(0, Math.min(radius, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

export function cropCanvas(src: HTMLCanvasElement, x: number, y: number, w: number, h: number): HTMLCanvasElement {
  const out = makeCanvas(w, h);
  context(out).drawImage(src, Math.round(x), Math.round(y), out.width, out.height, 0, 0, out.width, out.height);
  return out;
}

/** Resize with repeated halving when shrinking a lot, which keeps text legible. */
export function resizeCanvas(src: HTMLCanvasElement, width: number, height: number): HTMLCanvasElement {
  let current = src;
  const targetW = Math.max(1, Math.round(width));
  const targetH = Math.max(1, Math.round(height));
  while (current.width / 2 > targetW && current.height / 2 > targetH) {
    const half = makeCanvas(current.width / 2, current.height / 2);
    const hctx = context(half);
    hctx.imageSmoothingQuality = "high";
    hctx.drawImage(current, 0, 0, half.width, half.height);
    current = half;
  }
  const out = makeCanvas(targetW, targetH);
  const ctx = context(out);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(current, 0, 0, out.width, out.height);
  return out;
}

export function rotateCanvas90(src: HTMLCanvasElement, clockwise: boolean): HTMLCanvasElement {
  const out = makeCanvas(src.height, src.width);
  const ctx = context(out);
  if (clockwise) {
    ctx.translate(out.width, 0);
    ctx.rotate(Math.PI / 2);
  } else {
    ctx.translate(0, out.height);
    ctx.rotate(-Math.PI / 2);
  }
  ctx.drawImage(src, 0, 0);
  return out;
}

export function flipCanvas(src: HTMLCanvasElement, axis: "x" | "y"): HTMLCanvasElement {
  const out = makeCanvas(src.width, src.height);
  const ctx = context(out);
  if (axis === "x") {
    ctx.translate(out.width, 0);
    ctx.scale(-1, 1);
  } else {
    ctx.translate(0, out.height);
    ctx.scale(1, -1);
  }
  ctx.drawImage(src, 0, 0);
  return out;
}

export function padCanvas(
  src: HTMLCanvasElement,
  pad: { top: number; right: number; bottom: number; left: number },
  color: string | null,
): HTMLCanvasElement {
  const out = makeCanvas(src.width + pad.left + pad.right, src.height + pad.top + pad.bottom);
  const ctx = context(out);
  if (color) {
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, out.width, out.height);
  }
  ctx.drawImage(src, pad.left, pad.top);
  return out;
}

// ---------------------------------------------------------------------------
// Edge effects
// ---------------------------------------------------------------------------

export function roundCorners(src: HTMLCanvasElement, radius: number): HTMLCanvasElement {
  const out = makeCanvas(src.width, src.height);
  const ctx = context(out);
  roundedRectPath(ctx, 0, 0, out.width, out.height, radius);
  ctx.clip();
  ctx.drawImage(src, 0, 0);
  return out;
}

/** An outer frame of `width` pixels, optionally with rounded corners. */
export function addFrame(src: HTMLCanvasElement, width: number, color: string, radius = 0): HTMLCanvasElement {
  const w = Math.max(1, Math.round(width));
  const out = makeCanvas(src.width + w * 2, src.height + w * 2);
  const ctx = context(out);
  roundedRectPath(ctx, 0, 0, out.width, out.height, radius + w);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.save();
  roundedRectPath(ctx, w, w, src.width, src.height, radius);
  ctx.clip();
  ctx.drawImage(src, w, w);
  ctx.restore();
  return out;
}

export interface BackdropStyle {
  kind: "transparent" | "solid" | "gradient";
  colors: string[];
  angle?: number;
}

export interface BeautifyOptions {
  padding: number;
  radius: number;
  backdrop: BackdropStyle;
  shadow: { blur: number; offsetY: number; opacity: number } | null;
}

/** Padding + backdrop + rounded corners + soft shadow around a screenshot. */
export function beautify(src: HTMLCanvasElement, options: BeautifyOptions): HTMLCanvasElement {
  const pad = Math.max(0, Math.round(options.padding));
  const out = makeCanvas(src.width + pad * 2, src.height + pad * 2);
  const ctx = context(out);

  const { backdrop } = options;
  if (backdrop.kind === "solid") {
    ctx.fillStyle = backdrop.colors[0] ?? "#ffffff";
    ctx.fillRect(0, 0, out.width, out.height);
  } else if (backdrop.kind === "gradient") {
    const angle = ((backdrop.angle ?? 135) * Math.PI) / 180;
    const cx = out.width / 2;
    const cy = out.height / 2;
    const reach = Math.abs(Math.cos(angle)) * out.width / 2 + Math.abs(Math.sin(angle)) * out.height / 2;
    const gradient = ctx.createLinearGradient(
      cx - Math.cos(angle) * reach,
      cy - Math.sin(angle) * reach,
      cx + Math.cos(angle) * reach,
      cy + Math.sin(angle) * reach,
    );
    const colors = backdrop.colors.length > 1 ? backdrop.colors : [backdrop.colors[0] ?? "#6366f1", "#ec4899"];
    colors.forEach((color, index) => gradient.addColorStop(index / (colors.length - 1), color));
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, out.width, out.height);
  }

  if (options.shadow) {
    ctx.save();
    ctx.shadowColor = `rgba(0,0,0,${options.shadow.opacity})`;
    ctx.shadowBlur = options.shadow.blur;
    ctx.shadowOffsetY = options.shadow.offsetY;
    roundedRectPath(ctx, pad, pad, src.width, src.height, options.radius);
    ctx.fillStyle = "#000";
    ctx.fill();
    ctx.restore();
    // The shadow caster is hidden again by the picture, so semi transparent
    // pictures are not darkened by it.
    ctx.save();
    ctx.globalCompositeOperation = "destination-out";
    roundedRectPath(ctx, pad, pad, src.width, src.height, options.radius);
    ctx.fill();
    ctx.restore();
  }

  ctx.save();
  roundedRectPath(ctx, pad, pad, src.width, src.height, options.radius);
  ctx.clip();
  ctx.drawImage(src, pad, pad);
  ctx.restore();
  return out;
}

/** Deterministic pseudo-random generator (mulberry32). */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Zig-zag offsets (0..depth) along an edge of `length` pixels. */
export function tornOffsets(length: number, depth: number, seed = 7): number[] {
  const random = seededRandom(seed);
  const step = Math.max(4, Math.round(depth * 0.9));
  const count = Math.max(2, Math.ceil(length / step) + 1);
  const offsets: number[] = [];
  for (let i = 0; i < count; i += 1) offsets.push(random() * depth);
  return offsets;
}

/** Ripped-paper look on the chosen edges. */
export function tornEdge(src: HTMLCanvasElement, edges: Edges, depth: number, seed = 7): HTMLCanvasElement {
  const w = src.width;
  const h = src.height;
  const d = Math.max(2, Math.min(depth, Math.min(w, h) / 4));
  const out = makeCanvas(w, h);
  const ctx = context(out);
  ctx.beginPath();

  const top = edges.top ? tornOffsets(w, d, seed) : null;
  const right = edges.right ? tornOffsets(h, d, seed + 1) : null;
  const bottom = edges.bottom ? tornOffsets(w, d, seed + 2) : null;
  const left = edges.left ? tornOffsets(h, d, seed + 3) : null;
  const at = (offsets: number[] | null, length: number, i: number, steps: number) =>
    offsets ? offsets[Math.min(offsets.length - 1, Math.round((i / steps) * (offsets.length - 1)))] : 0;

  const stepsX = Math.max(8, Math.ceil(w / Math.max(4, d * 0.9)));
  const stepsY = Math.max(8, Math.ceil(h / Math.max(4, d * 0.9)));

  ctx.moveTo(0, at(top, w, 0, stepsX));
  for (let i = 0; i <= stepsX; i += 1) ctx.lineTo((i / stepsX) * w, at(top, w, i, stepsX));
  for (let i = 0; i <= stepsY; i += 1) ctx.lineTo(w - at(right, h, i, stepsY), (i / stepsY) * h);
  for (let i = stepsX; i >= 0; i -= 1) ctx.lineTo((i / stepsX) * w, h - at(bottom, w, i, stepsX));
  for (let i = stepsY; i >= 0; i -= 1) ctx.lineTo(at(left, h, i, stepsY), (i / stepsY) * h);
  ctx.closePath();
  ctx.clip();
  ctx.drawImage(src, 0, 0);
  return out;
}

/** Fade the picture to transparent towards the chosen edges. */
export function fadeEdge(src: HTMLCanvasElement, edges: Edges, size: number): HTMLCanvasElement {
  const w = src.width;
  const h = src.height;
  const s = Math.max(2, Math.min(size, Math.min(w, h) / 2));
  const out = makeCanvas(w, h);
  const ctx = context(out);
  ctx.drawImage(src, 0, 0);
  ctx.globalCompositeOperation = "destination-out";
  const fade = (x0: number, y0: number, x1: number, y1: number, rx: number, ry: number, rw: number, rh: number) => {
    const g = ctx.createLinearGradient(x0, y0, x1, y1);
    g.addColorStop(0, "rgba(0,0,0,1)");
    g.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = g;
    ctx.fillRect(rx, ry, rw, rh);
  };
  if (edges.top) fade(0, 0, 0, s, 0, 0, w, s);
  if (edges.bottom) fade(0, h, 0, h - s, 0, h - s, w, s);
  if (edges.left) fade(0, 0, s, 0, 0, 0, s, h);
  if (edges.right) fade(w, 0, w - s, 0, w - s, 0, s, h);
  return out;
}

// ---------------------------------------------------------------------------
// Watermark
// ---------------------------------------------------------------------------

export interface WatermarkOptions {
  text: string;
  size: number;
  opacity: number;
  color: string;
  position: "center" | "bottom-right" | "bottom-left" | "top-right" | "top-left" | "tile";
  angle: number;
}

export function watermark(src: HTMLCanvasElement, options: WatermarkOptions): HTMLCanvasElement {
  const out = makeCanvas(src.width, src.height);
  const ctx = context(out);
  ctx.drawImage(src, 0, 0);
  const text = options.text.trim();
  if (!text) return out;
  const size = Math.max(8, options.size);
  ctx.globalAlpha = Math.min(1, Math.max(0.02, options.opacity));
  ctx.fillStyle = options.color;
  ctx.font = `700 ${size}px Inter, "Segoe UI", system-ui, sans-serif`;
  ctx.textBaseline = "middle";
  const textWidth = ctx.measureText(text).width;
  const angle = (options.angle * Math.PI) / 180;

  const stamp = (x: number, y: number) => {
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(angle);
    ctx.textAlign = "center";
    ctx.shadowColor = "rgba(0,0,0,0.35)";
    ctx.shadowBlur = size * 0.12;
    ctx.fillText(text, 0, 0);
    ctx.restore();
  };

  const margin = size * 0.8 + 8;
  switch (options.position) {
    case "tile": {
      const gapX = textWidth + size * 2.2;
      const gapY = size * 3.2;
      for (let y = gapY / 2, row = 0; y < out.height + gapY; y += gapY, row += 1) {
        for (let x = (row % 2 ? gapX / 2 : 0); x < out.width + gapX; x += gapX) stamp(x, y);
      }
      break;
    }
    case "bottom-right":
      stamp(out.width - textWidth / 2 - margin, out.height - margin);
      break;
    case "bottom-left":
      stamp(textWidth / 2 + margin, out.height - margin);
      break;
    case "top-right":
      stamp(out.width - textWidth / 2 - margin, margin);
      break;
    case "top-left":
      stamp(textWidth / 2 + margin, margin);
      break;
    default:
      stamp(out.width / 2, out.height / 2);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tonal helpers
// ---------------------------------------------------------------------------

export interface Levels {
  min: [number, number, number];
  max: [number, number, number];
}

/**
 * Per-channel black and white points, ignoring the darkest/brightest
 * `clip` fraction so a few stray pixels do not stop the stretch.
 */
export function computeLevels(data: ArrayLike<number>, clip = 0.005): Levels {
  const histogram = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
  let counted = 0;
  for (let i = 0; i + 3 < data.length; i += 4) {
    if (data[i + 3] < 8) continue;
    histogram[0][data[i]] += 1;
    histogram[1][data[i + 1]] += 1;
    histogram[2][data[i + 2]] += 1;
    counted += 1;
  }
  const min: [number, number, number] = [0, 0, 0];
  const max: [number, number, number] = [255, 255, 255];
  if (counted === 0) return { min, max };
  const limit = counted * clip;
  for (let c = 0; c < 3; c += 1) {
    let acc = 0;
    for (let v = 0; v < 256; v += 1) {
      acc += histogram[c][v];
      if (acc > limit) {
        min[c] = v;
        break;
      }
    }
    acc = 0;
    for (let v = 255; v >= 0; v -= 1) {
      acc += histogram[c][v];
      if (acc > limit) {
        max[c] = v;
        break;
      }
    }
    if (max[c] - min[c] < 8) {
      min[c] = 0;
      max[c] = 255;
    }
  }
  return { min, max };
}

/** Largest zoom that fits `content` into `viewport` (never above `cap`). */
export function fitZoom(
  content: { width: number; height: number },
  viewport: { width: number; height: number },
  margin = 48,
  cap = 1,
): number {
  if (content.width <= 0 || content.height <= 0) return 1;
  const z = Math.min(
    (viewport.width - margin) / content.width,
    (viewport.height - margin) / content.height,
    cap,
  );
  return Number.isFinite(z) && z > 0 ? Math.max(0.02, z) : 1;
}
