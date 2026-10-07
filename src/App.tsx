import { useEffect, useState } from "react";
import { Toolbar } from "./components/Toolbar";
import { Editor } from "./components/Editor";
import { RegionOverlay } from "./components/RegionOverlay";
import { RecorderWindow } from "./components/RecorderWindow";
import { PreviewWindow } from "./components/PreviewWindow";
import { Icon } from "./components/Icon";
import { useStore } from "./lib/store";
import { EVENTS, on } from "./lib/api";
import * as api from "./lib/api";
import { currentLabel } from "./lib/window";

function ToastStack({ top = false }: { top?: boolean }) {
  const toasts = useStore((s) => s.toasts);
  const dismiss = useStore((s) => s.dismissToast);
  if (toasts.length === 0) return null;
  return (
    <div
      className={`fixed  left-1/2 -translate-x-1/2 z-[200] flex flex-col gap-1.5 items-center pointer-events-none`}
    >
      {toasts.map((toast) => (
        <button
          key={toast.id}
          className={`pointer-events-auto flex items-center gap-2 px-3 py-2 rounded-xl text-[11px] font-medium shadow-2xl border backdrop-blur-xl fade-in max-w-[92vw] ${
            toast.kind === "error"
              ? "bg-rose-950/90 border-rose-500/40 text-rose-100"
              : toast.kind === "success"
                ? "bg-emerald-950/90 border-emerald-500/40 text-emerald-100"
                : "bg-slate-900/92 border-white/12 text-slate-100"
          }`}
          onClick={() => dismiss(toast.id)}
        >
          <Icon
            name={toast.kind === "error" ? "alert" : toast.kind === "success" ? "check" : "info"}
            size={13}
          />
          <span className="truncate">{toast.message}</span>
        </button>
      ))}
    </div>
  );
}

function MainWindow() {
  const view = useStore((s) => s.view);
  const editors = useStore((s) => s.editors);
  const closeEditorTab = useStore((s) => s.closeEditorTab);

  if (view === "editor") {
    const active = editors[editors.length - 1];
    if (!active) {
      return (
        <div className="h-screen w-screen flex items-center justify-center">
          <div className="glass-panel rounded-2xl px-6 py-5 text-center">
            <Icon name="image" size={22} className="mx-auto text-slate-500 mb-2" />
            <div className="text-[12px] text-slate-300">No image open</div>
            <div className="text-[10px] text-slate-500 mt-1">
              Pick an image from History and press the pencil button.
            </div>
          </div>
        </div>
      );
    }
    // Close the editor window when the last tab is closed.
    return (
      <div className="h-screen w-screen flex items-center justify-center">
        <div className="glass-panel rounded-2xl px-6 py-4 text-center">
          <div className="text-[11px] text-slate-300 mb-2">Editor is open in its own window</div>
          <button className="ghost-btn" onClick={() => closeEditorTab(active)}>
            Close tab
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen w-screen p-1">
      <div className="relative h-full">
        <Toolbar />
        <ToastStack />
      </div>
    </div>
  );
}

function EditorWindow() {
  // Subscribing here is what makes the window repaint once the path arrives
  // over the bridge; reading the store once would leave it stuck on "waiting".
  const editors = useStore((s) => s.editors);
  const inBrowser = typeof window !== "undefined" && !("__TAURI_INTERNALS__" in window);
  const query = inBrowser ? new URLSearchParams(window.location.search).get("p") : null;

  // The window can be opened before its listener exists, which would drop the
  // one-shot event; asking Rust for the stored path removes that race.
  useEffect(() => {
    if (inBrowser) return;
    void api
      .pendingEditorPath()
      .then((path) => {
        if (path) useStore.getState().openEditorTab(path);
      })
      .catch(() => undefined);
  }, [inBrowser]);

  // Browser preview falls back to a demo path so the canvas can be reviewed.
  const path = editors[editors.length - 1] ?? query ?? (inBrowser ? "demo.png" : null);

  if (!path) {
    return (
      <div className="h-screen w-screen flex items-center justify-center text-slate-400 text-[12px]">
        Waiting for an image…
      </div>
    );
  }
  return (
    <>
      <Editor path={path} onClose={() => void api.closeWindow("editor")} />
      <ToastStack top />
    </>
  );
}

export default function App() {
  const [label] = useState<string>(() => currentLabel());

  useEffect(() => {
    const disposers: (() => void)[] = [];
    void on<{ path: string }>(EVENTS.editorOpen, (payload) => {
      // Forwarded by Rust when a tool asks for the editor window. Only the
      // editor window itself tracks open tabs; ignoring it here keeps the main
      // window from bouncing back into an editor view it never asked for.
      if (label !== "editor") return;
      useStore.getState().openEditorTab(payload.path);
    }).then((fn) => disposers.push(fn));
    void on(EVENTS.navLibrary, () => useStore.getState().setView("history")).then((fn) =>
      disposers.push(fn),
    );
    // A capture started from a hotkey or the tray can fail with nobody watching:
    // say so instead of leaving the user wondering where the picture went.
    void on<string>(EVENTS.captureFailed, (message) => {
      const state = useStore.getState();
      state.setStatus("error", "Capture failed");
      state.toast(String(message), "error");
    }).then((fn) => disposers.push(fn));
    void on(EVENTS.libraryChanged, () => void useStore.getState().loadLibrary()).then((fn) =>
      disposers.push(fn),
    );
    // Linux Wayland: the desktop must be told once that SnapPro may take screenshots.
    // The backend raises this when a capture was refused; the state is also checked
    // at start and whenever the window is activated again.
    if (label === "main") {
      const store = useStore.getState();
      void store.loadScreenshotPermission();
      void on(EVENTS.permissionScreenshot, () => useStore.getState().setScreenshotPermissionNeeded(true)).then(
        (fn) => disposers.push(fn),
      );
      void on(EVENTS.permissionScreenshotAllowed, () =>
        useStore.getState().setScreenshotPermissionNeeded(false),
      ).then((fn) => disposers.push(fn));
      const recheck = () => void useStore.getState().loadScreenshotPermission();
      window.addEventListener("focus", recheck);
      disposers.push(() => window.removeEventListener("focus", recheck));
    }
    // Captures triggered from a global hotkey or the tray never pass through the
    // toolbar, so the window learns about them here and still shows the toast.
    void on<api.CaptureResult>(EVENTS.captureComplete, (payload) => {
      const state = useStore.getState();
      state.pushCapture(payload);
      void state.loadLibrary();
      state.setStatus("ready", "Saved");
      state.toast("Screenshot saved");
    }).then((fn) => disposers.push(fn));
    return () => disposers.forEach((fn) => fn());
  }, []);

  if (label === "region")
    return (
      <>
        <RegionOverlay />
        <ToastStack />
      </>
    );
  if (label === "recorder")
    return (
      <>
        <RecorderWindow />
        <ToastStack />
      </>
    );
  if (label === "preview")
    return (
      <>
        <PreviewWindow />
        <ToastStack />
      </>
    );
  if (label === "editor") return <EditorWindow />;
  return <MainWindow />;
}