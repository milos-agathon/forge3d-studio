
import type { TerrainPreview } from "../bridge/types";
import { cameraInput, chooseViewportBackend, imageryMipLevel, studioUnitsPerGroundUnit, supportsTransform, terrainInput, type BackendState } from "./forge3dWebMapping.ts";
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

// The footprint is in feet. Both viewports must show the same relief from the raw DEM samples.
const feetPreview = { ...fixture, spanMetresPerUnit: 0.3048 };
const feetTerrain = terrainInput(feetPreview, 2, [0.2, 0.3, 0.4]);
assert.deepEqual(feetTerrain.spacing, [6.096, 12.192]);
assert.equal(feetTerrain.exaggeration, 0.6096);
assert.deepEqual(feetTerrain.heights, mapped.heights);
assert.deepEqual(feetTerrain.domain, mapped.domain);
const elevationSpan = feetPreview.maxElevation - feetPreview.minElevation;
const threeRelief = elevationSpan * 2 * (TERRAIN_VIEW_SIZE / Math.max(...feetPreview.spanXz));
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
assert.equal(terrainInput({ ...fixture, maxElevation: 100 }, 1, [1, 1, 1]).domain![0], 100);
assert.deepEqual(cameraInput([7, 6, 9], [3, 0, 5], [0, 1, 0], 48, 0.2, 600, [1, 2, 3], 2),
  { position: [3, 2, 3], target: [1, -1, 1], up: [0, 1, 0], fovYDegrees: 48, near: 0.1, far: 300 });
assert.ok(supportsTransform([0, 0, 0], [2, 2, 2]));
assert.ok(!supportsTransform([0, 5, 0], [1, 1, 1]));
assert.ok(!supportsTransform([0, 0, 0], [1, 1, 2]));
assert.ok(!supportsTransform([0, 0, 0], [-1, -1, -1]));
const base: BackendState = { preference: "auto", mode: "solid", gpu: true,
  terrainCount: 1, transformSupported: true, resolution: 128, hasHdri: false, terrainShadows: false };
const cases: [Partial<BackendState>, string, string][] = [
  [{}, "forge3d-web", "WebGPU available"], [{ preference: "forge3d-web" }, "forge3d-web", "WebGPU available"],
  [{ mode: "rendered" }, "native", "Rendered mode"], [{ preference: "three" }, "three", "View menu override"],
  [{ gpu: false, preference: "forge3d-web" }, "three", "WebGPU unavailable"],
  [{ mode: "material", hasHdri: true }, "three", "Material HDRI"], [{ mode: "material" }, "forge3d-web", "WebGPU available"],
  [{ mode: "material", terrainShadows: true }, "three", "Terrain shadows"],
  [{ terrainCount: 0 }, "three", "No visible terrain"], [{ terrainCount: 2 }, "three", "Multiple visible terrains"],
  [{ transformSupported: false }, "three", "Terrain transform"], [{ resolution: 0 }, "three", "Loading terrain"],
  [{ terrainShadows: true }, "three", "Terrain shadows"],
  [{ terrainShadows: true, preference: "forge3d-web" }, "three", "Terrain shadows"],
  [{ maxTextureDimension2D: 64 }, "three", "Terrain exceeds GPU texture limit"],
  ...["DEVICE_REQUEST_FAILED", "DEVICE_LOST", "SURFACE_LOST", "OUT_OF_MEMORY", "RUNTIME_DISPOSED", "Material path unavailable"]
    .map(reason => [{ failure: reason }, "three", reason] as [Partial<BackendState>, string, string]),
];
for (const [delta, backend, reason] of cases) {
  assert.deepEqual(chooseViewportBackend({ ...base, ...delta }), { backend, reason });
}
console.log("Terrain mapping, camera mapping and viewport backend rules passed.");
