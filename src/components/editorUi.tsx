import type { ReactNode } from "react";
import { Icon } from "./Icon";

export const PALETTE = [
  "#ef4444",
  "#f97316",
  "#facc15",
  "#22c55e",
  "#14b8a6",
  "#3b82f6",
  "#8b5cf6",
  "#ec4899",
  "#ffffff",
  "#94a3b8",
  "#334155",
  "#000000",
];

export function Section({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <div className="px-3 py-2.5 border-b border-white/5">
      <div className="flex items-center justify-between mb-2">
        <span className="section-label !text-[9px]">{title}</span>
        {action}
      </div>
      <div className="space-y-2">{children}</div>
    </div>
  );
}

export function Line({ label, children }: { label?: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-2 min-h-[24px]">
      {label ? <span className="text-[10.5px] text-slate-400 shrink-0">{label}</span> : null}
      <div className="flex items-center gap-1.5 min-w-0 ml-auto">{children}</div>
    </div>
  );
}

export function Slider({
  value,
  min,
  max,
  step = 1,
  onChange,
  onCommit,
  width = 110,
  suffix = "",
}: {
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (value: number) => void;
  onCommit?: () => void;
  width?: number;
  suffix?: string;
}) {
  return (
    <>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={Number.isFinite(value) ? value : min}
        onChange={(event) => onChange(Number(event.target.value))}
        onPointerUp={onCommit}
        onKeyUp={onCommit}
        className="accent-violet-500"
        style={{ width }}
      />
      <span className="text-[10px] font-mono text-slate-400 w-10 text-right tabular-nums">
        {!Number.isFinite(value) ? "–" : Number.isInteger(value) ? value : value.toFixed(2)}
        {suffix}
      </span>
    </>
  );
}

const RECENT_KEY = "snappro.recentColors";

function readRecent(): string[] {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((c) => typeof c === "string").slice(0, 8) : [];
  } catch {
    return [];
  }
}

function rememberColor(color: string) {
  try {
    const next = [color, ...readRecent().filter((c) => c.toLowerCase() !== color.toLowerCase())].slice(0, 8);
    window.localStorage.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    /* storage may be unavailable */
  }
}

export function Swatches({
  value,
  onChange,
  allowNone,
}: {
  value: string | null;
  onChange: (color: string | null) => void;
  allowNone?: boolean;
}) {
  const recent = readRecent().filter((c) => !PALETTE.includes(c.toLowerCase()));
  const pick = (color: string | null) => {
    if (color) rememberColor(color);
    onChange(color);
  };
  return (
    <div className="flex flex-wrap items-center gap-1">
      {allowNone ? (
        <button
          className={`w-5 h-5 rounded-md border relative overflow-hidden ${value === null ? "border-white/80" : "border-white/15"}`}
          onClick={() => pick(null)}
          title="No colour"
        >
          <span className="absolute inset-0 bg-white/10" />
          <span className="absolute left-0 right-0 top-1/2 h-px bg-rose-400 rotate-45" />
        </button>
      ) : null}
      {PALETTE.map((swatch) => (
        <button
          key={swatch}
          className={`w-5 h-5 rounded-md border transition-transform hover:scale-110 ${
            value?.toLowerCase() === swatch ? "border-white/90 scale-110" : "border-white/15"
          }`}
          style={{ background: swatch }}
          onClick={() => pick(swatch)}
          title={swatch}
        />
      ))}
      {recent.map((color) => (
        <button
          key={`recent-${color}`}
          className={`w-5 h-5 rounded-md border ${value?.toLowerCase() === color.toLowerCase() ? "border-white/90 scale-110" : "border-dashed border-white/30"}`}
          style={{ background: color }}
          onClick={() => pick(color)}
          title={`Recent ${color}`}
        />
      ))}
      <input
        type="color"
        value={value && /^#[0-9a-f]{6}$/i.test(value) ? value : "#ffffff"}
        onChange={(event) => onChange(event.target.value)}
        onBlur={(event) => rememberColor(event.target.value)}
        className="w-5 h-5 rounded-md bg-transparent border border-white/15 cursor-pointer"
        title="Custom colour"
      />
    </div>
  );
}

export function Seg<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: ReactNode; title?: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <div className="flex gap-0.5 p-0.5 rounded-lg bg-white/[0.04] border border-white/8">
      {options.map((option) => (
        <button
          key={option.value}
          title={option.title}
          className={`px-2 py-1 rounded-md text-[10px] transition-all ${
            value === option.value ? "bg-violet-500/30 text-violet-100" : "text-slate-400 hover:text-slate-200"
          }`}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function IconToggle({
  on,
  onClick,
  icon,
  title,
  text,
}: {
  on?: boolean;
  onClick: () => void;
  icon?: string;
  title: string;
  text?: string;
}) {
  return (
    <button
      title={title}
      onClick={onClick}
      className={`h-6 min-w-[24px] px-1.5 rounded-md border text-[10.5px] font-semibold flex items-center justify-center transition-all ${
        on
          ? "bg-violet-500/30 border-violet-400/50 text-violet-100"
          : "border-white/10 text-slate-400 hover:text-slate-100 hover:border-white/25"
      }`}
    >
      {icon ? <Icon name={icon} size={13} /> : text}
    </button>
  );
}

export function NumberBox({
  value,
  onChange,
  min,
  max,
  width = 56,
  title,
}: {
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  width?: number;
  title?: string;
}) {
  return (
    <input
      type="number"
      title={title}
      className="text-input !py-0.5 !px-1.5 !text-[10.5px] text-center"
      style={{ width }}
      min={min}
      max={max}
      value={Number.isFinite(value) ? Math.round(value) : 0}
      onChange={(event) => {
        const next = Number(event.target.value);
        if (Number.isFinite(next)) onChange(next);
      }}
    />
  );
}

export function SmallButton({
  children,
  onClick,
  disabled,
  primary,
  title,
  className = "",
}: {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  primary?: boolean;
  title?: string;
  className?: string;
}) {
  return (
    <button
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={`${primary ? "primary-btn !py-1.5 !px-3 !text-[10.5px]" : "ghost-btn !py-1 !px-2 !text-[10.5px]"} ${className}`}
    >
      {children}
    </button>
  );
}
