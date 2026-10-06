import { useEffect } from "react";
import { Icon } from "./Icon";
import * as api from "../lib/api";
import { useStore } from "../lib/store";
import { targetMonitorIndex } from "./targetMonitor";

/** Quick bar: the compact strip with only the essential capture actions. */
export function MiniMode() {
  const { settings, updateSettings, setStatus, toast, pushCapture, loadLibrary, recording, toggleRecording } =
    useStore();
  const recordingActive = Boolean(recording?.recording || recording?.paused);
  const active = Boolean(settings?.miniMode);

  if (!active) return null;

  const capture = async (kind: "full" | "all" | "region" | "window" | "scroll") => {
    const monitor = targetMonitorIndex(settings?.monitor);
    try {
      setStatus("busy", "Capturing…");
      if (kind === "region") {
        await api.startRegionSelector("region", monitor);
        setStatus("ready");
        return;
      }
      if (kind === "scroll") {
        await api.startRegionSelector("scrolling", monitor);
        setStatus("ready");
        return;
      }
      const result =
        kind === "full"
          ? await api.captureFullScreen(monitor)
          : kind === "all"
            ? await api.captureAllMonitors()
            : await api.captureWindow();
      pushCapture(result);
      await loadLibrary();
      setStatus("ready", "Saved");
    } catch (error) {
      toast(api.errorMessage(error), "error");
      setStatus("error");
    }
  };

  const toggleRecord = () => void toggleRecording();

  /** Switch the microphone / camera used by recordings, after checking one exists. */
  const toggleDevice = async (key: "recordingAudio" | "recordingWebcam", list: "microphones" | "cameras", label: string) => {
    if (!settings) return;
    const enabling = !settings[key];
    if (enabling) {
      const devices = await api.listDevices().catch(() => ({ cameras: [], microphones: [], loopback: [] }));
      if (devices[list].length === 0) {
        toast(`No ${label.toLowerCase()} found on this computer`, "error");
        return;
      }
    }
    await updateSettings({ [key]: enabling });
  };

  return (
    <div className="absolute inset-0 flex items-center">
      <div className="glass-panel drag-handle rounded-xl px-2 py-1.5 flex items-center gap-1 w-full h-12 cursor-move">
        <button
          className="win-ctrl !w-8 !h-8"
          title="Expand"
          onClick={() => void updateSettings({ miniMode: false })}
        >
          <Icon name="logo" size={14} strokeWidth={2.2} />
        </button>
        <div className="w-px h-5 bg-white/10 mx-0.5" />
        <button
          className="tool-btn w-8 h-8 rounded-lg flex items-center justify-center"
          title="Full"
          onClick={() => void capture("full")}
        >
          <Icon name="fullscreen" size={15} strokeWidth={1.9} className="tool-icon" />
        </button>
        <button
          className="tool-btn w-8 h-8 rounded-lg flex items-center justify-center"
          title="All Monitors"
          onClick={() => void capture("all")}
        >
          <Icon name="monitors" size={15} strokeWidth={1.9} className="tool-icon" />
        </button>
        <button
          className="tool-btn w-8 h-8 rounded-lg flex items-center justify-center"
          title="Region"
          onClick={() => void capture("region")}
        >
          <Icon name="region" size={15} strokeWidth={1.9} className="tool-icon" />
        </button>
        <button
          className="tool-btn w-8 h-8 rounded-lg flex items-center justify-center"
          title="Window"
          onClick={() => void capture("window")}
        >
          <Icon name="window" size={15} strokeWidth={1.9} className="tool-icon" />
        </button>
        <button
          className="tool-btn w-8 h-8 rounded-lg flex items-center justify-center"
          title="Scrolling"
          onClick={() => void capture("scroll")}
        >
          <Icon name="scrolling" size={15} strokeWidth={1.9} className="tool-icon" />
        </button>
        <div className="w-px h-5 bg-white/10 mx-0.5" />
        <button
          className={`w-8 h-8 rounded-lg flex items-center justify-center transition-all ${
            recordingActive
              ? "bg-gradient-to-br from-slate-600 to-slate-800 pulse-ring"
              : "bg-gradient-to-br from-red-500 to-red-700 hover:from-red-400 hover:to-red-600 shadow-lg shadow-red-900/40"
          }`}
          title={recordingActive ? "Stop recording" : "Record"}
          onClick={toggleRecord}
        >
          <Icon
            name={recordingActive ? "stop" : "circle"}
            size={13}
            stroke="#fff"
            className={recordingActive ? "" : "hidden"}
          />
          {recordingActive ? null : (
            <svg width="13" height="13" viewBox="0 0 24 24" fill="#fff">
              <circle cx="12" cy="12" r="6" />
            </svg>
          )}
        </button>
        {([
          ["mic", settings?.recordingAudio, "Microphone", "recordingAudio"],
          ["camera", settings?.recordingWebcam, "Webcam", "recordingWebcam"],
        ] as const).map(([icon, on, label, key]) => (
          <button
            key={key}
            className={`w-8 h-8 rounded-lg flex items-center justify-center border transition-all ${
              on ? "border-emerald-400/60 bg-emerald-500/20 text-emerald-100" : "border-white/20 bg-white/[0.06] text-slate-200 hover:border-white/40"
            }`}
            title={`${label} for recordings: ${on ? "ON" : "OFF"} (click to switch)`}
            onClick={() => void toggleDevice(key, icon === "mic" ? "microphones" : "cameras", label)}
          >
            <Icon name={icon === "mic" && !on ? "micOff" : icon} size={15} />
          </button>
        ))}
        <button
          className="win-ctrl !w-8 !h-8 ml-auto"
          title="Close"
          onClick={() => void api.closeWindow("main")}
        >
          <Icon name="close" size={14} strokeWidth={2} />
        </button>
      </div>
    </div>
  );
}