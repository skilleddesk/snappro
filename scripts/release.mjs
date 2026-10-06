#!/usr/bin/env node
/**
 * SnapPro release helper.
 *
 *   node scripts/release.mjs                  build for THIS computer, copy the installers into ../install/<os>/
 *   node scripts/release.mjs --skip-build     only collect what is already built
 *   node scripts/release.mjs --from-dir <dir> copy installers out of a folder (for example a CI download)
 *   node scripts/release.mjs --from-github v1.2.0   download the installers of a GitHub release (needs the `gh` CLI)
 *   node scripts/release.mjs --prune-only     only delete old versions
 *
 * Every installer lands in  <ScreenShort Software>/install/<windows|macos|linux>/  with one naming scheme,
 *   SnapPro_<version>_<os>_<arch>[_setup].<ext>
 * and every file of an older version is deleted, so the folder only ever holds the current release.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, "..");
// `SNAPPRO_INSTALL_DIR` lets the native build scripts on Linux / macOS fill the real install folder.
const installRoot = process.env.SNAPPRO_INSTALL_DIR
  ? path.resolve(process.env.SNAPPRO_INSTALL_DIR)
  : path.resolve(appDir, "..", "install");
const bundleDir = path.join(appDir, "src-tauri", "target", "release", "bundle");
const pkg = JSON.parse(fs.readFileSync(path.join(appDir, "package.json"), "utf8"));
const version = pkg.version;

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const OS_FOLDERS = ["windows", "macos", "linux", "source"];
const hostOs = { win32: "windows", darwin: "macos", linux: "linux" }[process.platform];
const hostArch = { x64: "x64", arm64: "arm64", ia32: "x86" }[process.arch] ?? process.arch;

function log(message) {
  console.log(`[release] ${message}`);
}

function run(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, { stdio: "inherit", shell: process.platform === "win32", cwd: appDir, ...options });
  if (result.status !== 0) {
    throw new Error(`${command} ${commandArgs.join(" ")} failed (${result.status})`);
  }
}

/** Every file below `dir`, recursively. */
function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

/** Map a raw bundler output file to {os, kind, ext, arch}, or null when it is not an installer. */
function classify(file) {
  const name = path.basename(file);
  const lower = name.toLowerCase();
  const archOf = () => {
    if (/arm64|aarch64/.test(lower)) return "arm64";
    if (/x86_64|x64|amd64/.test(lower)) return "x64";
    if (/universal/.test(lower)) return "universal";
    return hostArch;
  };
  if (lower.endsWith(".exe") && lower.includes("setup")) return { os: "windows", ext: "exe", suffix: "_setup", arch: archOf() };
  if (lower.endsWith(".msi")) return { os: "windows", ext: "msi", suffix: "", arch: archOf() };
  if (lower.endsWith(".dmg")) return { os: "macos", ext: "dmg", suffix: "", arch: archOf() };
  if (lower.endsWith(".deb")) return { os: "linux", ext: "deb", suffix: "", arch: archOf() };
  if (lower.endsWith(".rpm")) return { os: "linux", ext: "rpm", suffix: "", arch: archOf() };
  if (lower.endsWith(".appimage")) return { os: "linux", ext: "AppImage", suffix: "", arch: archOf() };
  return null;
}

function targetName(info) {
  return `SnapPro_${version}_${info.os}_${info.arch}${info.suffix}.${info.ext}`;
}

/** Copy installers found under `sourceDir` into install/<os>/. Returns the copied target paths. */
function collect(sourceDir) {
  const copied = [];
  for (const file of walk(sourceDir)) {
    const info = classify(file);
    if (!info) continue;
    // Only take files that belong to this version: stale bundler output must not slip in.
    if (!path.basename(file).includes(version) && !file.includes(version)) continue;
    const folder = path.join(installRoot, info.os);
    fs.mkdirSync(folder, { recursive: true });
    const target = path.join(folder, targetName(info));
    fs.copyFileSync(file, target);
    copied.push(target);
    log(`copied  ${path.relative(installRoot, target)}  (${(fs.statSync(target).size / 1048576).toFixed(1)} MB)`);
  }
  return copied;
}

/** Delete every SnapPro_* file of another version. */
function prune() {
  let removed = 0;
  for (const folderName of OS_FOLDERS) {
    const folder = path.join(installRoot, folderName);
    if (!fs.existsSync(folder)) continue;
    for (const entry of fs.readdirSync(folder)) {
      const match = /^SnapPro_(\d+\.\d+\.\d+(?:[-+][\w.]+)?)_/.exec(entry);
      if (match && match[1] !== version) {
        fs.rmSync(path.join(folder, entry), { force: true });
        log(`removed ${folderName}/${entry}  (old version ${match[1]})`);
        removed += 1;
      }
    }
  }
  if (removed === 0) log("no old versions to remove");
}

/** Bundle the source into install/source so Linux and macOS can build natively with one command. */
function packSource() {
  if (process.env.SNAPPRO_NO_SOURCE) return;
  const folder = path.join(installRoot, "source");
  fs.mkdirSync(folder, { recursive: true });
  const target = path.join(folder, `SnapPro_${version}_source.tar.gz`);
  const parent = path.resolve(appDir, "..");
  const name = path.basename(appDir);
  const excludes = ["node_modules", "dist", "target", ".git", "*.log"].flatMap((pattern) => ["--exclude", pattern]);
  // Relative output name + cwd: GNU tar reads "E:\..." as a remote host.
  const result = spawnSync("tar", ["-czf", path.basename(target), ...excludes, "-C", parent, name], { stdio: "inherit", cwd: folder });
  if (result.status !== 0) {
    log("could not create the source package (tar failed); Linux/macOS builds will need the GitHub workflow");
    return;
  }
  log(`packed  source/${path.basename(target)}  (${(fs.statSync(target).size / 1048576).toFixed(1)} MB)`);
}

/**
 * One-click kits for macOS and Linux: a tar.gz with the source and the build+install scripts.
 * Extract it and run the launcher; the machine builds SnapPro natively (Intel or Apple Silicon,
 * any Linux distribution), because those packages cannot be cross-built on Windows.
 */
function packKits() {
  if (process.env.SNAPPRO_NO_SOURCE) return;
  const sourceName = `SnapPro_${version}_source.tar.gz`;
  const sourceFile = path.join(installRoot, "source", sourceName);
  if (!fs.existsSync(sourceFile)) return;
  const kits = [
    { os: "macos", arch: "universal", launcher: "Install-SnapPro-macOS.command", scripts: ["build-install-macos.sh", "install-macos.sh"] },
    { os: "linux", arch: "any", launcher: "install-snappro-linux.sh", scripts: ["build-install-linux.sh", "install-linux.sh"] },
  ];
  for (const kit of kits) {
    const folderName = `SnapPro-${version}-${kit.os}`;
    const stage = fs.mkdtempSync(path.join(os.tmpdir(), "snappro-kit-"));
    const root = path.join(stage, folderName);
    const launcher = path.join(installRoot, kit.os, kit.launcher);
    if (!fs.existsSync(launcher)) continue;
    fs.mkdirSync(path.join(root, "install", kit.os), { recursive: true });
    fs.mkdirSync(path.join(root, "install", "source"), { recursive: true });
    fs.copyFileSync(launcher, path.join(root, kit.launcher));
    for (const script of kit.scripts) fs.copyFileSync(path.join(installRoot, kit.os, script), path.join(root, "install", kit.os, script));
    fs.copyFileSync(sourceFile, path.join(root, "install", "source", sourceName));
    // Unix line endings, whatever the editor on Windows did.
    for (const file of walk(root).filter((f) => !f.endsWith(".gz"))) {
      fs.writeFileSync(file, fs.readFileSync(file, "utf8").split(String.fromCharCode(13, 10)).join(String.fromCharCode(10)));
    }
    const out = `SnapPro_${version}_${kit.os}_${kit.arch}_installer.tar.gz`;
    const folder = path.join(installRoot, kit.os);
    const posix = (p) => p.split(path.sep).join("/");
    const result = spawnSync("tar", ["-czf", out, "--mode=u+rwx,go+rx", "-C", posix(stage), folderName], { stdio: "inherit", cwd: os.tmpdir() });
    if (result.status === 0) {
      fs.copyFileSync(path.join(os.tmpdir(), out), path.join(folder, out));
      fs.rmSync(path.join(os.tmpdir(), out), { force: true });
      log(`packed  ${kit.os}/${out}  (${(fs.statSync(path.join(folder, out)).size / 1048576).toFixed(1)} MB)`);
    } else {
      log(`could not create the ${kit.os} kit (tar failed)`);
    }
    fs.rmSync(stage, { recursive: true, force: true });
  }
}

function writeManifest() {
  const files = [];
  for (const folderName of OS_FOLDERS) {
    const folder = path.join(installRoot, folderName);
    if (!fs.existsSync(folder)) continue;
    for (const entry of fs.readdirSync(folder)) {
      if (!entry.startsWith("SnapPro_")) continue;
      const full = path.join(folder, entry);
      const sha256 = createHash("sha256").update(fs.readFileSync(full)).digest("hex");
      files.push({ os: folderName, file: `${folderName}/${entry}`, bytes: fs.statSync(full).size, sha256 });
    }
  }
  const manifest = { app: "SnapPro", version, built: new Date().toISOString(), files };
  fs.writeFileSync(path.join(installRoot, "LATEST.json"), JSON.stringify(manifest, null, 2) + "\n");
  const missing = ["windows", "macos", "linux"].filter((name) => !files.some((f) => f.os === name));
  log(`LATEST.json written (${files.length} installer file(s))`);
  if (missing.length) {
    log(`still missing: ${missing.join(", ")} — build them on that system or with the GitHub workflow, then run: npm run release -- --from-dir <folder>`);
  }
}

function main() {
  fs.mkdirSync(installRoot, { recursive: true });
  log(`SnapPro ${version} → ${installRoot}`);

  if (flag("--prune-only")) {
    prune();
    writeManifest();
    return;
  }

  const fromDir = option("--from-dir");
  const fromGithub = option("--from-github");

  if (fromGithub) {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "snappro-release-"));
    run("gh", ["release", "download", fromGithub, "--dir", temp, "--clobber"]);
    collect(temp);
    fs.rmSync(temp, { recursive: true, force: true });
  } else if (fromDir) {
    collect(path.resolve(fromDir));
  } else {
    if (!flag("--skip-build")) {
      log(`building the ${hostOs} installers (this takes a few minutes)…`);
      run("npm", ["run", "tauri", "--", "build"]);
    }
    const copied = collect(bundleDir);
    if (copied.length === 0) throw new Error(`no installers for version ${version} found in ${bundleDir}`);
  }

  packSource();
  packKits();
  prune();
  writeManifest();
  log("done");
}

try {
  main();
} catch (error) {
  console.error(`[release] ${error.message}`);
  process.exit(1);
}
