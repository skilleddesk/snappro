import { useState } from "react";
import * as api from "../lib/api";
import { useStore } from "../lib/store";

/**
 * Linux Wayland: GNOME asks once whether SnapPro may take screenshots, and only
 * while one of SnapPro's windows is active. A shortcut or the tray cannot be that
 * window, so the question is asked from this button instead.
 */
export function PermissionBanner({ className = "" }: { className?: string }) {
  const needed = useStore((s) => s.screenshotPermissionNeeded);
  const setNeeded = useStore((s) => s.setScreenshotPermissionNeeded);
  const toast = useStore((s) => s.toast);
  const [busy, setBusy] = useState(false);

  if (!needed) return null;

  const allow = async () => {
    setBusy(true);
    try {
      await api.requestScreenshotPermission();
      setNeeded(false);
      toast("Screenshots are allowed. The shortcuts work now.", "success");
    } catch (error) {
      toast(api.errorMessage(error), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={`rounded-xl border border-amber-400/40 bg-[#2b2411] px-3 py-2 shadow-lg ${className}`}>
      <div className="text-[10.5px] leading-snug text-amber-100">
        Your desktop must allow SnapPro to take screenshots. It asks once, and only while this window is
        active: press the button, then choose Allow.
      </div>
      <button
        className="ghost-btn mt-1.5 w-full py-1.5 text-[10.5px] font-medium"
        disabled={busy}
        onClick={() => void allow()}
      >
        {busy ? "Waiting for your desktop…" : "Allow screenshots"}
      </button>
    </div>
  );
}
