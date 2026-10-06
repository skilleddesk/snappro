import { Icon } from "./Icon";
import { useStore } from "../lib/store";

// ---------------------------------------------------------------------------
// Shared shell
// ---------------------------------------------------------------------------

export function PanelShell({
  title,
  subtitle,
  children,
  actions,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  actions?: React.ReactNode;
}) {
  const back = useStore((s) => s.back);
  return (
    <div className="panel-enter glass-panel rounded-2xl !absolute inset-0 flex flex-col z-40">
      <div
        className="drag-handle flex items-center gap-2 h-11 px-2.5 border-b border-white/5"
        data-tauri-drag-region
      >
        <button className="win-ctrl" title="Back" onClick={back}>
          <Icon name="chevronLeft" size={15} strokeWidth={2} />
        </button>
        <div className="flex-1 min-w-0">
          <div className="text-[12px] font-semibold text-white tracking-tight truncate">{title}</div>
          {subtitle ? (
            <div className="text-[9.5px] text-slate-500 truncate">{subtitle}</div>
          ) : null}
        </div>
        {actions}
      </div>
      <div className="flex-1 overflow-y-auto thin-scroll p-3.5">{children}</div>
    </div>
  );
}

export function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 py-2">
      <div className="min-w-0">
        <div className="text-[11px] font-medium text-slate-300">{label}</div>
        {hint ? <div className="text-[9.5px] text-slate-500 mt-0.5">{hint}</div> : null}
      </div>
      {children}
    </div>
  );
}

/** Small segmented control: one option visible, the rest muted. */
export function Seg({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <div className="flex gap-1 p-0.5 rounded-xl bg-white/[0.04] border border-white/8">
      {options.map((option) => (
        <button
          key={option.value}
          className={`flex-1 rounded-lg py-1.5 text-[10px] transition-all ${
            value === option.value
              ? "bg-violet-500/25 text-violet-100"
              : "text-slate-400 hover:text-slate-200"
          }`}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function Switch({ on, onChange }: { on: boolean; onChange: (value: boolean) => void }) {
  return (
    <button className={`switch ${on ? "on" : ""}`} onClick={() => onChange(!on)}>
      <span />
    </button>
  );
}
export function EmptyState({ icon, title, hint }: { icon: string; title: string; hint?: string }) {
  return (
    <div className="flex flex-col items-center justify-center text-center py-10 px-6">
      <div className="w-11 h-11 rounded-2xl bg-white/5 border border-white/10 flex items-center justify-center text-slate-500 mb-3">
        <Icon name={icon} size={20} />
      </div>
      <div className="text-[12px] font-medium text-slate-300">{title}</div>
      {hint ? <div className="text-[10px] text-slate-500 mt-1 leading-relaxed">{hint}</div> : null}
    </div>
  );
}
