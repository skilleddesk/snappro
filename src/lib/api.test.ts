import { describe, expect, it } from "vitest";
import { formatBytes, formatDate, formatDuration, errorMessage } from "../lib/api";

describe("formatBytes", () => {
  it("formats zero", () => {
    expect(formatBytes(0)).toBe("0 B");
  });

  it("rounds small units to whole numbers", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2 KB");
  });

  it("uses one decimal for larger values", () => {
    expect(formatBytes(1536 * 1024)).toBe("1.5 MB");
  });

  it("walks up to gigabytes", () => {
    expect(formatBytes(3 * 1024 ** 3)).toBe("3 GB");
  });
});

describe("formatDuration", () => {
  it("renders mm:ss under an hour", () => {
    expect(formatDuration(0)).toBe("00:00");
    expect(formatDuration(65_000)).toBe("01:05");
  });

  it("renders hh:mm:ss over an hour", () => {
    expect(formatDuration(3_725_000)).toBe("01:02:05");
  });

  it("never returns a negative time", () => {
    expect(formatDuration(-500)).toBe("00:00");
  });
});

describe("formatDate", () => {
  it("returns a placeholder for a missing timestamp", () => {
    expect(formatDate(0)).toBe("—");
  });

  it("formats a real timestamp", () => {
    const text = formatDate(Date.UTC(2026, 0, 15, 12, 30));
    expect(text).toContain("2026");
  });
});

describe("errorMessage", () => {
  it("passes strings straight through", () => {
    expect(errorMessage("ffmpeg was not found")).toBe("ffmpeg was not found");
  });

  it("unwraps Error objects", () => {
    expect(errorMessage(new Error("boom"))).toBe("boom");
  });

  it("stringifies anything else", () => {
    expect(errorMessage({ odd: true })).toBe("[object Object]");
  });
});