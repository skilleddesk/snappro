# SnapPro

A light screenshot, annotation and screen-recording suite for Windows, macOS and Linux — the
same app, the same look and the same features on all three.
Built with **Tauri 2 + React 18 + TypeScript + Tailwind CSS + Fabric.js + Rust** (about 9 MB installed, no Electron).

```
ScreenShort Software/
├─ snappro/        ← this application (source code)
└─ install/        ← ready-made installers, newest version only (see install/README.md)
```

## Quick start (developers)

```bash
cd snappro
npm install
npm run tauri dev          # development with hot reload
npm run release            # build installers for THIS computer → ../install/<os>/ (old versions are deleted)
npm run version:bump -- 0.2.0   # change the version everywhere before a release
npm test                   # frontend unit tests (vitest)
cd src-tauri && cargo test # backend tests
```

The frontend also runs in a normal browser with sample data (no Rust side):
`npm run dev` → `http://localhost:1420/` (main), `?w=editor`, `?w=region`, `?w=recorder`, `?w=preview`.

## External tools

| Tool | Needed for | Install |
| --- | --- | --- |
| **ffmpeg** | screen recording, GIF export, video thumbnails | Settings → System check → *Install* (winget / Homebrew / apt) |
| **tesseract** | OCR ("Text" capture, OCR panel) | same button |

Everything else — capture, editor, PDF, AI tools, plugins — runs without them.

## Features

**Capture**
- Full screen, all monitors, rectangle (hover a window and click to snap to it), freehand, active window, window list
- **Scrolling capture** with automatic scroll detection, sticky header/footer handling and pixel-exact stitching (Esc stops early)
- Fixed-size frame (size in Settings), delayed capture with a visible countdown
- **Text capture**: select an area, the text goes straight to the clipboard (OCR)
- **Screen colour picker** with a pixel magnifier (click = HEX, Shift+click = RGB, arrow keys nudge by 1 px)
- Multi-monitor aware (monitors left of / above the primary one work); regions may straddle monitors

**Recorder**
- Full screen (any display), one window, or any area; MP4, MKV or GIF
- Microphone / system audio source, webcam picture-in-picture, mouse pointer on/off
- Pause / resume (segments are joined when you stop), crash-safe recording (Matroska first, remuxed at the end)

**Editor** (a full image editor, not just a markup tool)
- Drawing: arrow (5 head styles, dashed), line, box, oval, pen, highlighter pen, highlight box, text with fonts / bold / italic / alignment / background, callout bubbles, numbered steps, stamps
- Privacy: **blur, pixelate and solid block** redaction that samples the real picture underneath
- Focus: spotlight (dim everything else), magnifier loupe
- Layers panel (show/hide, lock, reorder, delete), duplicate, nudge with arrow keys, unlimited-ish undo/redo (60 steps)
- Crop with aspect ratios and numeric fields; resize, canvas size, rotate, flip — annotations follow the picture
- Colour adjustments: brightness, contrast, saturation, hue, gamma, soften, sharpen, grayscale, sepia, invert, auto levels
- Effects: Beautify (padding, gradient backdrops, rounded corners, shadow), frame, rounded corners, torn edge, fade edge, watermark (single or tiled)
- Zoom / pan (Ctrl+wheel, Space-drag), paste a picture from the clipboard as a new layer
- Save, save copy, save as, copy, export PNG/JPG/WebP/PDF

**Tools**: OCR panel (Tesseract), multi-page PDF, cloud upload (Imgur / S3 / Google Drive / custom), AI tools (background removal, privacy blur, auto enhance), plugins (JSON manifests whose effects appear in the editor)

**Shell**: quick bar, tray menu, configurable global shortcuts (click a field and press the keys), preview window after every capture (with Save when *Auto save* is off), launch at startup, single instance, library with cached thumbnails.

## Platform notes

| System | Screen input | Notes |
| --- | --- | --- |
| Windows | `gdigrab` | ffmpeg runs DPI-aware so regions match on scaled displays |
| macOS | `avfoundation` | allow Screen Recording + Accessibility (scrolling capture) in System Settings |
| Linux | `x11grab` | recording and scrolling capture need an X11 session; screenshots work on Wayland |

## Project layout

```
src/
  components/   Toolbar, MiniMode, Panels (+ SettingsPanel, HistoryPanel), RegionOverlay,
                RecorderWindow, PreviewWindow, Editor + EditorPanels
  editor/       engine.ts (canvas, history, image operations), shapes.ts (custom Fabric objects),
                tools.ts (drawing tools, style read/write), effects.ts (pure image effects), color.ts
  lib/          api.ts (typed IPC), store.ts, recording.ts, mock.ts (browser preview data)
src-tauri/src/
  lib.rs        app setup, tray, command registry      commands.rs   every #[tauri::command]
  capture/      full, region, scrolling, window         recorder/     ffmpeg pipelines
  ai.rs ocr.rs pdf.rs cloud.rs plugins.rs history.rs settings.rs imageio.rs util.rs
scripts/        release.mjs (collect installers, prune old), bump-version.mjs, gen-icons.mjs
```

## Releasing

See [`../install/README.md`](../install/README.md). In short: `npm run version:bump -- X.Y.Z` then `npm run release`.
For all three systems at once, push a `vX.Y.Z` tag: `.github/workflows/release.yml` builds Windows, macOS (Apple Silicon + Intel)
and Linux, and `npm run release -- --from-github vX.Y.Z` fills the `install` folder and removes every older version.

## Notes

- Closing a window hides it; SnapPro keeps running in the tray. Use **Quit SnapPro** in the tray menu or Settings to exit.
- Captures go to `Pictures/SnapPro` (changeable). Logs: `Pictures/SnapPro/snappro.log`, ffmpeg output: `ffmpeg.log` there too.
- `settings.json` lives in the app config folder; a broken file is kept as `settings.broken.json` instead of being overwritten.
