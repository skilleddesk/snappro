import { useEffect, useState } from "react";
import { Icon } from "./Icon";
import * as api from "../lib/api";
import { useStore } from "../lib/store";
import { acceleratorFromEvent, prettyAccelerator } from "../lib/recording";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { PanelShell, Row, Switch } from "./PanelUI";

/** Click, then press the key combination you want. */
function HotkeyInput({ value, onChange }: { value: string; onChange: (accelerator: string) => void }) {
  const [listening, setListening] = useState(false);
  return (
    <button
      className={`text-input w-[150px] font-mono text-[10.5px] text-left ${listening ? "!border-violet-400/70" : ""}`}
      onClick={() => setListening(true)}
      onBlur={() => setListening(false)}
      onKeyDown={(event) => {
        if (!listening) return;
        event.preventDefault();
        if (event.key === "Escape") {
          setListening(false);
          return;
        }
        if (event.key === "Backspace" || event.key === "Delete") {
          onChange("");
          setListening(false);
          return;
        }
        const accelerator = acceleratorFromEvent(event);
        if (accelerator) {
          onChange(accelerator);
          setListening(false);
        }
      }}
      title="Click, then press the shortcut. Backspace clears it."
    >
      {listening ? "Press keys…" : value ? prettyAccelerator(value) : "— none —"}
    </button>
  );
}

const SHORTCUT_LABELS = [
  "Full screen capture",
  "Region capture",
  "Active window capture",
  "Scrolling capture",
  "Start / stop recording",
];

export function SettingsPanel() {
  const { settings, updateSettings, toast, dependencies, monitors, loadDependencies } = useStore();
  const [picking, setPicking] = useState(false);
  const [installing, setInstalling] = useState<string | null>(null);

  useEffect(() => {
    void loadDependencies();
  }, [loadDependencies]);

  if (!settings) return null;

  const [drives, setDrives] = useState<{ path: string; label: string }[]>([]);
  useEffect(() => {
    void api.listDrives().then((list) => setDrives(Array.isArray(list) ? list : [])).catch(() => setDrives([]));
  }, []);

  const chooseFolder = async (key: "saveDir" | "videoDir" | "exportDir", title: string) => {
    setPicking(true);
    try {
      const dir = await openDialog({ directory: true, title });
      if (typeof dir === "string") {
        await updateSettings({ [key]: dir });
        toast("Folder updated", "success");
      }
    } catch (error) {
      toast(api.errorMessage(error), "error");
    } finally {
      setPicking(false);
    }
  };

  const useDrive = async (key: "saveDir" | "videoDir" | "exportDir", root: string) => {
    const sep = root.includes("\\") ? "\\" : "/";
    const dir = `${root.replace(/[\\/]+$/, "")}${sep}SnapPro`;
    try {
      await updateSettings({ [key]: dir });
      toast(`Saving to ${dir}`, "success");
    } catch (error) {
      toast(api.errorMessage(error), "error");
    }
  };

  const folderRow = (key: "saveDir" | "videoDir" | "exportDir", label: string, hint: string, title: string) => (
    <div className="py-2">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[11px] font-medium text-slate-300">{label}</div>
          <div className="text-[9.5px] text-slate-400 mt-0.5 break-all">{settings[key] || hint}</div>
        </div>
        <div className="flex gap-1 shrink-0">
          <button className="ghost-btn" onClick={() => void chooseFolder(key, title)} disabled={picking}>
            <Icon name="folder" size={13} />
            Browse
          </button>
          <button className="ghost-btn" title="Open this folder" onClick={() => void api.openFolder(settings[key] || settings.saveDir)}>
            Open
          </button>
        </div>
      </div>
      {drives.length > 0 ? (
        <div className="flex flex-wrap gap-1 mt-1.5">
          {drives.map((d) => (
            <button key={d.path} className="chip" title={`Use ${d.path}SnapPro`} onClick={() => void useDrive(key, d.path)}>
              {d.label}
            </button>
          ))}
          {key !== "saveDir" && settings[key] ? (
            <button className="chip" onClick={() => void updateSettings({ [key]: "" })}>
              Same as pictures
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );

  const install = async (name: "ffmpeg" | "tesseract") => {
    setInstalling(name);
    try {
      await api.installDependency(name);
      await loadDependencies();
      toast(`${name} installed`, "success");
    } catch (error) {
      toast(api.errorMessage(error), "error");
    } finally {
      setInstalling(null);
    }
  };

  const status = (ok: boolean, name: "ffmpeg" | "tesseract") =>
    ok ? (
      <span className="text-[10px] font-mono text-emerald-400">installed</span>
    ) : (
      <button className="chip" onClick={() => void install(name)} disabled={installing !== null}>
        {installing === name ? "Installing…" : "Install"}
      </button>
    );

  return (
    <PanelShell
      title="Settings"
      subtitle={`SnapPro ${dependencies?.appVersion ?? ""} · ${dependencies?.platform ?? ""}`}
      actions={
        <button className="win-ctrl" title="Refresh" onClick={() => void loadDependencies()}>
          <Icon name="refresh" size={14} strokeWidth={2} />
        </button>
      }
    >
      <div className="section-label mb-1 px-1">Where files are saved</div>
      {folderRow("saveDir", "Pictures & screenshots", "", "Choose where SnapPro saves pictures")}
      {folderRow("videoDir", "Videos & GIFs", "Same as pictures", "Choose where SnapPro saves videos")}
      {folderRow("exportDir", "PDF & exports", "Same as pictures", "Choose where PDFs and exports are offered")}
      <div className="text-[9.5px] text-slate-500 px-1 mb-2">
        Pick any drive or folder. SnapPro keeps its own logs and caches in the app-data folder, so these folders only hold your files.
      </div>
      <div className="section-label mb-1 px-1">Capture</div>
      <Row label="Image format">
        <select
          className="text-input w-[92px]"
          value={settings.format}
          onChange={(e) => void updateSettings({ format: e.target.value })}
        >
          <option value="png">PNG</option>
          <option value="jpg">JPG</option>
          <option value="webp">WEBP</option>
        </select>
      </Row>
      <Row label="Capture monitor" hint="Used by Full screen and the region tools">
        <select
          className="text-input w-[132px]"
          value={settings.monitor}
          onChange={(e) => void updateSettings({ monitor: e.target.value })}
        >
          <option value="primary">All / primary</option>
          {monitors.map((monitor, index) => (
            <option key={monitor.id} value={String(index)}>
              {monitor.name} ({monitor.width}×{monitor.height})
            </option>
          ))}
        </select>
      </Row>
      <Row label="Delay (seconds)">
        <input
          className="text-input w-[64px] text-center"
          type="number"
          min={1}
          max={60}
          value={settings.delaySecs}
          onChange={(e) => void updateSettings({ delaySecs: Math.min(60, Math.max(1, Number(e.target.value) || 1)) })}
        />
      </Row>
      <Row label="Fixed size" hint="Width × height of the Fixed capture frame">
        <div className="flex items-center gap-1">
          <input
            className="text-input w-[58px] text-center"
            type="number"
            min={16}
            max={8000}
            value={settings.fixedWidth}
            onChange={(e) => void updateSettings({ fixedWidth: Number(e.target.value) || 1280 })}
          />
          <span className="text-slate-500 text-[10px]">×</span>
          <input
            className="text-input w-[58px] text-center"
            type="number"
            min={16}
            max={8000}
            value={settings.fixedHeight}
            onChange={(e) => void updateSettings({ fixedHeight: Number(e.target.value) || 720 })}
          />
        </div>
      </Row>
      <Row label="Copy to clipboard" hint="Automatically after every capture">
        <Switch on={settings.autoCopy} onChange={(v) => void updateSettings({ autoCopy: v })} />
      </Row>
      <Row label="Auto save" hint="Off: captures stay temporary until you press Save in the preview">
        <Switch on={settings.autoSave} onChange={(v) => void updateSettings({ autoSave: v })} />
      </Row>
      <Row label="Show preview window" hint="Floating mini preview after capture">
        <Switch on={settings.openPreview} onChange={(v) => void updateSettings({ openPreview: v })} />
      </Row>
      <Row label="Auto OCR caption" hint="Read the text and add it to the file name">
        <Switch on={settings.autoOcrCaption} onChange={(v) => void updateSettings({ autoOcrCaption: v })} />
      </Row>
      <Row label="Launch at startup" hint="Start SnapPro when you sign in">
        <Switch
          on={settings.launchAtStartup}
          onChange={async (v) => {
            await updateSettings({ launchAtStartup: v });
            toast(v ? "SnapPro will start with your computer" : "Startup disabled");
          }}
        />
      </Row>
      <Row label="Notification" hint="Show a notification after each capture">
        <Switch on={settings.playSound} onChange={(v) => void updateSettings({ playSound: v })} />
      </Row>

      <div className="section-label mt-4 mb-1 px-1">Recording</div>
      <Row label="Recording options" hint="Source, sound, camera, quality, countdown">
        <button className="ghost-btn" onClick={() => useStore.getState().setView("record")}>
          <Icon name="sliders" size={13} />
          Open Record setup
        </button>
      </Row>

      <div className="divider my-2" />
      <div className="section-label mb-1 px-1">Window</div>
      <Row label="Always on top">
        <Switch
          on={settings.alwaysOnTop}
          onChange={async (v) => {
            await updateSettings({ alwaysOnTop: v });
            await api.setAlwaysOnTop(v, "main");
          }}
        />
      </Row>

      <div className="divider my-2" />
      <div className="section-label mb-1 px-1">Shortcuts</div>
      {SHORTCUT_LABELS.map((label, index) => (
        <Row key={label} label={label}>
          <HotkeyInput
            value={settings.shortcuts[index] ?? ""}
            onChange={(accelerator) => {
              const next = [...settings.shortcuts];
              while (next.length < SHORTCUT_LABELS.length) next.push("");
              next[index] = accelerator;
              void updateSettings({ shortcuts: next });
            }}
          />
        </Row>
      ))}
      <Row label="Copy text from screen" hint="Select an area and its text lands on the clipboard">
        <HotkeyInput value={settings.shortcutOcr} onChange={(accelerator) => void updateSettings({ shortcutOcr: accelerator })} />
      </Row>

      <div className="divider my-2" />
      <div className="section-label mb-1 px-1">Cloud</div>
      <Row label="Imgur client ID" hint="Used by the cloud upload tool">
        <input
          className="text-input w-[150px] font-mono text-[10px]"
          value={settings.imgurClientId}
          onChange={(e) => void updateSettings({ imgurClientId: e.target.value })}
        />
      </Row>
      <Row label="S3 bucket">
        <input
          className="text-input w-[150px] font-mono text-[10px]"
          placeholder="my-bucket"
          value={settings.s3Bucket}
          onChange={(e) => void updateSettings({ s3Bucket: e.target.value })}
        />
      </Row>
      <Row label="S3 region">
        <input
          className="text-input w-[150px] font-mono text-[10px]"
          value={settings.s3Region}
          onChange={(e) => void updateSettings({ s3Region: e.target.value })}
        />
      </Row>
      <Row label="S3 access key">
        <input
          className="text-input w-[150px] font-mono text-[10px]"
          value={settings.s3AccessKey}
          onChange={(e) => void updateSettings({ s3AccessKey: e.target.value })}
        />
      </Row>
      <Row label="S3 secret key" hint="Stored locally in settings.json">
        <input
          className="text-input w-[150px] font-mono text-[10px]"
          type="password"
          value={settings.s3SecretKey}
          onChange={(e) => void updateSettings({ s3SecretKey: e.target.value })}
        />
      </Row>
      <Row label="S3 key prefix">
        <input
          className="text-input w-[150px] font-mono text-[10px]"
          value={settings.s3Prefix}
          onChange={(e) => void updateSettings({ s3Prefix: e.target.value })}
        />
      </Row>

      <div className="divider my-2" />
      <div className="section-label mb-1 px-1">System check</div>
      <Row label="ffmpeg" hint="Needed for screen recording">
        {status(Boolean(dependencies?.ffmpeg), "ffmpeg")}
      </Row>
      <Row label="OCR engine" hint="Tesseract for text extraction">
        {status(Boolean(dependencies?.tesseract), "tesseract")}
      </Row>
      <Row label="OCR languages">
        <span className="text-[10px] font-mono text-slate-400">
          {(dependencies?.ocrLanguages ?? ["eng"]).slice(0, 6).join(", ")}
        </span>
      </Row>
      {dependencies?.recordingBlocker ? (
        <div className="text-[10px] text-rose-300 px-1 leading-relaxed">{dependencies.recordingBlocker}</div>
      ) : null}

      <button className="ghost-btn w-full mt-3" onClick={() => void api.openFolder(settings.saveDir)}>
        <Icon name="folder" size={13} />
        Open capture folder
      </button>
      <button className="ghost-btn w-full mt-2" onClick={() => void api.quitApp()}>
        <Icon name="close" size={13} />
        Quit SnapPro
      </button>
    </PanelShell>
  );
}
