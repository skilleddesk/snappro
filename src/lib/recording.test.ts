import { describe, expect, it } from "vitest";
import { acceleratorFromEvent, buildRecordOptions, fixedSize, prettyAccelerator } from "./recording";
import type { Settings } from "./api";

const base = {
  monitor: "primary",
  recordingMode: "screen",
  recordingFps: 0,
  recordingAudio: true,
  recordingAudioDevice: null,
  recordingWebcam: false,
  recordingCameraDevice: null,
  recordingFormat: "",
  recordingQuality: "",
  drawMouse: false,
  fixedWidth: 0,
  fixedHeight: 99999,
} as unknown as Settings;

const key = (code: string, mods: Partial<KeyboardEvent> = {}) => ({
  key: code,
  code,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
});

describe("buildRecordOptions", () => {
  it("falls back to sane defaults for empty settings", () => {
    const options = buildRecordOptions(base);
    expect(options.fps).toBe(30);
    expect(options.format).toBe("mp4");
    expect(options.quality).toBe("balanced");
    expect(options.audio).toBe(true);
    expect(options.drawMouse).toBe(false);
    expect(options.monitor).toBeNull();
  });

  it("uses the chosen monitor only for full-screen recording", () => {
    const settings = { ...base, monitor: "1" } as Settings;
    expect(buildRecordOptions(settings).monitor).toBe(1);
    expect(buildRecordOptions(settings, { mode: "window" }).monitor).toBeNull();
  });
});

describe("fixedSize", () => {
  it("clamps silly values", () => {
    expect(fixedSize(base)).toEqual({ width: 1280, height: 8000 });
    expect(fixedSize(null)).toEqual({ width: 1280, height: 720 });
  });
});

describe("acceleratorFromEvent", () => {
  it("waits while only modifiers are held", () => {
    expect(acceleratorFromEvent(key("Control", { ctrlKey: true }))).toBeNull();
  });

  it("builds a Tauri accelerator", () => {
    expect(
      acceleratorFromEvent({ ...key("KeyS"), key: "s", ctrlKey: true, shiftKey: true }),
    ).toBe("CmdOrCtrl+Shift+S");
    expect(acceleratorFromEvent({ ...key("Digit1"), key: "1", ctrlKey: true })).toBe("CmdOrCtrl+1");
  });

  it("refuses plain letters that would break typing", () => {
    expect(acceleratorFromEvent({ ...key("KeyA"), key: "a" })).toBeNull();
    expect(acceleratorFromEvent(key("F9"))).toBe("F9");
  });
});

describe("prettyAccelerator", () => {
  it("shows friendly symbols", () => {
    expect(prettyAccelerator("CmdOrCtrl+Shift+1")).toBe("Ctrl ⇧ 1");
    expect(prettyAccelerator("CmdOrCtrl+Alt+K", true)).toBe("⌘ ⌥ K");
  });
});
