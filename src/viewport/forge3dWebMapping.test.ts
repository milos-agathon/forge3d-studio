
import type { TerrainPreview } from "../bridge/types";
import { cameraInput, chooseViewportBackend, imageryMipLevel, studioUnitsPerGroundUnit, supportsTransform, terrainInput, terrainSurfaceRelief, terrainTransform, type BackendState } from "./forge3dWebMapping.ts";
import { TERRAIN_VIEW_SIZE } from "./viewMath.ts";

function equal(actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) !== JSON.stringify(expected))
    throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
const assert = { equal, deepEqual: equal, ok: (actual: boolean) => equal(actual, true) };

const fixture: TerrainPreview = { ok: true, width: 50, height: 100, resolution: 2,
  spanXz: [20, 40], originXz: [300, 900], extentMeters: null, minElevation: 100, maxElevation: 115,
  heights: [101, 115, 100, 106] };
const rgba = new Uint8Array(16).fill(128);
const mapped = terrainInput(fixture, 2, [0.2, 0.3, 0.4], rgba);
assert.deepEqual(mapped.spacing, [20, 40]);
assert.deepEqual(mapped.heights, new Float32Array(fixture.heights));
assert.deepEqual(mapped.domain, [100, 115]);
assert.equal(mapped.exaggeration, 2);
assert.equal(Array.from(mapped.overlays!.layers![0].image.data.slice(0, 4)), [188, 188, 188, 128]);

// The drawn triangles retain accepted elevations on both sides of the source range.
const saddle = { ...fixture, minElevation: 4150.24, maxElevation: 4150.25,
  heights: [4150, 4150.25, 4150.25, 4151] };
const delta = 4150.25 - 4150.24;
const fine = terrainInput({ ...saddle, spanXz: [2, 1] }, 20, [1, 1, 1]);
assert.deepEqual(fine.domain, [0, delta]);
assert.equal(fine.heights[1], Math.fround(delta));
assert.equal(terrainSurfaceRelief(saddle, 0.25, 0.25), (4150 - 4150.24) / 2 + delta / 2);
assert.equal(terrainSurfaceRelief(saddle, 0.75, 0.75), (4151 - 4150.24) / 2 + delta / 2);
const rounded = { ...fixture, spanXz: [12, 6] as [number, number],
  minElevation: 100.004, maxElevation: 100.306, heights: [100, 100.31, 100, 100.31] };
const roundedInput = terrainInput(rounded, 10, [1, 1, 1]);
const [clampLow, clampHigh] = (roundedInput.material?.clamp?.heightRange ?? roundedInput.domain!).map(Math.fround);
for (const [i, expected] of [-0.04, 3.06].entries()) {
  const gpuHeight = Math.max(clampLow, Math.min(clampHigh, roundedInput.heights[i]));
  assert.ok(Math.abs((gpuHeight - Math.fround(roundedInput.domain![0])) * 10 - expected) < 1e-4);
  assert.ok(Math.abs(terrainSurfaceRelief(rounded, i, 0) * 10 - expected) < 1e-10);
}
const collapsed = { ...fixture, minElevation: 4096, maxElevation: 4096.0001, heights: Array(4).fill(4096) };
const [low, high] = terrainInput(collapsed, 1, [1,1,1]).domain!;
assert.equal(low, 4096);
assert.ok(Math.fround(high) > Math.fround(low));

const threshold = { ...fixture, spanXz: [2, 1] as [number, number],
  minElevation: 4096.0049, maxElevation: 4096.0051, heights: [4096.0049, 4096.0051, 4096.0049, 4096.0051] };
const thresholdInput = terrainInput(threshold, 20, [1,1,1]);
assert.deepEqual(thresholdInput.domain, [0, threshold.maxElevation - threshold.minElevation]);
assert.ok(Math.abs(thresholdInput.heights[1] * 20 * 6 - 0.024) < 1e-7);

// Derive world boundaries directly from source spans; neither rounded texel
// spacing nor the previously rounded ground-to-Studio scale defines an edge.
for (const [span, scale, translation, expected] of [
  [[2688,960], 1.25, [1.5,2,-0.75], [-6,9,-3.4285714285714284,1.9285714285714286]],
  [[25,7], 1.5, [0,0,42], [-9,9,39.48,44.52]],
  [[12,6], 1, [4e9,0,0], [3999999994,4000000006,-3,3]],
  [[171.2,85.6], 1, [0,0,0], [-6,6,-3,3]],
  [[25.1,12.55], 1, [0,0,0], [-6,6,-3,3]],
  [[84,61], 7, [0,0,0], [-42,42,-30.5,30.5]],
  [[42,29], 7, [0,0,0], [-42,42,-29,29]],
  [[5,2], 1, [0,0,3], [-6,6,0.6,5.4]],
] as const) {
  const { boundsXz } = terrainTransform({...fixture, spanXz:[...span]}, [...translation], scale);
  assert.deepEqual(boundsXz.flat(),expected);
}

// Represent the same metre-height surface using a footprint in feet.
const feetPreview: TerrainPreview = { ...fixture, spanXz: [20 / 0.3048, 40 / 0.3048], spanMetresPerUnit: 0.3048 };
const feetTerrain = terrainInput(feetPreview, 2, [0.2, 0.3, 0.4]);
assert.deepEqual(feetTerrain.spacing, mapped.spacing);
assert.equal(feetTerrain.exaggeration, mapped.exaggeration);
assert.deepEqual(feetTerrain.heights, mapped.heights);
assert.deepEqual(feetTerrain.domain, mapped.domain);
const elevationSpan = feetPreview.maxElevation - feetPreview.minElevation;
const threeRelief = elevationSpan * 2 * (TERRAIN_VIEW_SIZE / Math.max(...fixture.spanXz));
assert.equal(elevationSpan * feetTerrain.exaggeration! * studioUnitsPerGroundUnit(feetPreview), threeRelief);

const vertexColors = Float32Array.from([1, 0, 0, 0, 1, 0, 0, 0, 1, 0.5, 0.5, 0.5]);
const ramp = terrainInput(fixture, 1, [1, 1, 1], rgba, { vertexColors }).overlays!.layers!;
assert.deepEqual(ramp.map(layer => layer.blendMode), ["normal", "multiply"]);
assert.deepEqual(Array.from(ramp[0].image.data), [255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 188, 188, 188, 255]);
const drape = { width: 1, height: 1, data: Uint8Array.of(10, 20, 30, 255) };
const draped = terrainInput(fixture, 1, [1, 1, 1], rgba, { drape, vertexColors }).overlays!.layers!;
assert.equal(draped.length, 1);
assert.deepEqual(terrainInput(fixture, 1, [1, 1, 1], undefined, { drape }).overlays!.outputSize, [1, 1]);
assert.deepEqual(draped[0].image, drape);
assert.deepEqual(draped[0].extent, [0, 0, 1, 1]);
assert.equal(imageryMipLevel(1, 0, 0, 1, 2048), 0);
assert.equal(imageryMipLevel(2, 0, 0, 4, 2048), 0);
assert.equal(imageryMipLevel(0.25, 0, 0, 0.125, 2048), 3);
assert.equal(imageryMipLevel(0, 0.125, -0.25, 0, 2048), 3);
assert.equal(imageryMipLevel(0.01, 0, 0, 0.01, 4), 2);
assert.equal(mapped.renderMode, "perspective");
assert.equal(mapped.material?.albedoMode, "material");
assert.equal(terrainInput({ ...fixture, maxElevation: 100, heights: Array(4).fill(100) }, 1, [1, 1, 1]).domain![0], 100);
assert.deepEqual(cameraInput([7, 6, 9], [3, 0, 5], [0, 1, 0], 48, 0.2, 600, [1, 2, 3], 2),
  { position: [3, 2, 3], target: [1, -1, 1], up: [0, 1, 0], fovYDegrees: 48, near: 0.1, far: 300 });
assert.ok(supportsTransform([0, 0, 0], [2, 2, 2]));
assert.ok(!supportsTransform([0, 5, 0], [1, 1, 1]));
assert.ok(!supportsTransform([0, 0, 0], [1, 1, 2]));
assert.ok(!supportsTransform([0, 0, 0], [-1, -1, -1]));
const base: BackendState = { preference: "auto", mode: "solid", gpu: true,
  terrainCount: 1, transformSupported: true, hasHdri: false, terrainShadows: false };
const cases: [Partial<BackendState>, string, string][] = [
  [{}, "forge3d-web", "WebGPU available"], [{ preference: "forge3d-web" }, "forge3d-web", "WebGPU available"],
  [{ mode: "rendered" }, "native", "Rendered mode"], [{ preference: "three" }, "three", "View menu override"],
  [{ gpu: false, preference: "forge3d-web" }, "three", "WebGPU unavailable"],
  [{ mode: "material", hasHdri: true }, "three", "Material HDRI"], [{ mode: "material" }, "forge3d-web", "WebGPU available"],
  [{ mode: "material", terrainShadows: true }, "three", "Terrain shadows"],
  [{ terrainCount: 0 }, "forge3d-web", "WebGPU available"], [{ terrainCount: 2 }, "three", "Multiple visible terrains"],
  [{ transformSupported: false }, "three", "Terrain transform"],
  [{ terrainShadows: true }, "three", "Terrain shadows"],
  [{ terrainShadows: true, preference: "forge3d-web" }, "three", "Terrain shadows"],
  ...["DEVICE_REQUEST_FAILED", "DEVICE_LOST", "SURFACE_LOST", "OUT_OF_MEMORY", "RUNTIME_DISPOSED", "Material path unavailable"]
    .map(reason => [{ failure: reason }, "three", reason] as [Partial<BackendState>, string, string]),
];
for (const [delta, backend, reason] of cases) {
  assert.deepEqual(chooseViewportBackend({ ...base, ...delta }), { backend, reason });
}
console.log("Terrain mapping, camera mapping and viewport backend rules passed.");
