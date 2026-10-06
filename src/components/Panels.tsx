import { useEffect, useState } from "react";
import { Icon } from "./Icon";
import * as api from "../lib/api";
import { useStore } from "../lib/store";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { EmptyState, PanelShell, Row, Seg } from "./PanelUI";
import { SettingsPanel } from "./SettingsPanel";
import { HistoryPanel } from "./HistoryPanel";
import { RecorderSetup } from "./RecorderSetup";
import { PdfDialog, type PdfSource } from "./PdfDialog";

// ---------------------------------------------------------------------------
// Image source picker (shared by OCR, PDF, AI, Cloud)
// ---------------------------------------------------------------------------

function ImagePicker({
  value,
  onChange,
  label = "Image",
}: {
  value: string | null;
  onChange: (path: string | null) => void;
  label?: string;
}) {
  const library = useStore((s) => s.library);
  const toast = useStore((s) => s.toast);
  const images = library.filter((item) => item.kind === "image");

  const browse = async () => {
    try {
      const file = await openDialog({
        multiple: false,
        title: "Choose an image",
        filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "bmp"] }],
      });
      if (typeof file === "string") onChange(file);
    } catch (error) {
      toast(api.errorMessage(error), "error");
    }
  };

  return (
    <div className="mb-3">
      <div className="flex items-center justify-between mb-1.5 px-1">
        <span className="field-label">{label}</span>
        <button className="chip" onClick={browse}>
          Browse…
        </button>
      </div>
      {value ? (
        <div className="text-[10px] font-mono text-slate-400 truncate px-1 mb-2">{value}</div>
      ) : null}
      <select
        className="text-input"
        value={value ?? ""}
        onChange={(e) => onChange(e.target.value || null)}
      >
        <option value="">— pick from history —</option>
        {images.slice(0, 80).map((item) => (
          <option key={item.path} value={item.path}>
            {item.name}
          </option>
        ))}
      </select>
    </div>
  );
}

// ---------------------------------------------------------------------------
// OCR
// ---------------------------------------------------------------------------

function OcrPanel() {
  const { toast, dependencies, library, loadLibrary } = useStore();
  const [path, setPath] = useState<string | null>(null);
  const [language, setLanguage] = useState("eng");
  const [result, setResult] = useState<api.OcrResult | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void loadLibrary();
  }, [loadLibrary]);

  useEffect(() => {
    if (!path && library.length) {
      const first = library.find((item) => item.kind === "image");
      if (first) setPath(first.path);
    }
  }, [library, path]);

  const run = async () => {
    if (!path) {
      toast("Choose an image first", "error");
      return;
    }
    setBusy(true);
    try {
      const text = await api.ocrImage(path, language);
      setResult(text);
      toast(`Extracted ${text.words} words`);
    } catch (error) {
      toast(api.errorMessage(error), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <PanelShell title="OCR — Extract text" subtitle="Powered by Tesseract">
      <ImagePicker value={path} onChange={setPath} />
      <Row label="Language">
        <select
          className="text-input w-[122px]"
          value={language}
          onChange={(e) => setLanguage(e.target.value)}
        >
          {["eng", "ben", "hin", "ara", "chi_sim", "jpn", "kor", "deu", "fra", "spa", "rus"].map(
            (code) => (
              <option key={code} value={code}>
                {code}
                {dependencies?.ocrLanguages.includes(code) ? " ✓" : ""}
              </option>
            ),
          )}
        </select>
      </Row>
      <button className="primary-btn w-full mt-2" onClick={run} disabled={busy}>
        {busy ? "Reading text…" : "Extract text"}
      </button>

      {result ? (
        <>
          <div className="divider my-3" />
          <div className="flex items-center justify-between mb-1.5 px-1">
            <span className="field-label">
              Result · {result.words} words · {result.language}
            </span>
            <button
              className="chip"
              onClick={async () => {
                await api.copyTextToClipboard(result.text);
                toast("Text copied");
              }}
            >
              Copy
            </button>
          </div>
          <textarea
            className="text-input h-40 resize-none font-mono !text-[10.5px] leading-relaxed"
            value={result.text}
            readOnly
          />
        </>
      ) : (
        <EmptyState
          icon="ocr"
          title="No text extracted yet"
          hint="Pick a screenshot and hit Extract text."
        />
      )}
    </PanelShell>
  );
}

// ---------------------------------------------------------------------------
// PDF
// ---------------------------------------------------------------------------

function PdfPanel() {
  const { library, loadLibrary, toast, selected, toggleSelected, clearSelected } = useStore();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void loadLibrary();
  }, [loadLibrary]);

  const images = library.filter((item) => item.kind === "image").slice(0, 40);

  const [pdfSource, setPdfSource] = useState<PdfSource | null>(null);
  const convert = () => {
    const paths = selected.length ? selected : images.map((i) => i.path);
    if (paths.length === 0) {
      toast("No images available", "error");
      return;
    }
    setPdfSource({
      kind: "files",
      paths,
      sizes: paths.map((p) => {
        const item = library.find((i) => i.path === p);
        return [item?.width ?? 1000, item?.height ?? 700] as [number, number];
      }),
    });
  };

  return (
    <PanelShell title="PDF Convert" subtitle={`${images.length} images available`}>
      {pdfSource ? <PdfDialog source={pdfSource} onClose={() => setPdfSource(null)} /> : null}
      <div className="text-[10px] text-slate-500 px-1 mb-2">
        Select the pages in the order you want them, or convert everything.
      </div>
      <div className="grid grid-cols-3 gap-1.5 mb-3">
        {images.map((item) => (
          <button
            key={item.path}
            className={`chip truncate ${selected.includes(item.path) ? "is-active" : ""}`}
            onClick={() => toggleSelected(item.path)}
            title={item.name}
          >
            {selected.includes(item.path) ? `${selected.indexOf(item.path) + 1}. ` : ""}
            {item.name.slice(-14)}
          </button>
        ))}
      </div>
      {images.length === 0 ? (
        <EmptyState icon="pdf" title="Nothing to convert" hint="Take a few screenshots first." />
      ) : null}
      <div className="flex items-center gap-1.5">
        <button className="primary-btn flex-1" onClick={convert} disabled={busy}>
          {selected.length ? `Convert ${selected.length} pages` : "Convert all"}…
        </button>
        <button className="ghost-btn" onClick={clearSelected}>
          Clear
        </button>
      </div>
    </PanelShell>
  );
}

// ---------------------------------------------------------------------------
// Cloud
// ---------------------------------------------------------------------------

function CloudPanel() {
  const { library, loadLibrary, toast, settings, selected } = useStore();
  const [path, setPath] = useState<string | null>(null);
  const [provider, setProvider] = useState<"imgur" | "custom" | "s3" | "gdrive">("imgur");
  const [endpoint, setEndpoint] = useState("");
  const [token, setToken] = useState("");
  const [bucket, setBucket] = useState("");
  const [region, setRegion] = useState("us-east-1");
  const [prefix, setPrefix] = useState("snappro");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<api.UploadResult | null>(null);

  useEffect(() => {
    void loadLibrary();
  }, [loadLibrary]);

  useEffect(() => {
    if (!path) {
      if (selected.length) setPath(selected[0]);
      else {
        const first = library.find((item) => item.kind === "image");
        if (first) setPath(first.path);
      }
    }
  }, [library, path, selected]);

  useEffect(() => {
    if (settings?.s3Region) setRegion(settings.s3Region);
    if (settings?.s3Prefix) setPrefix(settings.s3Prefix);
    if (settings?.s3Bucket) setBucket(settings.s3Bucket);
  }, [settings?.s3Region, settings?.s3Prefix, settings?.s3Bucket]);

  const upload = async () => {
    if (!path) {
      toast("Choose an image first", "error");
      return;
    }
    if (provider === "s3" && !settings?.s3AccessKey) {
      toast("Add your S3 keys in Settings first", "error");
      return;
    }
    if (provider === "gdrive" && !token.trim()) {
      toast("Paste a Google OAuth access token first", "error");
      return;
    }
    setBusy(true);
    try {
      const upload = await api.uploadImage({
        path,
        provider,
        clientId: settings?.imgurClientId,
        endpoint,
        token,
        bucket,
        region,
        prefix,
        accessKey: settings?.s3AccessKey,
        secretKey: settings?.s3SecretKey,
      });
      setResult(upload);
      toast("Uploaded — link copied");
      await api.copyTextToClipboard(upload.url).catch(() => undefined);
    } catch (error) {
      toast(api.errorMessage(error), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <PanelShell title="Cloud Upload" subtitle="Share a capture with a link">
      <ImagePicker value={path} onChange={setPath} />
      <Row label="Provider">
        <select
          className="text-input w-[128px]"
          value={provider}
          onChange={(e) => setProvider(e.target.value as typeof provider)}
        >
          <option value="imgur">Imgur</option>
          <option value="s3">Amazon S3</option>
          <option value="gdrive">Google Drive</option>
          <option value="custom">Custom HTTP</option>
        </select>
      </Row>

      {provider === "custom" ? (
        <>
          <Row label="Endpoint" hint="PUT request receives the raw image">
            <input
              className="text-input w-[160px] font-mono !text-[10px]"
              placeholder="https://…"
              value={endpoint}
              onChange={(e) => setEndpoint(e.target.value)}
            />
          </Row>
          <Row label="Bearer token">
            <input
              className="text-input w-[160px] font-mono !text-[10px]"
              value={token}
              onChange={(e) => setToken(e.target.value)}
            />
          </Row>
        </>
      ) : null}

      {provider === "s3" ? (
        <>
          <Row label="Bucket" hint="Keys are read from Settings">
            <input
              className="text-input w-[160px] font-mono !text-[10px]"
              placeholder="my-bucket"
              value={bucket}
              onChange={(e) => setBucket(e.target.value)}
            />
          </Row>
          <Row label="Region">
            <input
              className="text-input w-[160px] font-mono !text-[10px]"
              value={region}
              onChange={(e) => setRegion(e.target.value)}
            />
          </Row>
          <Row label="Key prefix">
            <input
              className="text-input w-[160px] font-mono !text-[10px]"
              value={prefix}
              onChange={(e) => setPrefix(e.target.value)}
            />
          </Row>
          <div className="text-[9.5px] text-slate-500 px-1">
            {settings?.s3AccessKey ? "Access key configured ✓" : "No access key configured yet"}
          </div>
        </>
      ) : null}

      {provider === "gdrive" ? (
        <Row label="OAuth access token" hint="drive.file scope">
          <input
            className="text-input w-[160px] font-mono !text-[10px]"
            value={token}
            onChange={(e) => setToken(e.target.value)}
          />
        </Row>
      ) : null}

      <button className="primary-btn w-full mt-2" onClick={upload} disabled={busy}>
        {busy ? "Uploading…" : "Upload and copy link"}
      </button>

      {result ? (
        <>
          <div className="divider my-3" />
          <Row label="Public link">
            <button
              className="chip"
              onClick={async () => {
                await api.copyTextToClipboard(result.url);
                toast("Link copied");
              }}
            >
              Copy
            </button>
          </Row>
          <div className="text-[10px] font-mono text-violet-300 break-all px-1">{result.url}</div>
          <button className="ghost-btn w-full mt-2" onClick={() => void api.openUrl(result.url)}>
            <Icon name="external" size={13} />
            Open in browser
          </button>
        </>
      ) : (
        <EmptyState icon="cloud" title="Nothing uploaded" hint="Pick an image and upload it." />
      )}
    </PanelShell>
  );
}

// ---------------------------------------------------------------------------
// AI tools
// ---------------------------------------------------------------------------

function AiPanel() {
  const { library, loadLibrary, toast, selected, openInEditor } = useStore();
  const [path, setPath] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [tolerance, setTolerance] = useState(38);
  const [strength, setStrength] = useState(14);
  const [output, setOutput] = useState<string | null>(null);

  useEffect(() => {
    void loadLibrary();
  }, [loadLibrary]);

  useEffect(() => {
    if (!path) {
      if (selected.length) setPath(selected[0]);
      else {
        const first = library.find((item) => item.kind === "image");
        if (first) setPath(first.path);
      }
    }
  }, [library, path, selected]);

  const run = async (kind: "bg" | "faces" | "enhance") => {
    if (!path) {
      toast("Choose an image first", "error");
      return;
    }
    setBusy(kind);
    try {
      const result =
        kind === "bg"
          ? await api.aiRemoveBackground(path, tolerance)
          : kind === "faces"
            ? await api.aiBlurFaces(path, strength)
            : await api.aiAutoEnhance(path);
      setOutput(result.path);
      toast("Done — a new file was created");
      await loadLibrary();
    } catch (error) {
      toast(api.errorMessage(error), "error");
    } finally {
      setBusy(null);
    }
  };

  return (
    <PanelShell title="AI Tools" subtitle="Smart edits that run fully offline">
      <ImagePicker value={path} onChange={setPath} />

      <div className="rounded-xl border border-white/8 bg-white/[0.02] p-2.5 mb-2">
        <div className="text-[11px] font-medium text-slate-200">Remove background</div>
        <div className="text-[9.5px] text-slate-500 mb-2">
          Flood-fills similar colours from the edges. Raise the tolerance for busy backgrounds.
        </div>
        <Row label="Tolerance" hint={`${tolerance}`}>
          <input
            type="range"
            min={5}
            max={120}
            value={tolerance}
            onChange={(e) => setTolerance(Number(e.target.value))}
            className="w-[128px] accent-violet-500"
          />
        </Row>
        <button
          className="primary-btn w-full mt-1"
          onClick={() => void run("bg")}
          disabled={busy !== null}
        >
          {busy === "bg" ? "Working…" : "Remove background"}
        </button>
      </div>

      <div className="rounded-xl border border-white/8 bg-white/[0.02] p-2.5 mb-2">
        <div className="text-[11px] font-medium text-slate-200">Privacy blur</div>
        <div className="text-[9.5px] text-slate-500 mb-2">
          Detects skin-tone areas (faces and hands) and blurs them before sharing.
        </div>
        <Row label="Blur strength" hint={`${strength}`}>
          <input
            type="range"
            min={4}
            max={40}
            value={strength}
            onChange={(e) => setStrength(Number(e.target.value))}
            className="w-[128px] accent-violet-500"
          />
        </Row>
        <button
          className="primary-btn w-full mt-1"
          onClick={() => void run("faces")}
          disabled={busy !== null}
        >
          {busy === "faces" ? "Scanning…" : "Blur faces & skin"}
        </button>
      </div>

      <div className="rounded-xl border border-white/8 bg-white/[0.02] p-2.5">
        <div className="text-[11px] font-medium text-slate-200">Auto enhance</div>
        <div className="text-[9.5px] text-slate-500 mb-2">
          Contrast stretch plus a mild colour boost — great for washed-out captures.
        </div>
        <button
          className="primary-btn w-full"
          onClick={() => void run("enhance")}
          disabled={busy !== null}
        >
          {busy === "enhance" ? "Enhancing…" : "Auto enhance"}
        </button>
      </div>

      {output ? (
        <>
          <div className="divider my-3" />
          <div className="text-[10px] font-mono text-emerald-400 truncate px-1">{output}</div>
          <div className="flex items-center gap-1.5 mt-2">
            <button className="ghost-btn flex-1" onClick={() => openInEditor(output)}>
              <Icon name="pencil" size={13} />
              Open in editor
            </button>
            <button className="ghost-btn" onClick={() => void api.revealItem(output)}>
              <Icon name="folder" size={13} />
            </button>
          </div>
        </>
      ) : null}
    </PanelShell>
  );
}

// ---------------------------------------------------------------------------
// Plugins
// ---------------------------------------------------------------------------

function PluginsPanel() {
  const { toast } = useStore();
  const [plugins, setPlugins] = useState<api.PluginManifest[]>([]);

  const refresh = async () => {
    try {
      setPlugins(await api.pluginsList());
    } catch (error) {
      toast(api.errorMessage(error), "error");
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const install = async () => {
    try {
      const file = await openDialog({
        multiple: false,
        title: "Install a plugin",
        filters: [{ name: "SnapPro plugin", extensions: ["json"] }],
      });
      if (typeof file !== "string") return;
      const manifest = await api.pluginInstall(file);
      toast(`Installed ${manifest.name}`);
      await refresh();
    } catch (error) {
      toast(api.errorMessage(error), "error");
    }
  };

  return (
    <PanelShell
      title="Plugins"
      subtitle={`${plugins.length} installed`}
      actions={
        <button className="win-ctrl" title="Refresh" onClick={() => void refresh()}>
          <Icon name="refresh" size={14} strokeWidth={2} />
        </button>
      }
    >
      <div className="text-[10px] text-slate-500 px-1 mb-2 leading-relaxed">
        Plugin tools appear in the image editor under <b className="text-slate-300">Effects → Plugins</b>.
      </div>
      <div className="flex items-center gap-1.5 mb-3">
        <button className="chip" onClick={() => void install()}>
          Install from file…
        </button>
        <button className="chip" onClick={() => void api.pluginOpenFolder()}>
          Open folder
        </button>
      </div>

      {plugins.length === 0 ? (
        <EmptyState
          icon="plug"
          title="No plugins installed"
          hint="Plugins are small JSON manifests that add extra effects and export presets."
        />
      ) : (
        plugins.map((plugin) => (
          <div
            key={plugin.id}
            className="rounded-xl border border-white/8 bg-white/[0.02] p-2.5 mb-2"
          >
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="text-[11.5px] font-semibold text-slate-100 truncate">
                  {plugin.name}
                </div>
                <div className="text-[9.5px] text-slate-500">
                  {plugin.id} {plugin.version ? `· v${plugin.version}` : ""}
                </div>
              </div>
              <button
                className="win-ctrl !w-6 !h-6 hover:!bg-rose-500/80"
                title="Remove"
                onClick={async () => {
                  try {
                    await api.pluginRemove(plugin.id);
                    toast("Plugin removed");
                    await refresh();
                  } catch (error) {
                    toast(api.errorMessage(error), "error");
                  }
                }}
              >
                <Icon name="trash" size={12} />
              </button>
            </div>
            {plugin.description ? (
              <div className="text-[10px] text-slate-400 mt-1.5 leading-relaxed">
                {plugin.description}
              </div>
            ) : null}
            <div className="flex flex-wrap items-center gap-1.5 mt-2">
              {plugin.tools.map((tool) => (
                <span key={tool.id} className="chip" title={tool.effect ? `Effect: ${tool.effect}` : undefined}>
                  {tool.label}
                </span>
              ))}
            </div>
          </div>
        ))
      )}
    </PanelShell>
  );
}

// ---------------------------------------------------------------------------
// Window picker
// ---------------------------------------------------------------------------

function WindowsPanel() {
  const { toast, pushCapture, loadLibrary, setStatus } = useStore();
  const [windows, setWindows] = useState<api.WindowInfo[]>([]);
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    try {
      setWindows(await api.listWindows());
    } catch (error) {
      toast(api.errorMessage(error), "error");
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const grab = async (id: number) => {
    setBusy(true);
    setStatus("busy", "Capturing window…");
    try {
      const result = await api.captureWindow(id);
      pushCapture(result);
      await loadLibrary();
      toast("Window captured");
      setStatus("ready");
    } catch (error) {
      toast(api.errorMessage(error), "error");
      setStatus("error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <PanelShell
      title="Capture a window"
      subtitle={`${windows.length} open windows`}
      actions={
        <button className="win-ctrl" title="Refresh" onClick={() => void refresh()}>
          <Icon name="refresh" size={14} strokeWidth={2} />
        </button>
      }
    >
      {windows.length === 0 ? (
        <EmptyState icon="window" title="No windows found" hint="Open an app and refresh." />
      ) : (
        windows.map((win) => (
          <button
            key={win.id}
            className="w-full text-left rounded-xl border border-white/8 bg-white/[0.02] hover:border-violet-400/40 px-2.5 py-2 mb-1.5 transition-all"
            onClick={() => void grab(win.id)}
            disabled={busy}
          >
            <div className="text-[11px] text-slate-200 truncate">{win.title}</div>
            <div className="text-[9.5px] text-slate-500">
              {win.appName} · {win.width}×{win.height} {win.focused ? "· focused" : ""}
            </div>
          </button>
        ))
      )}
    </PanelShell>
  );
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export function Panels() {
  const view = useStore((s) => s.view);
  switch (view) {
    case "settings":
      return <SettingsPanel />;
    case "history":
      return <HistoryPanel />;
    case "ocr":
      return <OcrPanel />;
    case "pdf":
      return <PdfPanel />;
    case "cloud":
      return <CloudPanel />;
    case "ai":
      return <AiPanel />;
    case "plugins":
      return <PluginsPanel />;
    case "windows":
      return <WindowsPanel />;
    case "record":
      return <RecorderSetup />;
    default:
      return null;
  }
}