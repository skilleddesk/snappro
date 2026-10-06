import { useEffect, useState } from "react";
import { Icon } from "./Icon";
import * as api from "../lib/api";
import { EVENTS, on } from "../lib/api";
import { useStore } from "../lib/store";

/** Small floating preview window: copy, edit, share or reveal the last capture. */
export function PreviewWindow() {
  const [capture, setCapture] = useState<api.CaptureResult | null>(null);
  const [data, setData] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmShare, setConfirmShare] = useState(false);
  const { toast, loadLibrary } = useStore();

  const load = async (result: api.CaptureResult) => {
    setCapture(result);
    setConfirmShare(false);
    try {
      setData(await api.readImageData(result.path));
    } catch {
      setData(null);
    }
  };

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void on<api.CaptureResult>(EVENTS.previewImage, (payload) => void load(payload)).then(
      (fn) => (unlisten = fn),
    );
    const state = useStore.getState();
    if (state.lastCapture) void load(state.lastCapture);
    // The window is often shown for the first time by the very capture it has
    // to display, so the one-shot event can fire before this listener exists.
    // Asking Rust for the stored capture removes that race.
    void api
      .lastCapture()
      .then((latest) => {
        if (latest) void load(latest);
      })
      .catch(() => undefined);
    return () => unlisten?.();
  }, []);

  const act = async (task: () => Promise<unknown>, message: string) => {
    setBusy(true);
    try {
      await task();
      toast(message);
    } catch (error) {
      toast(api.errorMessage(error), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="h-screen w-screen p-1.5 flex flex-col">
      <div className="glass-panel solid-panel drag-handle rounded-xl flex flex-col flex-1 overflow-hidden">
        <div
          className="drag-handle flex items-center justify-between h-9 px-2.5 border-b border-white/5"
          data-tauri-drag-region
        >
          <div className="flex items-center gap-2 min-w-0" data-tauri-drag-region>
            <span className="brand-logo w-5 h-5 rounded-md flex items-center justify-center">
              <Icon name="logo" size={11} strokeWidth={2.4} stroke="#fff" />
            </span>
            <span className="text-[11px] font-medium text-slate-200 truncate">
              {capture?.mode ? `Captured · ${capture.mode}` : "Preview"}
            </span>
          </div>
          <button className="win-ctrl !w-6 !h-6" title="Close" onClick={() => void api.closeWindow("preview")}>
            <Icon name="close" size={13} strokeWidth={2.2} />
          </button>
        </div>

        <div className="flex-1 p-2 min-h-0">
          <div className="w-full h-full rounded-lg overflow-hidden checkerboard border border-white/8 flex items-center justify-center">
            {data ? (
              <img src={data} alt="capture" className="max-w-full max-h-full object-contain" />
            ) : (
              <span className="text-[10px] text-slate-500">No capture yet</span>
            )}
          </div>
        </div>

        <div className="px-2.5 pb-2">
          <div className="flex items-center justify-between text-[9.5px] font-mono text-slate-500 mb-1.5">
            <span>
              {capture ? `${capture.width}×${capture.height}` : "—"}
            </span>
            <span>{capture ? api.formatBytes(capture.sizeBytes) : ""}</span>
          </div>
          <div className="flex items-center gap-1.5">
            <button
              className="primary-btn flex-1 !py-2 flex items-center justify-center gap-1.5"
              disabled={busy || !capture}
              onClick={() =>
                capture &&
                void act(async () => {
                  await api.copyImageFile(capture.path);
                }, "Copied to clipboard")
              }
            >
              <Icon name="copy" size={13} />
              Copy
            </button>
            <button
              className="ghost-btn flex-1 justify-center"
              disabled={!capture}
              onClick={() => capture && useStore.getState().openInEditor(capture.path)}
            >
              <Icon name="pencil" size={13} />
              Edit
            </button>
            {capture?.temporary ? (
              <button
                className="ghost-btn flex-1 justify-center"
                disabled={busy}
                title="Move this capture into your library folder"
                onClick={() =>
                  capture &&
                  void act(async () => {
                    const path = await api.keepCapture(capture.path);
                    setCapture({ ...capture, path, temporary: false });
                    await loadLibrary();
                  }, "Saved to your library")
                }
              >
                <Icon name="save" size={13} />
                Save
              </button>
            ) : null}
            <button
              className={`ghost-btn flex-1 justify-center `}
              disabled={busy || !capture}
              title="Uploads this image to Imgur and copies the public link"
              onClick={() => {
                if (!capture) return;
                if (!confirmShare) {
                  setConfirmShare(true);
                  toast("Click Share again to upload this image to Imgur (public link)");
                  window.setTimeout(() => setConfirmShare(false), 5000);
                  return;
                }
                setConfirmShare(false);
                void act(async () => {
                  const result = await api.uploadImage({ path: capture.path });
                  await api.copyTextToClipboard(result.url);
                }, "Link copied");
              }}
            >
              <Icon name="link" size={13} />
              {confirmShare ? "Sure?" : "Share"}
            </button>
            <button
              className="ghost-btn"
              title="Show in folder"
              disabled={!capture}
              onClick={() => capture && void api.revealItem(capture.path)}
            >
              <Icon name="folder" size={13} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}