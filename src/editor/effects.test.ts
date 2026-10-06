import { describe, expect, it } from "vitest";
import { computeLevels, fitZoom, seededRandom, tornOffsets } from "./effects";
import { hexToRgba, rgbaToHex } from "./color";

describe("computeLevels", () => {
  it("finds the black and white points per channel", () => {
    // 4 pixels: darkest 20/30/40, brightest 200/210/220 (alpha opaque)
    const data = new Uint8ClampedArray([20, 30, 40, 255, 200, 210, 220, 255, 100, 100, 100, 255, 150, 150, 150, 255]);
    const { min, max } = computeLevels(data, 0);
    expect(min).toEqual([20, 30, 40]);
    expect(max).toEqual([200, 210, 220]);
  });

  it("ignores transparent pixels and keeps full range for flat images", () => {
    const flat = new Uint8ClampedArray([128, 128, 128, 255, 128, 128, 128, 255]);
    expect(computeLevels(flat)).toEqual({ min: [0, 0, 0], max: [255, 255, 255] });
    const clear = new Uint8ClampedArray([0, 0, 0, 0, 255, 255, 255, 0]);
    expect(computeLevels(clear)).toEqual({ min: [0, 0, 0], max: [255, 255, 255] });
  });

  it("clips stray extreme pixels", () => {
    const values: number[] = [];
    for (let i = 0; i < 1000; i += 1) {
      const v = 90 + (i % 21); // a real spread of mid greys
      values.push(v, v, v, 255);
    }
    values.push(0, 0, 0, 255); // one black speck in a mid grey picture
    values.push(255, 255, 255, 255);
    const { min, max } = computeLevels(values, 0.01);
    expect(min[0]).toBeGreaterThan(0);
    expect(max[0]).toBeLessThan(255);
  });
});

describe("fitZoom", () => {
  it("shrinks big pictures to fit and never magnifies", () => {
    expect(fitZoom({ width: 2000, height: 1000 }, { width: 1048, height: 548 }, 48)).toBeCloseTo(0.5, 2);
    expect(fitZoom({ width: 100, height: 100 }, { width: 1000, height: 1000 })).toBe(1);
  });

  it("is safe with empty content", () => {
    expect(fitZoom({ width: 0, height: 0 }, { width: 100, height: 100 })).toBe(1);
  });
});

describe("tornOffsets", () => {
  it("is deterministic and stays inside the depth", () => {
    const a = tornOffsets(500, 14, 3);
    const b = tornOffsets(500, 14, 3);
    expect(a).toEqual(b);
    expect(Math.max(...a)).toBeLessThanOrEqual(14);
    expect(Math.min(...a)).toBeGreaterThanOrEqual(0);
    expect(tornOffsets(500, 14, 4)).not.toEqual(a);
  });

  it("seededRandom repeats", () => {
    const r1 = seededRandom(9);
    const r2 = seededRandom(9);
    expect([r1(), r1(), r1()]).toEqual([r2(), r2(), r2()]);
  });
});

describe("colour helpers", () => {
  it("round trips hex and rgba", () => {
    expect(hexToRgba("#ff0000", 0.5)).toBe("rgba(255, 0, 0, 0.5)");
    expect(rgbaToHex("rgba(255, 0, 0, 0.5)")).toBe("#ff0000");
    expect(rgbaToHex("#abc")).toBe("#aabbcc");
  });

  it("treats transparent as no colour, not black", () => {
    expect(rgbaToHex("rgba(0,0,0,0)")).toBeNull();
    expect(rgbaToHex("transparent")).toBeNull();
    expect(rgbaToHex(undefined)).toBeNull();
  });
});
