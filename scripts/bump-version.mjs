#!/usr/bin/env node
/**
 * Set one version number everywhere:  node scripts/bump-version.mjs 1.2.0
 * (package.json, package-lock.json, src-tauri/tauri.conf.json, src-tauri/Cargo.toml)
 * Then run `npm run release` to build and refresh the install folder: every
 * older installer there is deleted automatically.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const next = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(next ?? "")) {
  console.error("usage: node scripts/bump-version.mjs <major.minor.patch>   e.g. 1.2.0");
  process.exit(1);
}

const edit = (relative, change) => {
  const file = path.join(root, relative);
  if (!fs.existsSync(file)) return;
  const before = fs.readFileSync(file, "utf8");
  const after = change(before);
  if (after !== before) fs.writeFileSync(file, after);
  console.log(`${after === before ? "unchanged" : "updated  "} ${relative}`);
};

edit("package.json", (text) => text.replace(/"version": "[^"]+"/, `"version": "${next}"`));
edit("package-lock.json", (text) => {
  // Only the first two "version" fields belong to the app itself.
  let count = 0;
  return text.replace(/"version": "[^"]+"/g, (match) => (count++ < 2 ? `"version": "${next}"` : match));
});
edit("src-tauri/tauri.conf.json", (text) => text.replace(/"version": "[^"]+"/, `"version": "${next}"`));
edit("src-tauri/Cargo.toml", (text) => text.replace(/^version = "[^"]+"/m, `version = "${next}"`));
console.log(`\nVersion is now ${next}. Next: npm run release`);
