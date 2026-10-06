import { useEffect, useMemo, useState } from "react";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import * as api from "../lib/api";
import { useStore } from "../lib/store";
import { Icon } from "./Icon";
import { Seg, Switch } from "./PanelUI";

export type PdfSource =
  | { kind: "files"; paths: string[]; sizes: [number, number][] }
  | { kind: "data"; dataUrl: string; sizes: [number, number][] };

const STORE_KEY = "snappro.pdfOptions";

function loadOptions(): api.PdfOptions {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) return { ...api.defaultPdfOptions, ...JSON.parse(raw) };
  } catch {
    /* storage can be blocked */
  }
  return { ...api.defaultPdfOptions };
}

const PAPER: { value: api.PdfOptions["pageSize"]; label: string; note: string }[] = [
  { value: "a4", label: "A4", note: "210 × 297 mm" },
  { value: "letter", label: "Letter", note: "8.5 × 11 in" },
  { value: "a3", label: "A3", note: "297 × 420 mm" },
  { value: "a5", label: "A5", note: "148 × 210 mm" },
  { value: "legal", label: "Legal", note: "8.5 × 14 in" },
  { value: "tabloid", label: "Tabloid", note: "11 × 17 in" },
  { value: "image", label: "As image", note: "page = picture" },
];

export function PdfDialog({
  source,
  onClose,
  onDone,
}: {
  source: PdfSource;
  onClose: () => void;
  onDone?: (path: string) => void;
}) {
  const toast = useStore((s) => s.toast);
  const exportDir = useStore((s) => s.settings?.exportDir || s.settings?.saveDir || "");
  const [options, setOptions] = useState<api.PdfOptions>(loadOptions);
  const [plan, setPlan] = useState<api.PdfPagePlan[]>([]);
  const [busy, setBusy] = useState(false);

  const set = <K extends keyof api.PdfOptions>(key: K, value: api.PdfOptions[K]) =>
    setOptions((current) => ({ ...current, [key]: value }));

  useEffect(() => {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(options));
    } catch {
      /* ignore */
    }
    let alive = true;
    api
      .pdfPlan(source.sizes, options)
      .then((pages) => alive && setPlan(Array.isArray(pages) ? pages : []))
      .catch(() => alive && setPlan([]));
    return () => {
      alive = false;
    };
  }, [options, source]);

  const minDpi = useMemo(() => {
    const values = plan.flatMap((p) => p.tiles.map((t) => t.dpi)).filter((d) => d > 0);
    return values.length ? Math.round(Math.min(...values)) : 0;
  }, [plan]);

  const first = plan[0];
  const previewScale = first ? 150 / Math.max(first.width, first.height) : 1;

  const create = async () => {
    setBusy(true);
    try {
      const target = await saveDialog({
        title: "Save PDF",
        defaultPath: exportDir ? `${exportDir.replace(/[\\/]+$/, "")}${exportDir.includes("\\") ? "\\" : "/"}SnapPro.pdf` : "SnapPro.pdf",
        filters: [{ name: "PDF", extensions: ["pdf"] }],
      });
      if (!target) return;
      const path =
        source.kind === "files"
          ? await api.exportPdf(source.paths, target, options)
          : await api.exportPdfData(source.dataUrl, target, options);
      toast(`PDF saved: ${path.split(/[\\/]/).pop()} (${plan.length} page${plan.length === 1 ? "" : "s"})`, "success");
      onDone?.(path);
      onClose();
    } catch (error) {
      toast(api.errorMessage(error), "error");
    } finally {
      setBusy(false);
    }
  };

  const quality = [
    { value: "auto", label: "Original" },
    { value: "lossless", label: "Lossless" },
    { value: "high", label: "High" },
    { value: "small", label: "Small" },
  ];

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/60 p-3" onMouseDown={onClose}>
      <div
        className="solid-panel w-full max-w-[640px] max-h-full overflow-y-auto rounded-2xl border border-white/12 p-4"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-3">
          <div>
            <div className="text-[14px] font-semibold text-slate-100">Export as PDF</div>
            <div className="text-[10px] text-slate-400">
              {source.sizes.length} picture{source.sizes.length === 1 ? "" : "s"} → {plan.length} page
              {plan.length === 1 ? "" : "s"}
              {minDpi ? ` · prints at ${minDpi} dpi or better` : ""}
            </div>
          </div>
          <button className="win-ctrl" onClick={onClose} title="Close">
            <Icon name="close" size={14} />
          </button>
        </div>

        <div className="grid gap-4 sm:grid-cols-[1fr_170px]">
          <div className="space-y-3 min-w-0">
            <Field label="Paper size">
              <div className="grid grid-cols-4 gap-1">
                {PAPER.map((p) => (
                  <button
                    key={p.value}
                    title={p.note}
                    className={`chip ${options.pageSize === p.value ? "is-active" : ""}`}
                    onClick={() => set("pageSize", p.value)}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
            </Field>
            {options.pageSize !== "image" && (
              <Field label="Orientation">
                <Seg
                  value={options.orientation}
                  onChange={(v) => set("orientation", v as api.PdfOptions["orientation"])}
                  options={[
                    { value: "auto", label: "Auto" },
                    { value: "portrait", label: "Portrait" },
                    { value: "landscape", label: "Landscape" },
                  ]}
                />
              </Field>
            )}
            <Field label="Picture quality">
              <Seg value={options.quality} onChange={(v) => set("quality", v as api.PdfOptions["quality"])} options={quality} />
              <div className="text-[9.5px] text-slate-500 mt-1">
                Original keeps a JPG exactly as it is and PNG without any loss. Small re-compresses to save space.
              </div>
            </Field>
            <Field label="Picture on the page">
              <Seg
                value={options.fit}
                onChange={(v) => set("fit", v as api.PdfOptions["fit"])}
                options={[
                  { value: "fit", label: "Fit page" },
                  { value: "fill", label: "Fill (crop)" },
                  { value: "actual", label: "Actual size" },
                ]}
              />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Margins">
                <Seg
                  value={options.margin}
                  onChange={(v) => set("margin", v as api.PdfOptions["margin"])}
                  options={[
                    { value: "none", label: "0" },
                    { value: "small", label: "S" },
                    { value: "normal", label: "M" },
                    { value: "large", label: "L" },
                  ]}
                />
              </Field>
              <Field label="Per page">
                <Seg
                  value={String(options.perPage)}
                  onChange={(v) => set("perPage", Number(v) as 1 | 2 | 4)}
                  options={[
                    { value: "1", label: "1" },
                    { value: "2", label: "2" },
                    { value: "4", label: "4" },
                  ]}
                />
              </Field>
            </div>
            <div className="space-y-1.5">
              <Toggle label="Cut tall pictures into pages" hint="Scrolling captures" on={options.splitTall} onChange={(v) => set("splitTall", v)} />
              <Toggle label="Do not enlarge small pictures" on={options.neverEnlarge} onChange={(v) => set("neverEnlarge", v)} />
              <Toggle label="Page numbers" on={options.pageNumbers} onChange={(v) => set("pageNumbers", v)} />
              <Toggle label="File name under each picture" on={options.captions} onChange={(v) => set("captions", v)} />
            </div>
            <Field label="Page colour">
              <div className="flex items-center gap-2">
                {["#ffffff", "#f3f4f6", "#111827", "#000000"].map((c) => (
                  <button
                    key={c}
                    className={`w-6 h-6 rounded-md border ${options.background === c ? "border-violet-400 ring-2 ring-violet-400/40" : "border-white/25"}`}
                    style={{ background: c }}
                    onClick={() => set("background", c)}
                    title={c}
                  />
                ))}
                <input
                  type="color"
                  className="w-7 h-7 bg-transparent"
                  value={options.background}
                  onChange={(e) => set("background", e.target.value)}
                />
              </div>
            </Field>
            {options.pageSize === "image" || options.fit === "actual" ? (
              <Field label={`Picture density · ${options.dpi} dpi`}>
                <input
                  type="range"
                  min={72}
                  max={300}
                  step={6}
                  value={options.dpi}
                  onChange={(e) => set("dpi", Number(e.target.value))}
                  className="w-full"
                />
              </Field>
            ) : null}
          </div>

          <div className="flex flex-col items-center gap-2">
            <div className="text-[10px] uppercase tracking-wide text-slate-400">Preview · page 1</div>
            {first ? (
              <div
                className="relative shadow-lg border border-white/20"
                style={{
                  width: first.width * previewScale,
                  height: first.height * previewScale,
                  background: options.background,
                }}
              >
                {first.tiles.map((tile, index) => {
                  const [x, y, w, h] = tile.rect;
                  return (
                    <div
                      key={index}
                      className="absolute bg-gradient-to-br from-violet-400/70 to-sky-400/70 border border-white/40"
                      style={{
                        left: x * previewScale,
                        top: (first.height - y - h) * previewScale,
                        width: w * previewScale,
                        height: h * previewScale,
                      }}
                    />
                  );
                })}
              </div>
            ) : null}
            <div className="text-[9.5px] text-slate-500 text-center">Saved to the chosen folder; you pick the name next.</div>
          </div>
        </div>

        <div className="flex justify-end gap-2 mt-4">
          <button className="ghost-btn" onClick={onClose}>
            Cancel
          </button>
          <button className="primary-btn" onClick={() => void create()} disabled={busy || plan.length === 0}>
            <Icon name="download" size={14} />
            {busy ? "Creating…" : "Create PDF"}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="text-[10px] font-medium uppercase tracking-wide text-slate-400 mb-1">{label}</div>
      {children}
    </div>
  );
}

function Toggle({ label, hint, on, onChange }: { label: string; hint?: string; on: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <div className="text-[11px] text-slate-300">
        {label}
        {hint ? <span className="text-slate-500"> · {hint}</span> : null}
      </div>
      <Switch on={on} onChange={onChange} />
    </div>
  );
}
