/* eslint-disable @typescript-eslint/no-explicit-any */
import { useEffect, useState } from "react";
import { Icon } from "./Icon";
import {
  IconToggle,
  Line,
  NumberBox,
  Section,
  Seg,
  SmallButton,
  Slider,
  Swatches,
} from "./editorUi";
import type { EditorEngine } from "../editor/engine";
import { POLY_KINDS, type PolyKind } from "../editor/shapes";
import { hasAdjustments } from "../editor/engine";
import {
  addFrame,
  beautify,
  fadeEdge,
  roundCorners,
  tornEdge,
  watermark,
  type BackdropStyle,
  type Edges,
  type WatermarkOptions,
} from "../editor/effects";
import { FONT_CHOICES, STAMPS, kindOf, type ObjectKind, type Tool, type ToolStyle } from "../editor/tools";
import type { PluginManifest } from "../lib/api";

export interface PanelProps {
  engine: EditorEngine;
  tick: number;
  tool: Tool;
  style: ToolStyle;
  /** Look of the current selection (if any), expressed like `ToolStyle`. */
  shown: ToolStyle;
  selectionKind: ObjectKind | null;
  patchStyle: (patch: Partial<ToolStyle>) => void;
  commitSoon: () => void;
  toast: (message: string, kind?: "info" | "success" | "error") => void;
}

// ---------------------------------------------------------------------------
// Style
// ---------------------------------------------------------------------------

const TOOL_TITLES: Record<string, string> = {
  select: "Select & move",
  hand: "Pan",
  crop: "Crop",
  arrow: "Arrow",
  line: "Line",
  rect: "Rectangle",
  ellipse: "Ellipse",
  poly: "Shapes",
  pen: "Pen",
  highlighter: "Highlighter pen",
  marker: "Highlight box",
  text: "Text",
  callout: "Callout",
  step: "Step number",
  redact: "Blur / pixelate",
  spotlight: "Spotlight",
  magnifier: "Magnifier",
  stamp: "Stamp",
  eraser: "Eraser",
  eyedropper: "Colour picker",
};

const KIND_TITLES: Record<string, string> = {
  rect: "Rectangle",
  ellipse: "Ellipse",
  poly: "Shape",
  arrow: "Arrow / line",
  text: "Text",
  callout: "Callout",
  step: "Step number",
  redact: "Blur / pixelate",
  spotlight: "Spotlight",
  magnifier: "Magnifier",
  path: "Drawing",
  image: "Image layer",
};

export function StylePanel(props: PanelProps) {
  const { engine, tool, shown, selectionKind, patchStyle, commitSoon } = props;
  const kind: string = selectionKind ?? (["pen", "highlighter"].includes(tool) ? "path" : tool);
  const title = selectionKind ? KIND_TITLES[selectionKind] ?? "Object" : TOOL_TITLES[tool] ?? tool;

  const showStroke = ["rect", "ellipse", "arrow", "line", "path", "pen", "highlighter", "marker", "step", "callout", "text", "poly"].includes(kind);
  const showFill = ["rect", "ellipse", "callout", "poly"].includes(kind);
  const showWidth = ["rect", "ellipse", "arrow", "line", "path", "pen", "highlighter", "callout", "poly"].includes(kind);
  const isText = ["text", "callout"].includes(kind);
  const colorLabel = isText ? "Text colour" : kind === "step" ? "Badge colour" : "Colour";

  const set = (patch: Partial<ToolStyle>) => {
    patchStyle(patch);
    commitSoon();
  };

  const hasObject = Boolean(engine.canvas.getActiveObject());

  return (
    <>
      <Section
        title={title}
        action={
          selectionKind ? <span className="text-[9px] text-violet-300 font-semibold">SELECTED</span> : null
        }
      >
        {kind === "select" || kind === "hand" || kind === "crop" || kind === "eraser" || kind === "eyedropper" ? (
          <div className="text-[10.5px] text-slate-500 leading-relaxed">
            {kind === "select"
              ? "Click an item to edit it. Drag to move, use the handles to resize or rotate. Shift+click selects several."
              : kind === "crop"
                ? "Drag the frame, then press Enter or Apply."
                : kind === "eraser"
                  ? "Click or drag over annotations to delete them."
                  : kind === "eyedropper"
                    ? "Click anywhere on the picture to copy its colour."
                    : "Drag to move the picture around. Hold Space for a quick pan."}
          </div>
        ) : null}

        {showStroke && kind !== "step" ? (
          <>
            <Line label={colorLabel}>
              <span />
            </Line>
            <Swatches value={shown.stroke} onChange={(color) => color && set({ stroke: color })} />
          </>
        ) : null}
        {kind === "step" ? (
          <>
            <Line label={colorLabel}>
              <span />
            </Line>
            <Swatches value={shown.stroke} onChange={(color) => color && set({ stroke: color })} />
            <Line label="Number">
              <NumberBox value={shown.stepValue} min={0} max={999} onChange={(value) => set({ stepValue: value })} />
              <SmallButton
                title="Renumber every step badge from 1 in layer order"
                onClick={() => {
                  let n = 1;
                  engine.annotations().forEach((object: any) => {
                    if (kindOf(object) === "step") object.set({ value: n++ });
                  });
                  engine.canvas.requestRenderAll();
                  engine.commit();
                  patchStyle({ stepValue: n });
                }}
              >
                Renumber
              </SmallButton>
            </Line>
          </>
        ) : null}

        {showFill ? (
          <>
            <Line label={kind === "callout" ? "Bubble colour" : "Fill"}>
              <span />
            </Line>
            <Swatches
              value={kind === "callout" ? shown.textBg ?? "#fffbe6" : shown.fill}
              allowNone={kind !== "callout"}
              onChange={(color) => set(kind === "callout" ? { textBg: color ?? "#fffbe6" } : { fill: color })}
            />
            {kind !== "callout" && shown.fill ? (
              <Line label="Fill opacity">
                <Slider
                  value={shown.fillAlpha}
                  min={0.05}
                  max={1}
                  step={0.05}
                  onChange={(value) => patchStyle({ fillAlpha: value })}
                  onCommit={commitSoon}
                />
              </Line>
            ) : null}
          </>
        ) : null}

        {showWidth ? (
          <Line label={kind === "callout" ? "Border" : "Thickness"}>
            <Slider
              value={shown.strokeWidth}
              min={kind === "callout" ? 0 : 1}
              max={kind === "highlighter" ? 30 : 32}
              onChange={(value) => patchStyle({ strokeWidth: value })}
              onCommit={commitSoon}
            />
          </Line>
        ) : null}

        {kind === "poly" ? (
          <div className="grid grid-cols-4 gap-1">
            {POLY_KINDS.map((item) => (
              <button
                key={item.id}
                title={item.label}
                className={`h-9 rounded-lg border flex items-center justify-center ${shown.polyKind === item.id ? "border-violet-400/70 bg-violet-500/20" : "border-white/10 hover:border-white/30"}`}
                onClick={() => set({ polyKind: item.id })}
              >
                <PolyGlyph kind={item.id} />
              </button>
            ))}
          </div>
        ) : null}

        {["rect", "ellipse", "poly"].includes(kind) ? (
          <>
            <Line label="Outline">
              <IconToggle on={shown.dashedOutline} onClick={() => set({ dashedOutline: !shown.dashedOutline })} title="Dashed outline" text="- - -" />
            </Line>
            {shown.fill ? (
              <Line label="Gradient">
                <IconToggle on={shown.gradient} onClick={() => set({ gradient: !shown.gradient })} title="Fade into a second colour" text={shown.gradient ? "On" : "Off"} />
              </Line>
            ) : null}
            {shown.fill && shown.gradient ? <Swatches value={shown.fill2} onChange={(color) => color && set({ fill2: color })} /> : null}
          </>
        ) : null}

        {kind === "rect" ? (
          <Line label="Corner radius">
            <Slider
              value={shown.radius}
              min={0}
              max={60}
              onChange={(value) => patchStyle({ radius: value })}
              onCommit={commitSoon}
            />
          </Line>
        ) : null}

        {kind === "arrow" ? (
          <>
            <Line label="Head">
              <Seg
                value={shown.arrowHead}
                onChange={(value) => set({ arrowHead: value })}
                options={[
                  { value: "triangle", label: "▶", title: "Filled arrow" },
                  { value: "open", label: ">", title: "Open arrow" },
                  { value: "both", label: "◀▶", title: "Both ends" },
                  { value: "circle", label: "●", title: "Dot" },
                  { value: "none", label: "—", title: "No head (plain line)" },
                ]}
              />
            </Line>
            <Line label="Dashed">
              <IconToggle on={shown.dashed} onClick={() => set({ dashed: !shown.dashed })} title="Dashed line" text="- - -" />
            </Line>
          </>
        ) : null}

        {isText ? (
          <>
            <Line label="Font">
              <select
                className="text-input !py-1 !text-[10.5px] w-[150px]"
                value={FONT_CHOICES.some((f) => f.value === shown.fontFamily) ? shown.fontFamily : FONT_CHOICES[0].value}
                onChange={(event) => set({ fontFamily: event.target.value })}
              >
                {FONT_CHOICES.map((font) => (
                  <option key={font.label} value={font.value}>
                    {font.label}
                  </option>
                ))}
              </select>
            </Line>
            <Line label="Size">
              <NumberBox value={shown.fontSize} min={6} max={400} onChange={(value) => set({ fontSize: Math.max(6, value) })} />
              <IconToggle on={shown.bold} onClick={() => set({ bold: !shown.bold })} title="Bold" text="B" />
              <IconToggle on={shown.italic} onClick={() => set({ italic: !shown.italic })} title="Italic" text="I" />
              <IconToggle on={shown.underline} onClick={() => set({ underline: !shown.underline })} title="Underline" text="U" />
            </Line>
            <Line label="Align">
              <Seg
                value={shown.textAlign}
                onChange={(value) => set({ textAlign: value })}
                options={[
                  { value: "left", label: "Left" },
                  { value: "center", label: "Centre" },
                  { value: "right", label: "Right" },
                ]}
              />
            </Line>
            <Line label="Spacing">
              <Slider value={shown.charSpacing} min={-50} max={600} step={10} onChange={(value) => patchStyle({ charSpacing: value })} onCommit={commitSoon} width={100} />
            </Line>
            <Line label="Line height">
              <Slider value={shown.lineHeight} min={0.8} max={2.4} step={0.05} onChange={(value) => patchStyle({ lineHeight: value })} onCommit={commitSoon} width={100} />
            </Line>
            <Line label="Outline">
              <IconToggle
                on={Boolean(shown.textOutline)}
                onClick={() => set({ textOutline: shown.textOutline ? null : "#000000" })}
                title="Draw an outline around the letters"
                text={shown.textOutline ? "On" : "Off"}
              />
            </Line>
            {shown.textOutline ? (
              <>
                <Swatches value={shown.textOutline} onChange={(color) => color && set({ textOutline: color })} />
                <Line label="Outline width">
                  <Slider value={shown.textOutlineWidth} min={1} max={14} onChange={(value) => patchStyle({ textOutlineWidth: value, textOutline: shown.textOutline })} onCommit={commitSoon} width={100} />
                </Line>
              </>
            ) : null}
            {kind === "text" ? (
              <>
                <Line label="Background">
                  <span />
                </Line>
                <Swatches value={shown.textBg} allowNone onChange={(color) => set({ textBg: color })} />
              </>
            ) : (
              <>
                <Line label="Tail">
                  <Seg
                    value={shown.calloutTail}
                    onChange={(value) => set({ calloutTail: value })}
                    options={[
                      { value: "none", label: "None" },
                      { value: "bl", label: "↙" },
                      { value: "br", label: "↘" },
                      { value: "tl", label: "↖" },
                      { value: "tr", label: "↗" },
                    ]}
                  />
                </Line>
                <Line label="Roundness">
                  <Slider
                    value={shown.radius}
                    min={0}
                    max={40}
                    onChange={(value) => patchStyle({ radius: value })}
                    onCommit={commitSoon}
                  />
                </Line>
              </>
            )}
          </>
        ) : null}

        {kind === "redact" ? (
          <>
            <Line label="Mode">
              <Seg
                value={shown.redactMode}
                onChange={(value) => set({ redactMode: value })}
                options={[
                  { value: "pixelate", label: "Pixelate" },
                  { value: "blur", label: "Blur" },
                  { value: "solid", label: "Block" },
                ]}
              />
            </Line>
            {shown.redactMode !== "solid" ? (
              <Line label="Strength">
                <Slider
                  value={shown.redactStrength}
                  min={3}
                  max={48}
                  onChange={(value) => patchStyle({ redactStrength: value })}
                  onCommit={commitSoon}
                />
              </Line>
            ) : (
              <>
                <Line label="Block colour">
                  <span />
                </Line>
                <Swatches value={shown.blockColor} onChange={(color) => color && set({ blockColor: color })} />
              </>
            )}
            <div className="text-[10px] text-slate-500 leading-relaxed">
              Hides what is underneath for good once you save. Pixelate and Block cannot be reversed.
            </div>
          </>
        ) : null}

        {kind === "spotlight" ? (
          <>
            <Line label="Shape">
              <Seg
                value={shown.spotlightShape}
                onChange={(value) => set({ spotlightShape: value })}
                options={[
                  { value: "rect", label: "Box" },
                  { value: "ellipse", label: "Oval" },
                ]}
              />
            </Line>
            <Line label="Darkness">
              <Slider
                value={shown.spotlightDim}
                min={0.1}
                max={0.95}
                step={0.05}
                onChange={(value) => patchStyle({ spotlightDim: value })}
                onCommit={commitSoon}
              />
            </Line>
          </>
        ) : null}

        {kind === "magnifier" ? (
          <>
            <Line label="Zoom">
              <Slider
                value={shown.magnifierZoom}
                min={1.5}
                max={6}
                step={0.25}
                onChange={(value) => patchStyle({ magnifierZoom: value })}
                onCommit={commitSoon}
                suffix="×"
              />
            </Line>
            <Line label="Shape">
              <Seg
                value={shown.magnifierRound ? "round" : "box"}
                onChange={(value) => set({ magnifierRound: value === "round" })}
                options={[
                  { value: "round", label: "Round" },
                  { value: "box", label: "Square" },
                ]}
              />
            </Line>
          </>
        ) : null}

        {kind === "stamp" ? (
          <div className="grid grid-cols-6 gap-1">
            {STAMPS.map((emoji) => (
              <button
                key={emoji}
                className={`h-8 rounded-lg border text-lg ${shown.stamp === emoji ? "border-violet-400/70 bg-violet-500/20" : "border-white/10 hover:border-white/30"}`}
                onClick={() => patchStyle({ stamp: emoji })}
              >
                {emoji}
              </button>
            ))}
          </div>
        ) : null}

        {!["select", "hand", "crop", "eraser", "eyedropper", "redact", "spotlight", "magnifier", "stamp"].includes(kind) || hasObject ? (
          <>
            <Line label="Opacity">
              <Slider
                value={Math.round(shown.opacity * 100)}
                min={5}
                max={100}
                onChange={(value) => patchStyle({ opacity: value / 100 })}
                onCommit={commitSoon}
                suffix="%"
              />
            </Line>
            {!["redact", "spotlight", "magnifier"].includes(kind) ? (
              <Line label="Shadow">
                <IconToggle on={shown.shadow} onClick={() => set({ shadow: !shown.shadow })} title="Drop shadow" text={shown.shadow ? "On" : "Off"} />
                {shown.shadow ? (
                  <Slider value={shown.shadowBlur} min={2} max={48} onChange={(value) => patchStyle({ shadowBlur: value })} onCommit={commitSoon} width={80} />
                ) : null}
              </Line>
            ) : null}
            <Line label="Blend">
              <select
                className="text-input !py-1 !text-[10.5px] w-[130px]"
                value={shown.blend}
                onChange={(event) => set({ blend: event.target.value })}
              >
                <option value="source-over">Normal</option>
                <option value="multiply">Multiply (like a marker)</option>
                <option value="screen">Screen (lighten)</option>
                <option value="overlay">Overlay</option>
                <option value="darken">Darken</option>
                <option value="lighten">Lighten</option>
                <option value="difference">Difference</option>
              </select>
            </Line>
          </>
        ) : null}
      </Section>

      {selectionKind || hasObject ? <ArrangeSection engine={engine} /> : <PresetsSection tool={tool} patchStyle={patchStyle} commitSoon={commitSoon} />}
      {selectionKind && ["rect", "ellipse", "poly", "arrow", "text", "callout", "step"].includes(selectionKind) ? (
        <PresetsSection tool={selectionKind} patchStyle={patchStyle} commitSoon={commitSoon} />
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// Quick styles
// ---------------------------------------------------------------------------

const PRESETS: { name: string; color: string; fill?: string; width: number }[] = [
  { name: "Danger", color: "#ef4444", fill: "#ef4444", width: 5 },
  { name: "Warning", color: "#f59e0b", fill: "#fbbf24", width: 5 },
  { name: "Success", color: "#22c55e", fill: "#22c55e", width: 5 },
  { name: "Info", color: "#3b82f6", fill: "#3b82f6", width: 5 },
  { name: "Violet", color: "#8b5cf6", fill: "#8b5cf6", width: 5 },
  { name: "Dark", color: "#111827", fill: "#111827", width: 4 },
  { name: "Light", color: "#ffffff", fill: "#ffffff", width: 4 },
  { name: "Thin", color: "#ef4444", width: 2 },
];

function PresetsSection({
  tool,
  patchStyle,
  commitSoon,
}: {
  tool: string;
  patchStyle: (patch: Partial<ToolStyle>) => void;
  commitSoon: () => void;
}) {
  if (!["rect", "ellipse", "poly", "arrow", "line", "marker", "text", "callout", "step", "pen"].includes(tool)) return null;
  return (
    <Section title="Quick styles">
      <div className="grid grid-cols-4 gap-1.5">
        {PRESETS.map((preset) => (
          <button
            key={preset.name}
            title={preset.name}
            className="h-8 rounded-lg border border-white/10 hover:border-white/40 flex items-center justify-center transition-colors"
            style={{ background: "rgba(255,255,255,0.03)" }}
            onClick={() => {
              patchStyle({
                stroke: preset.color,
                strokeWidth: preset.width,
                ...(preset.fill && ["rect", "ellipse", "poly"].includes(tool) ? { fill: preset.fill, fillAlpha: 0.22 } : {}),
              });
              commitSoon();
            }}
          >
            <span className="w-4 h-4 rounded-full border-2" style={{ borderColor: preset.color === "#111827" ? "#475569" : preset.color, background: preset.fill ?? "transparent" }} />
          </button>
        ))}
      </div>
    </Section>
  );
}

/** Tiny outline of a preset shape for the picker buttons. */
function PolyGlyph({ kind }: { kind: PolyKind }) {
  const paths: Record<PolyKind, string> = {
    triangle: "M12 4 L21 20 L3 20 Z",
    diamond: "M12 3 L21 12 L12 21 L3 12 Z",
    pentagon: "M12 3 L21 10 L17.5 20.5 L6.5 20.5 L3 10 Z",
    hexagon: "M7 4 L17 4 L22 12 L17 20 L7 20 L2 12 Z",
    star: "M12 3 L14.6 9.2 L21.3 9.7 L16.2 14 L17.8 20.6 L12 17.1 L6.2 20.6 L7.8 14 L2.7 9.7 L9.4 9.2 Z",
    cross: "M9 3 H15 V9 H21 V15 H15 V21 H9 V15 H3 V9 H9 Z",
    heart: "M12 20 C4 14 3 9 6 6.5 C8.5 4.5 11 6 12 8 C13 6 15.5 4.5 18 6.5 C21 9 20 14 12 20 Z",
    pill: "M8 6 H16 A6 6 0 0 1 16 18 H8 A6 6 0 0 1 8 6 Z",
  };
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round">
      <path d={paths[kind]} />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Arrange (numbers, alignment, order)
// ---------------------------------------------------------------------------

function ArrangeSection({ engine }: { engine: EditorEngine }) {
  const active: any = engine.canvas.getActiveObject();
  const [ratioLock, setRatioLock] = useState(false);
  if (!active || active.snapTemp) return null;
  const box = engine.boxOf(active);
  const single = active.type !== "activeselection";
  const apply = (patch: Partial<{ x: number; y: number; w: number; h: number; angle: number }>) => {
    engine.setBox(active, patch);
    engine.commit();
  };
  const sized = (patch: { w?: number; h?: number }) => {
    if (!ratioLock) return apply(patch);
    const ratio = box.w / Math.max(1, box.h);
    if (patch.w !== undefined) apply({ w: patch.w, h: patch.w / ratio });
    else if (patch.h !== undefined) apply({ w: patch.h * ratio, h: patch.h });
  };
  const alignButton = (mode: Parameters<EditorEngine["align"]>[0], icon: string, title: string) => (
    <button key={mode} className="win-ctrl !w-7 !h-6 border border-white/10" title={title} onClick={() => engine.align(mode)}>
      <Icon name={icon} size={13} />
    </button>
  );
  return (
    <Section title="Arrange">
      <div className="grid grid-cols-2 gap-1.5">
        <label className="flex items-center justify-between text-[10px] text-slate-400 gap-1">
          X <NumberBox value={box.x} width={62} onChange={(value) => apply({ x: value })} />
        </label>
        <label className="flex items-center justify-between text-[10px] text-slate-400 gap-1">
          Y <NumberBox value={box.y} width={62} onChange={(value) => apply({ y: value })} />
        </label>
        <label className="flex items-center justify-between text-[10px] text-slate-400 gap-1">
          W <NumberBox value={box.w} width={62} min={2} onChange={(value) => sized({ w: value })} />
        </label>
        <label className="flex items-center justify-between text-[10px] text-slate-400 gap-1">
          H <NumberBox value={box.h} width={62} min={2} onChange={(value) => sized({ h: value })} />
        </label>
      </div>
      {single ? (
        <Line label="Rotation">
          <Slider value={Math.round(((active.angle ?? 0) + 360) % 360)} min={0} max={359} width={96} suffix="°" onChange={(value) => engine.setBox(active, { angle: value })} onCommit={() => engine.commit()} />
        </Line>
      ) : null}
      <Line label="Keep ratio">
        <IconToggle on={ratioLock} onClick={() => setRatioLock(!ratioLock)} icon={ratioLock ? "lock" : "unlock"} title="Keep the proportions when changing W or H" />
      </Line>
      <div className="flex flex-wrap gap-1">
        {alignButton("left", "alignLeft", "Align left")}
        {alignButton("hcenter", "alignCenterH", "Centre horizontally")}
        {alignButton("right", "alignRight", "Align right")}
        {alignButton("top", "alignTop", "Align top")}
        {alignButton("vcenter", "alignCenterV", "Centre vertically")}
        {alignButton("bottom", "alignBottom", "Align bottom")}
      </div>
      <div className="flex flex-wrap gap-1">
        <SmallButton onClick={() => engine.flipObject("x")} title="Mirror this item left/right">
          <Icon name="flipH" size={12} /> Flip
        </SmallButton>
        <SmallButton onClick={() => engine.flipObject("y")} title="Mirror this item top/bottom">
          <Icon name="flipV" size={12} /> Flip
        </SmallButton>
        {single ? (
          <>
            <SmallButton onClick={() => engine.moveLayer(active, "top")} title="Bring to front">
              To front
            </SmallButton>
            <SmallButton onClick={() => engine.moveLayer(active, "bottom")} title="Send to back">
              To back
            </SmallButton>
          </>
        ) : null}
      </div>
    </Section>
  );
}

// ---------------------------------------------------------------------------
// Layers
// ---------------------------------------------------------------------------

const LAYER_ICONS: Record<string, string> = {
  rect: "squareShape",
  ellipse: "circle",
  arrow: "arrow",
  text: "text",
  callout: "callout",
  step: "hash",
  redact: "blur",
  spotlight: "spotlight",
  magnifier: "magnifier",
  path: "pen",
  image: "image",
  other: "layers",
};

function layerName(object: any): string {
  const kind = kindOf(object);
  const base = KIND_TITLES[kind] ?? "Object";
  if (kind === "text" || kind === "callout") {
    const text = String(object.text ?? "").replace(/\s+/g, " ").trim();
    return text ? `${base}: ${text.slice(0, 22)}` : base;
  }
  if (kind === "step") return `${base} ${object.value}`;
  return base;
}

export function LayersPanel({ engine }: PanelProps) {
  const layers = engine.annotations().slice().reverse();
  const active = new Set(engine.canvas.getActiveObjects());
  return (
    <div className="p-2 space-y-1">
      <div className="px-1 pb-1 text-[10px] text-slate-500">
        {layers.length === 0 ? "No annotations yet — pick a tool on the left." : `${layers.length} layer${layers.length === 1 ? "" : "s"} · top of the list is in front`}
      </div>
      {layers.map((object: any, index: number) => {
        const kind = kindOf(object);
        const locked = Boolean(object.snapLocked);
        return (
          <div
            key={`${index}-${object.cacheKey ?? ""}`}
            className={`flex items-center gap-1.5 px-1.5 py-1 rounded-lg border text-[10.5px] cursor-pointer ${
              active.has(object) ? "border-violet-400/60 bg-violet-500/15 text-violet-100" : "border-white/8 text-slate-300 hover:border-white/20"
            }`}
            onClick={() => {
              if (locked) return;
              engine.setInteractive("select");
              engine.canvas.setActiveObject(object);
              engine.canvas.requestRenderAll();
            }}
          >
            <Icon name={LAYER_ICONS[kind] ?? "layers"} size={13} />
            <span className="truncate flex-1">{layerName(object)}</span>
            <button
              className="win-ctrl !w-5 !h-5"
              title={object.visible === false ? "Show" : "Hide"}
              onClick={(event) => {
                event.stopPropagation();
                object.set({ visible: object.visible === false });
                engine.canvas.discardActiveObject();
                engine.canvas.requestRenderAll();
                engine.commit();
              }}
            >
              <Icon name={object.visible === false ? "eyeOff" : "eye"} size={12} />
            </button>
            <button
              className="win-ctrl !w-5 !h-5"
              title={locked ? "Unlock" : "Lock"}
              onClick={(event) => {
                event.stopPropagation();
                object.snapLocked = !locked;
                engine.canvas.discardActiveObject();
                engine.refreshInteractivity();
                engine.commit();
              }}
            >
              <Icon name={locked ? "lock" : "unlock"} size={12} />
            </button>
            <button className="win-ctrl !w-5 !h-5" title="Bring forward" onClick={(event) => { event.stopPropagation(); engine.moveLayer(object, "up"); }}>
              <Icon name="chevronUp" size={12} />
            </button>
            <button className="win-ctrl !w-5 !h-5" title="Send backward" onClick={(event) => { event.stopPropagation(); engine.moveLayer(object, "down"); }}>
              <Icon name="chevronDown" size={12} />
            </button>
            <button
              className="win-ctrl !w-5 !h-5 hover:!bg-rose-500/80"
              title="Delete"
              onClick={(event) => {
                event.stopPropagation();
                engine.canvas.discardActiveObject();
                engine.canvas.remove(object);
                engine.commit();
              }}
            >
              <Icon name="trash" size={12} />
            </button>
          </div>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Image: transform, size, adjustments
// ---------------------------------------------------------------------------

export function ImagePanel({ engine, toast }: PanelProps) {
  const [ratioLock, setRatioLock] = useState(true);
  const [size, setSize] = useState({ w: engine.width, h: engine.height });
  const [pad, setPad] = useState({ top: 40, right: 40, bottom: 40, left: 40 });
  const [padColor, setPadColor] = useState<string | null>("#ffffff");
  const adjust = engine.adjust;

  useEffect(() => {
    setSize({ w: engine.width, h: engine.height });
  }, [engine.width, engine.height]);

  const changeW = (w: number) => {
    const next = Math.max(1, w);
    setSize({ w: next, h: ratioLock ? Math.max(1, Math.round((next * engine.height) / engine.width)) : size.h });
  };
  const changeH = (h: number) => {
    const next = Math.max(1, h);
    setSize({ h: next, w: ratioLock ? Math.max(1, Math.round((next * engine.width) / engine.height)) : size.w });
  };

  const adjustSlider = (key: "brightness" | "contrast" | "saturation" | "hue" | "gamma" | "blur", label: string, min: number, max: number, step: number) => (
    <Line label={label} key={key}>
      <Slider
        value={adjust[key]}
        min={min}
        max={max}
        step={step}
        width={100}
        onChange={(value) => engine.setAdjustments({ [key]: value } as any)}
        onCommit={() => engine.commit()}
      />
    </Line>
  );

  return (
    <>
      <Section title="Rotate & flip">
        <div className="flex flex-wrap gap-1.5">
          <SmallButton onClick={() => engine.rotate90(false)} title="Rotate 90° left">
            <Icon name="rotateCcw" size={13} /> Left
          </SmallButton>
          <SmallButton onClick={() => engine.rotate90(true)} title="Rotate 90° right">
            <Icon name="rotateCw" size={13} /> Right
          </SmallButton>
          <SmallButton onClick={() => engine.flip("x")} title="Mirror left ↔ right">
            <Icon name="flipH" size={13} /> Flip H
          </SmallButton>
          <SmallButton onClick={() => engine.flip("y")} title="Mirror top ↔ bottom">
            <Icon name="flipV" size={13} /> Flip V
          </SmallButton>
        </div>
      </Section>

      <Section title="Resize picture">
        <Line label="Size (px)">
          <NumberBox value={size.w} min={1} max={16000} width={62} onChange={changeW} />
          <span className="text-slate-500 text-[10px]">×</span>
          <NumberBox value={size.h} min={1} max={16000} width={62} onChange={changeH} />
          <IconToggle on={ratioLock} onClick={() => setRatioLock(!ratioLock)} icon={ratioLock ? "lock" : "unlock"} title="Keep proportions" />
        </Line>
        <div className="flex flex-wrap gap-1">
          {[25, 50, 75, 150, 200].map((percent) => (
            <button
              key={percent}
              className="chip"
              onClick={() =>
                setSize({ w: Math.round((engine.width * percent) / 100), h: Math.round((engine.height * percent) / 100) })
              }
            >
              {percent}%
            </button>
          ))}
        </div>
        <SmallButton primary onClick={() => engine.resizeTo(size.w, size.h)}>
          Apply resize
        </SmallButton>
      </Section>

      <Section title="Canvas size">
        <div className="grid grid-cols-2 gap-1.5">
          {(["top", "right", "bottom", "left"] as const).map((side) => (
            <label key={side} className="flex items-center justify-between text-[10px] text-slate-400 gap-1">
              {side}
              <NumberBox value={pad[side]} min={0} max={4000} width={56} onChange={(value) => setPad({ ...pad, [side]: Math.max(0, value) })} />
            </label>
          ))}
        </div>
        <Line label="Fill">
          <span />
        </Line>
        <Swatches value={padColor} allowNone onChange={setPadColor} />
        <SmallButton onClick={() => engine.padBy(pad, padColor)}>Add space around the picture</SmallButton>
      </Section>

      <Section
        title="Colours"
        action={
          hasAdjustments(adjust) ? (
            <button className="text-[9.5px] text-violet-300 hover:text-violet-200" onClick={() => engine.resetAdjustments()}>
              Reset
            </button>
          ) : null
        }
      >
        {adjustSlider("brightness", "Brightness", -1, 1, 0.02)}
        {adjustSlider("contrast", "Contrast", -1, 1, 0.02)}
        {adjustSlider("saturation", "Saturation", -1, 1, 0.02)}
        {adjustSlider("hue", "Hue", -1, 1, 0.02)}
        {adjustSlider("gamma", "Gamma", 0.3, 2.2, 0.05)}
        {adjustSlider("blur", "Soften", 0, 0.5, 0.01)}
        <div className="flex flex-wrap gap-1.5 pt-1">
          <IconToggle on={adjust.sharpen} text="Sharpen" title="Sharpen the picture" onClick={() => engine.setAdjustments({ sharpen: !adjust.sharpen }, true)} />
          <IconToggle on={adjust.grayscale} text="Grayscale" title="Black & white" onClick={() => engine.setAdjustments({ grayscale: !adjust.grayscale }, true)} />
          <IconToggle on={adjust.sepia} text="Sepia" title="Warm brown tone" onClick={() => engine.setAdjustments({ sepia: !adjust.sepia }, true)} />
          <IconToggle on={adjust.invert} text="Invert" title="Negative" onClick={() => engine.setAdjustments({ invert: !adjust.invert }, true)} />
          <IconToggle
            on={Boolean(adjust.levels)}
            text="Auto levels"
            title="Stretch the tones so the darkest pixel is black and the lightest white"
            onClick={() => (adjust.levels ? engine.setAdjustments({ levels: null }, true) : engine.autoLevels())}
          />
        </div>
        <div className="text-[10px] text-slate-500">Adjustments apply to the picture only, not to annotations.</div>
      </Section>
      <div className="h-2" />
      {size.w > 8000 || size.h > 8000 ? (
        <div className="px-3 pb-2 text-[10px] text-amber-300">Very large sizes need a lot of memory.</div>
      ) : null}
    </>
  );
}

// ---------------------------------------------------------------------------
// Effects
// ---------------------------------------------------------------------------

const BACKDROPS: { label: string; style: BackdropStyle }[] = [
  { label: "None", style: { kind: "transparent", colors: [] } },
  { label: "White", style: { kind: "solid", colors: ["#ffffff"] } },
  { label: "Slate", style: { kind: "solid", colors: ["#1e293b"] } },
  { label: "Violet", style: { kind: "gradient", colors: ["#8b5cf6", "#3b82f6"], angle: 135 } },
  { label: "Sunset", style: { kind: "gradient", colors: ["#f97316", "#ec4899"], angle: 135 } },
  { label: "Ocean", style: { kind: "gradient", colors: ["#06b6d4", "#3b82f6", "#6366f1"], angle: 120 } },
  { label: "Mint", style: { kind: "gradient", colors: ["#34d399", "#06b6d4"], angle: 135 } },
  { label: "Night", style: { kind: "gradient", colors: ["#0f172a", "#4338ca"], angle: 135 } },
];

function EdgeToggles({ edges, onChange }: { edges: Edges; onChange: (edges: Edges) => void }) {
  return (
    <div className="flex gap-1">
      {(["top", "right", "bottom", "left"] as const).map((side) => (
        <IconToggle key={side} on={edges[side]} text={side[0].toUpperCase() + side.slice(1)} title={`${side} edge`} onClick={() => onChange({ ...edges, [side]: !edges[side] })} />
      ))}
    </div>
  );
}

export function EffectsPanel({ engine, toast, plugins }: PanelProps & { plugins: PluginManifest[] }) {
  const [padding, setPadding] = useState(64);
  const [radius, setRadius] = useState(16);
  const [backdrop, setBackdrop] = useState(3);
  const [shadow, setShadow] = useState(true);
  const [frameWidth, setFrameWidth] = useState(8);
  const [frameColor, setFrameColor] = useState<string | null>("#8b5cf6");
  const [corner, setCorner] = useState(24);
  const [torn, setTorn] = useState<Edges>({ top: false, right: false, bottom: true, left: false });
  const [tornDepth, setTornDepth] = useState(14);
  const [fade, setFade] = useState<Edges>({ top: false, right: false, bottom: true, left: false });
  const [fadeSize, setFadeSize] = useState(60);
  const [mark, setMark] = useState<WatermarkOptions>({
    text: "© SnapPro",
    size: 36,
    opacity: 0.35,
    color: "#ffffff",
    position: "bottom-right",
    angle: 0,
  });

  const run = (label: string, effect: (flat: HTMLCanvasElement) => HTMLCanvasElement) => {
    try {
      engine.bake(effect);
      toast(`${label} applied (layers merged — Ctrl+Z to undo)`, "success");
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), "error");
    }
  };

  const applyPlugin = (tool: { id: string; label: string; effect?: string; amount?: number }) => {
    const amount = tool.amount ?? 1;
    switch (tool.effect) {
      case "sepia":
        engine.setAdjustments({ sepia: true }, true);
        break;
      case "grayscale":
        engine.setAdjustments({ grayscale: true }, true);
        break;
      case "invert":
        engine.setAdjustments({ invert: true }, true);
        break;
      case "blur":
        engine.setAdjustments({ blur: Math.min(0.5, amount) }, true);
        break;
      case "brightness":
        engine.setAdjustments({ brightness: Math.max(-1, Math.min(1, amount)) }, true);
        break;
      case "contrast":
        engine.setAdjustments({ contrast: Math.max(-1, Math.min(1, amount)) }, true);
        break;
      case "crop": {
        // `amount` is width / height; crop the largest centred area with that shape.
        const ratio = amount > 0 ? amount : 1;
        let w = engine.width;
        let h = Math.round(w / ratio);
        if (h > engine.height) {
          h = engine.height;
          w = Math.round(h * ratio);
        }
        engine.cropTo((engine.width - w) / 2, (engine.height - h) / 2, w, h);
        break;
      }
      default:
        toast(`This plugin tool (${tool.effect ?? "unknown"}) is not supported by the editor yet`, "error");
        return;
    }
    toast(`${tool.label} applied`, "success");
  };

  return (
    <>
      <Section title="Beautify">
        <div className="grid grid-cols-4 gap-1">
          {BACKDROPS.map((item, index) => {
            const css =
              item.style.kind === "gradient"
                ? `linear-gradient(135deg, ${item.style.colors.join(",")})`
                : item.style.kind === "solid"
                  ? item.style.colors[0]
                  : "repeating-conic-gradient(#475569 0% 25%, #1e293b 0% 50%) 50% / 10px 10px";
            return (
              <button
                key={item.label}
                title={item.label}
                className={`h-7 rounded-md border ${backdrop === index ? "border-white/90" : "border-white/15"}`}
                style={{ background: css }}
                onClick={() => setBackdrop(index)}
              />
            );
          })}
        </div>
        <Line label="Padding">
          <Slider value={padding} min={0} max={240} onChange={setPadding} width={100} />
        </Line>
        <Line label="Rounded">
          <Slider value={radius} min={0} max={80} onChange={setRadius} width={100} />
        </Line>
        <Line label="Shadow">
          <IconToggle on={shadow} text="Soft shadow" title="Drop shadow behind the picture" onClick={() => setShadow(!shadow)} />
        </Line>
        <SmallButton
          primary
          onClick={() =>
            run("Beautify", (flat) =>
              beautify(flat, {
                padding,
                radius,
                backdrop: BACKDROPS[backdrop].style,
                shadow: shadow ? { blur: Math.max(12, padding * 0.5), offsetY: Math.max(6, padding * 0.18), opacity: 0.45 } : null,
              }),
            )
          }
        >
          Apply
        </SmallButton>
      </Section>

      <Section title="Frame">
        <Line label="Width">
          <Slider value={frameWidth} min={1} max={60} onChange={setFrameWidth} width={100} />
        </Line>
        <Swatches value={frameColor} onChange={(color) => color && setFrameColor(color)} />
        <SmallButton onClick={() => run("Frame", (flat) => addFrame(flat, frameWidth, frameColor ?? "#8b5cf6", 0))}>Add frame</SmallButton>
      </Section>

      <Section title="Rounded corners">
        <Line label="Radius">
          <Slider value={corner} min={2} max={160} onChange={setCorner} width={100} />
        </Line>
        <SmallButton onClick={() => run("Rounded corners", (flat) => roundCorners(flat, corner))}>Round the corners</SmallButton>
      </Section>

      <Section title="Torn edge">
        <EdgeToggles edges={torn} onChange={setTorn} />
        <Line label="Depth">
          <Slider value={tornDepth} min={4} max={60} onChange={setTornDepth} width={100} />
        </Line>
        <SmallButton onClick={() => run("Torn edge", (flat) => tornEdge(flat, torn, tornDepth))}>Tear it</SmallButton>
      </Section>

      <Section title="Fade edge">
        <EdgeToggles edges={fade} onChange={setFade} />
        <Line label="Length">
          <Slider value={fadeSize} min={8} max={400} onChange={setFadeSize} width={100} />
        </Line>
        <SmallButton onClick={() => run("Fade", (flat) => fadeEdge(flat, fade, fadeSize))}>Fade it out</SmallButton>
      </Section>

      <Section title="Watermark">
        <input
          className="text-input !py-1 !text-[11px]"
          value={mark.text}
          placeholder="Watermark text"
          onChange={(event) => setMark({ ...mark, text: event.target.value })}
        />
        <Line label="Size">
          <Slider value={mark.size} min={10} max={200} onChange={(value) => setMark({ ...mark, size: value })} width={100} />
        </Line>
        <Line label="Opacity">
          <Slider value={mark.opacity} min={0.05} max={1} step={0.05} onChange={(value) => setMark({ ...mark, opacity: value })} width={100} />
        </Line>
        <Line label="Angle">
          <Slider value={mark.angle} min={-90} max={90} onChange={(value) => setMark({ ...mark, angle: value })} width={100} suffix="°" />
        </Line>
        <Line label="Where">
          <select
            className="text-input !py-1 !text-[10.5px] w-[120px]"
            value={mark.position}
            onChange={(event) => setMark({ ...mark, position: event.target.value as WatermarkOptions["position"] })}
          >
            <option value="bottom-right">Bottom right</option>
            <option value="bottom-left">Bottom left</option>
            <option value="top-right">Top right</option>
            <option value="top-left">Top left</option>
            <option value="center">Centre</option>
            <option value="tile">Tiled</option>
          </select>
        </Line>
        <Swatches value={mark.color} onChange={(color) => color && setMark({ ...mark, color })} />
        <SmallButton onClick={() => run("Watermark", (flat) => watermark(flat, mark))}>Stamp watermark</SmallButton>
      </Section>

      <Section title="Plugins">
        {plugins.length === 0 ? (
          <div className="text-[10.5px] text-slate-500">No plugins installed. Add a JSON plugin from the main window → Plugins.</div>
        ) : (
          plugins.map((plugin) => (
            <div key={plugin.id}>
              <div className="text-[10px] text-slate-500 mb-1">{plugin.name}</div>
              <div className="flex flex-wrap gap-1">
                {plugin.tools.map((tool) => (
                  <button key={tool.id} className="chip" onClick={() => applyPlugin(tool)} title={tool.effect}>
                    {tool.label}
                  </button>
                ))}
              </div>
            </div>
          ))
        )}
      </Section>
    </>
  );
}
