// Renders src-tauri/icons/appicon.svg into the PNG sizes Tauri needs.
// Run with: node scripts/gen-icons.mjs
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const svg = readFileSync(resolve(root, "src-tauri/icons/appicon.svg"), "utf8");

const targets = [
  ["32x32.png", 32],
  ["128x128.png", 128],
  ["128x128@2x.png", 256],
  ["icon.png", 512],
  ["Square30x30Logo.png", 30],
  ["Square44x44Logo.png", 44],
  ["Square71x71Logo.png", 71],
  ["Square89x89Logo.png", 89],
  ["Square107x107Logo.png", 107],
  ["Square142x142Logo.png", 142],
  ["Square150x150Logo.png", 150],
  ["Square284x284Logo.png", 284],
  ["Square310x310Logo.png", 310],
  ["StoreLogo.png", 50],
];

const iconDir = resolve(root, "src-tauri/icons");
mkdirSync(iconDir, { recursive: true });

const pngBySize = new Map();
for (const [name, size] of targets) {
  const resvg = new Resvg(svg, { fitTo: { mode: "width", value: size } });
  const png = resvg.render().asPng();
  writeFileSync(resolve(iconDir, name), png);
  pngBySize.set(size, png);
  console.log("wrote", name, `${size}x${size}`);
}

// Build a small multi-resolution .ico with PNG frames (Vista+ ICO format).
const frames = [16, 32, 48, 64, 128, 256];
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); // reserved
header.writeUInt16LE(1, 2); // type: icon
header.writeUInt16LE(frames.length, 4);

const entries = [];
const payloads = [];
let offset = 6 + frames.length * 16;
for (const size of frames) {
  const resvg = new Resvg(svg, { fitTo: { mode: "width", value: size } });
  const png = resvg.render().asPng();
  const entry = Buffer.alloc(16);
  entry.writeUInt8(size === 256 ? 0 : size, 0);
  entry.writeUInt8(size === 256 ? 0 : size, 1);
  entry.writeUInt8(0, 2);
  entry.writeUInt8(0, 3);
  entry.writeUInt16LE(1, 4);
  entry.writeUInt16LE(32, 6);
  entry.writeUInt32LE(png.length, 8);
  entry.writeUInt32LE(offset, 12);
  offset += png.length;
  entries.push(entry);
  payloads.push(png);
}

writeFileSync(
  resolve(iconDir, "icon.ico"),
  Buffer.concat([header, ...entries, ...payloads]),
);
console.log("wrote icon.ico with", frames.join("/"), "frames");