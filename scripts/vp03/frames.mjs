import assert from "node:assert/strict";

const solidBackground = [14, 17, 19];

// Compare the actual compositor crop with Solid's neutral backdrop. Only
// viewport chrome and the rounded border are excluded. An image above the
// canvas participates in this comparison.
export function measureSolidDisplay(stock, mask, { width, height, cssWidth, cssHeight }, chrome, rgba, layout) {
  const viewWidth = layout?.viewport.width ?? cssWidth;
  const viewHeight = layout?.viewport.height ?? cssHeight;
  const dpr = layout?.displayDpr ?? stock.width / viewWidth;
  const viewX = layout?.viewport.x ?? 0;
  const viewY = layout?.viewport.y ?? 0;
  // CDP rounds the screenshot origin in device pixels. Chromium snaps the
  // canvas layer edges in CSS pixels before applying the device scale.
  const originX = Math.round((layout?.clip.x ?? 0) * dpr);
  const originY = Math.round((layout?.clip.y ?? 0) * dpr);
  const layerX = Math.round(viewX);
  const layerY = Math.round(viewY);
  const layerWidth = Math.round(viewX + viewWidth) - layerX;
  const layerHeight = Math.round(viewY + viewHeight) - layerY;
  let inspected = 0;
  let changed = 0;
  let matches = 0;
  let expected = 0;
  let opaque = 0;
  let matchingColor = 0;
  for (let y = 0; y < stock.height; y++) {
    const cssY = (originY + y + 0.5) / dpr - viewY;
    const gpuY = (cssY + viewY - layerY) * height / layerHeight;
    for (let x = 0; x < stock.width; x++) {
      const cssX = (originX + x + 0.5) / dpr - viewX;
      if (cssX < 12 || cssY < 12 || cssX >= viewWidth - 12 || cssY >= viewHeight - 12 ||
          chrome.some(box => cssX >= box.x - 1 && cssX <= box.x + box.width + 1 &&
            cssY >= box.y - 1 && cssY <= box.y + box.height + 1)) continue;
      inspected++;
      const offset = (y * stock.width + x) * 4;
      const different = solidBackground.some((channel, c) => Math.abs(stock.data[offset + c] - channel) > 5);
      const gpuX = (cssX + viewX - layerX) * width / layerWidth;
      const index = Math.floor(gpuY) * width + Math.floor(gpuX);
      const terrain = !!mask?.[index];
      changed += Number(different);
      expected += Number(terrain);
      matches += Number(different && terrain);
      const alpha = index * 4 + 3;
      if (rgba?.[alpha] === 255 && rgba[alpha - 4] === 255 && rgba[alpha + 4] === 255 &&
          rgba[alpha - 4 * width] === 255 && rgba[alpha + 4 * width] === 255) {
        // Sample the texture at the compositor pixel centre using linear filtering.
        const left = Math.floor(gpuX - 0.5);
        const top = Math.floor(gpuY - 0.5);
        const fx = gpuX - 0.5 - left;
        const fy = gpuY - 0.5 - top;
        const nw = (top * width + left) * 4;
        const sw = nw + width * 4;
        if ([nw, nw + 4, sw, sw + 4].some(i => rgba[i + 3] !== 255)) continue;
        opaque++;
        matchingColor += Number(solidBackground.every((_, c) => {
          const north = rgba[nw + c] * (1 - fx) + rgba[nw + 4 + c] * fx;
          const south = rgba[sw + c] * (1 - fx) + rgba[sw + 4 + c] * fx;
          return Math.abs(stock.data[offset + c] - (north * (1 - fy) + south * fy)) <= 5;
        }));
      }
    }
  }
  return { inspected, changed, expected, iou: matches / (changed + expected - matches || 1), opaque, matchingColor };
}

export function requireSolidDisplay(display, expectTerrain, pixels) {
  assert.ok(display.inspected > pixels * 0.65, "Insufficient visible viewport for an absolute pixel check");
  if (expectTerrain) {
    assert.ok(display.expected > 0 && display.iou >= 0.97, "Compositor silhouette differs from terrain readback");
    assert.ok(display.opaque >= display.expected * 0.9 && display.matchingColor >= display.opaque * 0.99,
      `Compositor terrain colors differ from readback (${display.matchingColor} of ${display.opaque} opaque pixels)`);
  } else assert.equal(display.changed, 0, "Compositor contains foreground pixels on an empty frame");
}

export function requireNativeCamera(actual, expected) {
  assert.ok(actual && expected, "Native sidecar and live view must both contain a camera");
  for (const [key, value] of Object.entries(expected)) {
    if (value == null) {
      assert.equal(actual[key], value);
      continue;
    }
    const values = Array.isArray(value) ? value : [value];
    const measured = Array.isArray(value) ? actual[key] : [actual[key]];
    // Rust and Python can reserialize the same coordinate a few ULPs apart.
    assert.ok(Array.isArray(measured) && measured.length === values.length && values.every((number, i) =>
      Number.isFinite(number) && Number.isFinite(measured[i]) &&
      Math.abs(measured[i] - number) <= 4 * Number.EPSILON * Math.max(1, Math.abs(number))),
    `Native sidecar camera ${key} differs from the live view`);
  }
}

export function requireSubmittedCamera(actual, expected) {
  assert.ok(actual && expected, "The submitted frame and its host pose must both have a camera");
  for (const field of ["position", "target", "up", "fovYDegrees", "near", "far"]) {
    const values = Array.isArray(expected[field]) ? expected[field] : [expected[field]];
    const measured = Array.isArray(actual[field]) ? actual[field] : [actual[field]];
    assert.ok(measured.length === values.length && measured.every((value, i) =>
      Number.isFinite(value) && Math.abs(value - values[i]) <= 1e-6),
    `Submitted camera ${field} differs from the live viewport pose`);
  }
}

function requireVector(actual, expected, label) {
  assert.ok(Array.isArray(actual) && actual.length === expected.length &&
    actual.every((value, i) => Number.isFinite(value) && Math.abs(value - expected[i]) <= 1e-6),
  `${label} differs from the accepted grid`);
}

export function requireCurrentQuery(actual, expected, label = "Active query") {
  assert.ok(expected && Number.isFinite(actual?.elevation), "The accepted grid must have a query at the probe coordinate");
  assert.ok(Math.abs(actual.elevation - expected.elevation) <= 0.0005,
    `${label} elevation ${actual.elevation} differs from accepted grid elevation ${expected.elevation}`);
  requireVector(actual.gridPosition, expected.gridPosition, `${label} grid position`);
  requireVector(actual.worldPosition, expected.worldPosition, `${label} world position`);
  const aspectError = actual.aspectRadians - expected.aspectRadians;
  assert.ok(Number.isFinite(actual.aspectRadians) && Math.abs(Math.atan2(Math.sin(aspectError), Math.cos(aspectError))) <= 1e-6,
    `${label} aspect differs from the accepted grid`);
  assert.ok(Number.isFinite(actual.slopeRadians) && Math.abs(actual.slopeRadians - expected.slopeRadians) <= 1e-6,
    `${label} slope differs from the accepted grid`);
  requireVector(actual.normal, expected.normal, `${label} normal`);
}
