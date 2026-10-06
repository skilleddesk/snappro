import { getCurrentWindow } from "@tauri-apps/api/window";

export type WindowLabel = "main" | "region" | "editor" | "recorder" | "preview";

/**
 * Which SnapPro window are we rendering?
 *
 * Inside Tauri the label comes from the native window. In a plain browser
 * (design review with `npm run dev`) it comes from the `?w=` query parameter so
 * every window can be looked at without packaging the app.
 */
export function currentLabel(): WindowLabel {
  if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
    try {
      return getCurrentWindow().label as WindowLabel;
    } catch {
      return "main";
    }
  }
  if (typeof window !== "undefined") {
    const param = new URLSearchParams(window.location.search).get("w");
    if (param === "region" || param === "editor" || param === "recorder" || param === "preview") {
      return param;
    }
  }
  return "main";
}

/** Safe window handle: returns null when running outside Tauri. */
export function nativeWindow() {
  if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
    try {
      return getCurrentWindow();
    } catch {
      return null;
    }
  }
  return null;
}
/**
 * Make any element with the `drag-handle` class drag the window.
 *
 * Tauri's own `data-tauri-drag-region` only reacts when the click lands on that
 * exact element, so grabbing a title or an icon inside it did nothing - which is
 * why the quick bar and the preview could not be moved. Here the press is
 * handled for the whole area, except on real controls.
 */
export function installWindowDrag() {
  if (typeof window === "undefined" || !("__TAURI_INTERNALS__" in window)) return;
  const interactive = "button, a, input, select, textarea, label, [role='button'], [data-no-drag]";
  window.addEventListener(
    "mousedown",
    (event) => {
      if (event.button !== 0) return;
      const target = event.target as HTMLElement | null;
      if (!target || !target.closest(".drag-handle") || target.closest(interactive)) return;
      event.preventDefault();
      void nativeWindow()?.startDragging();
    },
    true,
  );
}
