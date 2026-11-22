import assert from "node:assert/strict";
import { test } from "node:test";
import { measureSolidDisplay, requireNativeCamera, requireSolidDisplay } from "./frames.mjs";

test("fractional CSS bounds compare against the snapped canvas layer", () => {
  const width = 180;
  const height = 180;
  const viewport = { x: 0, y: 0.234375, width, height: height + 0.203125 };
  const clip = { x: 0, y: 0, width, height: height + 1 };
  const rgba = new Uint8Array(width * height * 4);
  const mask = new Uint8Array(width * height).fill(255);
  for (let y = 0; y < height; y++) {
    const row = y % 2 ? [64, 128, 240, 255] : [240, 200, 64, 255];
    for (let x = 0; x < width; x++) rgba.set(row, (y * width + x) * 4);
  }
  const data = new Uint8Array(clip.width * clip.height * 4);
  data.set(rgba);
  const display = measureSolidDisplay({ width, height: clip.height, data }, mask,
    { width, height }, [], rgba, { viewport, clip, displayDpr: 1 });
  requireSolidDisplay(display, true, width * clip.height);
  assert.equal(display.matchingColor, display.opaque);
});

test("native camera round-trips tolerate serialization precision and reject a changed pose", () => {
  const view = { radius: 5000, target: [0, 0, 114.42150000000015], fovDeg: 45 };
  requireNativeCamera({ ...view, target: [0, 0, 114.42150000000017] }, view);
  for (const target of [[0, 0, 114.42151], [0, 0], [NaN, 0, 114.42150000000015]]) {
    assert.throws(() => requireNativeCamera({ ...view, target }, view), /sidecar camera target differs/);
  }
});
