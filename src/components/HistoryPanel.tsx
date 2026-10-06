import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "./Icon";
import * as api from "../lib/api";
import { useStore } from "../lib/store";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { EmptyState, PanelShell } from "./PanelUI";
import { PdfDialog, type PdfSource } from "./PdfDialog";

const PAGE = 48;

export function HistoryPanel() {
  const { library, loadLibrary, toast, openInEditor, selected, toggleSelected, clearSelected } = useStore();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "image" | "video">("all");
  const [pdfSource, setPdfSource] = useState<PdfSource | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [armedDelete, setArmedDelete] = useState<string | null>(null);
  const [limit, setLimit] = useState(PAGE);

  useEffect(() => {
    void loadLibrary();
  }, [loadLibrary]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return library
      .filter((item) => (filter === "all" ? true : item.kind === filter))
      .filter((item) => (q ? item.name.toLowerCase().includes(q) : true));
  }, [library, query, filter]);
  const items = filtered.slice(0, limit);

  const remove = async (path: string) => {
    // Two-step delete: the first click arms the button, the second one deletes.
    if (armedDelete !== path) {
      setArmedDelete(path);
      window.setTimeout(() => setArmedDelete((current) => (current === path ? null : current)), 3000);
      return;
    }
    setArmedDelete(null);
    try {
      await api.libraryDelete(path);
      toast("Item deleted");
      await loadLibrary();
    } catch (error) {
      toast(api.errorMessage(error), "error");
    }
  };

  const doRename = async (path: string) => {
    if (renaming !== path) return;
    setRenaming(null);
    if (!renameValue.trim()) return;
    try {
      await api.libraryRename(path, renameValue);
      toast("Renamed");
      await loadLibrary();
    } catch (error) {
      toast(api.errorMessage(error), "error");
    }
  };

  const exportSelection = async () => {
    if (selected.length === 0) {
      toast("Select items first", "error");
      return;
    }
    try {
      const dir = await openDialog({ directory: true, title: "Export selected items to…" });
      if (typeof dir !== "string") return;
      for (const path of selected) await api.libraryExport(path, dir);
      toast(`${selected.length} item(s) exported`);
      clearSelected();
    } catch (error) {
      toast(api.errorMessage(error), "error");
    }
  };

  const pdfFromSelection = async () => {
    const images = selected.length ? selected : items.filter((i) => i.kind === "image").map((i) => i.path);
    if (images.length === 0) {
      toast("No images to convert", "error");
      return;
    }
    const chosen = images.map((p) => items.find((i) => i.path === p) ?? library.find((i) => i.path === p));
    setPdfSource({
      kind: "files",
      paths: images,
      sizes: chosen.map((i) => [i?.width ?? 1000, i?.height ?? 700] as [number, number]),
    });
  };

  return (
    <>
      {pdfSource ? <PdfDialog source={pdfSource} onClose={() => setPdfSource(null)} /> : null}
    <PanelShell
      title="History"
      subtitle={`${library.length} items · ${selected.length} selected`}
      actions={
        <button className="win-ctrl" title="Refresh" onClick={() => void loadLibrary()}>
          <Icon name="refresh" size={14} strokeWidth={2} />
        </button>
      }
    >
      <div className="flex items-center gap-1.5 mb-2.5">
        <div className="relative flex-1">
          <Icon name="search" size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500" />
          <input
            className="text-input pl-7"
            placeholder="Search captures…"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setLimit(PAGE);
            }}
          />
        </div>
        <select
          className="text-input w-[74px]"
          value={filter}
          onChange={(e) => {
            setFilter(e.target.value as typeof filter);
            setLimit(PAGE);
          }}
        >
          <option value="all">All</option>
          <option value="image">Images</option>
          <option value="video">Videos</option>
        </select>
      </div>

      <div className="flex items-center gap-1.5 mb-2.5">
        <button className="chip" onClick={() => void pdfFromSelection()}>PDF</button>
        <button className="chip" onClick={() => void exportSelection()}>Export</button>
        <button className="chip" onClick={clearSelected}>Clear</button>
        <button className="chip ml-auto" onClick={() => void api.openFolder(useStore.getState().settings?.saveDir ?? "")}>
          Open folder
        </button>
      </div>

      {items.length === 0 ? (
        <EmptyState icon="history" title="No captures yet" hint="Every screenshot and recording you make shows up here." />
      ) : (
        <div className="grid grid-cols-2 gap-2">
          {items.map((item) => (
            <HistoryCard
              key={item.path}
              item={item}
              selected={selected.includes(item.path)}
              armedDelete={armedDelete === item.path}
              onSelect={() => toggleSelected(item.path)}
              onEdit={() => openInEditor(item.path)}
              onDelete={() => void remove(item.path)}
              onReveal={() => void api.revealItem(item.path)}
              onRename={() => {
                setRenaming(item.path);
                setRenameValue(item.name.replace(/\.[^.]+$/, ""));
              }}
              renaming={renaming === item.path}
              renameValue={renameValue}
              setRenameValue={setRenameValue}
              commitRename={() => void doRename(item.path)}
            />
          ))}
        </div>
      )}
      {filtered.length > limit ? (
        <button className="ghost-btn w-full mt-3" onClick={() => setLimit((n) => n + PAGE)}>
          Show more ({filtered.length - limit} left)
        </button>
      ) : null}
    </PanelShell>
    </>
  );
}

function HistoryCard({
  item,
  selected,
  armedDelete,
  onSelect,
  onEdit,
  onDelete,
  onReveal,
  onRename,
  renaming,
  renameValue,
  setRenameValue,
  commitRename,
}: {
  item: api.LibraryItem;
  selected: boolean;
  armedDelete: boolean;
  onSelect: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onReveal: () => void;
  onRename: () => void;
  renaming: boolean;
  renameValue: string;
  setRenameValue: (value: string) => void;
  commitRename: () => void;
}) {
  const [thumb, setThumb] = useState<string | null>(null);
  const [visible, setVisible] = useState(false);
  const holder = useRef<HTMLDivElement | null>(null);

  // Thumbnails are loaded only for cards that scroll into view, and come from
  // a small cached JPEG instead of the full-size capture.
  useEffect(() => {
    const node = holder.current;
    if (!node || typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "120px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!visible) return;
    let alive = true;
    void api
      .libraryThumbnail(item.path, 240)
      .then((data) => {
        if (alive) setThumb(data);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [visible, item.path]);

  const copyItem = async () => {
    try {
      await api.copyImageFile(item.path);
      useStore.getState().toast("Copied to clipboard");
    } catch (error) {
      useStore.getState().toast(api.errorMessage(error), "error");
    }
  };

  return (
    <div
      ref={holder}
      className={`rounded-xl border overflow-hidden transition-all ${
        selected
          ? "border-violet-500/60 shadow-[0_0_14px_-4px_rgba(139,92,246,0.7)]"
          : "border-white/8 hover:border-violet-400/30"
      } bg-black/30`}
    >
      <button className="block w-full h-[76px] relative" onClick={onSelect} title="Select">
        {thumb ? (
          <img src={thumb} alt={item.name} className="w-full h-full object-cover" />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-slate-600">
            <Icon name={item.kind === "video" ? "play" : "image"} size={20} />
          </div>
        )}
        {item.kind === "video" && thumb ? (
          <span className="absolute inset-0 flex items-center justify-center">
            <span className="w-7 h-7 rounded-full bg-black/60 flex items-center justify-center">
              <Icon name="play" size={12} stroke="#fff" />
            </span>
          </span>
        ) : null}
        {selected ? (
          <span className="absolute top-1 left-1 w-4 h-4 rounded-md bg-violet-500 flex items-center justify-center">
            <Icon name="check" size={11} stroke="#fff" strokeWidth={3} />
          </span>
        ) : null}
        <span className="absolute bottom-1 right-1 text-[8.5px] font-mono px-1.5 py-0.5 rounded bg-black/70 text-slate-300">
          {item.width && item.height ? `${item.width}×${item.height}` : item.kind}
        </span>
      </button>
      <div className="px-2 py-1.5">
        {renaming ? (
          <input
            autoFocus
            className="text-input !py-1 !text-[10px]"
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitRename();
            }}
          />
        ) : (
          <div className="text-[10px] text-slate-300 truncate" title={item.name}>
            {item.name}
          </div>
        )}
        <div className="flex items-center justify-between mt-1">
          <span className="text-[9px] font-mono text-slate-500">{api.formatBytes(item.sizeBytes)}</span>
          <div className="flex items-center gap-0.5">
            {item.kind === "image" ? (
              <button className="win-ctrl !w-6 !h-6" title="Open in editor" onClick={onEdit}>
                <Icon name="pencil" size={12} />
              </button>
            ) : (
              <button className="win-ctrl !w-6 !h-6" title="Play" onClick={() => void api.openPath(item.path)}>
                <Icon name="play" size={12} />
              </button>
            )}
            {item.kind === "image" ? (
              <button className="win-ctrl !w-6 !h-6" title="Copy" onClick={() => void copyItem()}>
                <Icon name="copy" size={12} />
              </button>
            ) : null}
            <button className="win-ctrl !w-6 !h-6" title="Show in folder" onClick={onReveal}>
              <Icon name="folder" size={12} />
            </button>
            <button className="win-ctrl !w-6 !h-6" title="Rename" onClick={onRename}>
              <Icon name="text" size={12} />
            </button>
            <button
              className={`win-ctrl !w-6 !h-6 ${armedDelete ? "!bg-rose-500/90 !text-white" : "hover:!bg-rose-500/80"}`}
              title={armedDelete ? "Click again to delete" : "Delete"}
              onClick={onDelete}
            >
              <Icon name="trash" size={12} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
