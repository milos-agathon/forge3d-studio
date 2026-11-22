import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  cameraInput, runtimeToStudio, studioToRuntime, terrainInput, terrainSamplePoint, terrainTransform,
} from "./forge3dWebMapping.ts";
import {
  assetRevision, boundedTerrainResolution, cameraTarget, nativeRenderView, validateTerrainPreview,
  viewportDimensions, ViewportModel, viewportTerrainBackend,
} from "./viewportState.ts";

function sample(name) {
  return JSON.parse(readFileSync(new URL(`../../samples/${name}.studio3d`, import.meta.url), "utf8"));
}

const bryce = sample("bryce-terrain");
const [terrainObject, authoredCamera] = bryce.scene.objects;
const meshObject = sample("cube-animation").scene.objects.find(object => object.kind.type === "mesh");
const orbitCamera = {
  eye: [11, 7.5, 13], aim: { orbitTarget: [0, 0.8, 0] }, up: [0, 1, 0],
  fovYDegrees: 45, near: 0.05, far: 2000,
};

// A small synthetic grid with the Bryce project's metadata. The live parity
// capture exercises the bridge and samples from the actual DEM.
function brycePreview() {
  const { worldSpanXz, worldOriginXz, elevationRange, dimensions } = terrainObject.kind;
  return {
    ok: true, width: dimensions[0], height: dimensions[1], resolution: 2,
    spanXz: worldSpanXz, originXz: worldOriginXz, extentMeters: worldSpanXz, spanMetresPerUnit: 1,
    minElevation: elevationRange[0], maxElevation: elevationRange[1],
    heights: [2210, 2380, 2200, 2490],
  };
}

function near(actual, expected) {
  assert.ok(Math.abs(actual - expected) <= 1e-5, `expected ${expected}, got ${actual}`);
}

function nearPoint(actual, expected) {
  assert.equal(actual.length, 3);
  actual.forEach((value, axis) => near(value, expected[axis]));
}

test("empty project and Bryce build headlessly from their project objects", () => {
  const emptyProject = { ...bryce, assets: [], scene: { ...bryce.scene, objects: [], activeCamera: null } };
  const model = new ViewportModel(emptyProject, 1);
  model.setCamera(orbitCamera);
  model.setDimensions(viewportDimensions(801, 599, 1.5));
  assert.deepEqual(model.current.objects, []);
  assert.equal(model.current.terrains.size, 0);
  assert.equal(nativeRenderView(model.current), null);

  const project = {
    ...bryce, scene: { ...bryce.scene, objects: [...bryce.scene.objects, meshObject] },
  };
  model.setProject(project, 2, true);
  const { objects, assets } = model.current;
  assert.deepEqual(objects.map(object => object.id), project.scene.objects.map(object => object.id));
  assert.equal(objects[0].visible, true);
  assert.equal(objects[1].id, authoredCamera.id);
  assert.equal(objects[1].visible, false);
  assert.deepEqual(objects[1].translation, [11, 7.5, 13]);
  assert.deepEqual(objects[1].rotationDeg, [-24, 40, 0]);
  assert.deepEqual(objects[1].scale, [1, 1, 1]);
  assert.deepEqual(objects.at(-1).kind.material, meshObject.kind.material);
  assert.deepEqual(objects.at(-1).kind.source, meshObject.kind.source);
  assert.ok(assets.some(asset => asset.id === objects[0].kind.asset));

  const preview = brycePreview();
  const request = model.beginTerrain(terrainObject.id, preview.resolution);
  const terrain = model.acceptTerrain(request, preview);
  assert.equal(terrain.zScale, terrainObject.kind.zScale);
  assert.equal(terrain.preview.resolution, 2);
  assert.deepEqual(terrain.preview.originXz, [395998.5, -4165574.5]);
  assert.deepEqual(terrain.preview.spanXz, [4000, 3800]);
  assert.equal(terrain.preview.spanMetresPerUnit, 1);
  assert.deepEqual([terrain.preview.minElevation, terrain.preview.maxElevation], [2099.23, 2553.58]);
  assert.equal(terrain.preview.heights, preview.heights);

  model.setCamera({ ...orbitCamera, eye: [2, 6, 12] });
  assert.deepEqual(model.current.camera.eye, [2, 6, 12]);
  assert.equal(model.current.objects, objects);
  assert.equal(model.current.terrains.get(terrainObject.id).preview.heights, terrain.preview.heights);
});

test("a delayed response cannot populate another project or a reopened generation", () => {
  const model = new ViewportModel(bryce, 1);
  const responseFromA = model.beginTerrain(terrainObject.id, 2);
  const projectB = { ...bryce, id: "57385d55-c293-4daf-9663-c1456f90e659" };
  model.setProject(projectB, 2, false);
  const responseFromB = model.beginTerrain(terrainObject.id, 2);
  assert.equal(model.acceptTerrain(responseFromA, brycePreview()), undefined);
  assert.equal(model.current.terrains.size, 0);
  model.setProject(projectB, 3, false);
  const reopened = model.beginTerrain(terrainObject.id, 2);
  assert.equal(model.acceptTerrain(responseFromB, brycePreview()), undefined);
  assert.equal(model.current.terrains.size, 0);
  assert.equal(model.acceptTerrain(reopened, brycePreview()).request.projectGeneration, 3);
});

test("relinks and superseded requests invalidate stale samples", () => {
  const model = new ViewportModel(bryce, 1);
  const oldAsset = model.beginTerrain(terrainObject.id, 2);
  const relinked = { ...bryce, assets: bryce.assets.map(asset => asset.id === terrainObject.kind.asset
    ? { ...asset, path: "relinked.tif", byteSize: asset.byteSize + 1 } : asset) };
  model.setProject(relinked, 1, false);
  assert.equal(model.acceptTerrain(oldAsset, brycePreview()), undefined);
  const staleRung = model.beginTerrain(terrainObject.id, 2);
  const currentRung = model.beginTerrain(terrainObject.id, 3);
  assert.equal(model.acceptTerrain(staleRung, brycePreview()), undefined);
  const preview = { ...brycePreview(), extentMeters: null, spanMetresPerUnit: undefined,
    resolution: 3, heights: [2210, 2240, 2380, 2190, 2400, 2440, 2200, 2460, 2490] };
  const accepted = model.acceptTerrain(currentRung, preview);
  assert.notEqual(accepted.request.terrainRevision, oldAsset.terrainRevision);
  assert.equal(accepted.preview.spanMetresPerUnit, null);
  assert.equal(model.acceptTerrain(currentRung, preview), undefined);
  assert.equal(model.current.terrains.get(terrainObject.id), accepted);

  model.setProject(bryce, 1, false);
  assert.equal(model.current.terrains.size, 0);
  assert.equal(model.acceptTerrain(oldAsset, brycePreview()), undefined);

  const beforeExaggeration = model.beginTerrain(terrainObject.id, 2);
  const exaggerated = { ...terrainObject, kind: { ...terrainObject.kind, zScale: 4 } };
  model.setProject({ ...bryce, scene: { ...bryce.scene, objects: [exaggerated] } }, 1, false);
  assert.equal(model.acceptTerrain(beforeExaggeration, brycePreview()), undefined);
  const afterExaggeration = model.beginTerrain(terrainObject.id, 2);
  assert.equal(model.acceptTerrain(afterExaggeration, brycePreview()).zScale, 4);
});

test("a successful relink changes revision even when the asset record is identical", () => {
  const model = new ViewportModel(bryce, 1);
  const asset = bryce.assets.find(entry => entry.id === terrainObject.kind.asset);
  const stale = model.beginTerrain(terrainObject.id, 2);
  model.acceptTerrain(stale, brycePreview());

  model.setProject(bryce, 1, false, new Map([[asset.id, 1]]));
  assert.equal(model.current.terrains.size, 0);
  assert.notEqual(assetRevision(asset, 1), assetRevision(asset));
  assert.equal(model.acceptTerrain(stale, brycePreview()), undefined);
  const request = model.beginTerrain(terrainObject.id, 2);
  assert.notEqual(request.terrainRevision, stale.terrainRevision);
  const replacement = { ...brycePreview(), heights: [700, 700, 700, 700] };
  assert.equal(model.acceptTerrain(request, replacement).preview.heights, replacement.heights);
});

test("backend eligibility follows the headless project's mode, environment and shadows", () => {
  const project = { ...bryce, viewport: { ...bryce.viewport, mode: "material" },
    render: { ...bryce.render, environment: null, shadows: false, sunVisibility: false } };
  const model = new ViewportModel(project, 1);
  const choose = (device = { gpu: true }) => viewportTerrainBackend(model.current, "auto", device);
  assert.equal(choose().terrain, undefined);
  assert.equal(choose().backend, "forge3d-web");
  model.acceptTerrain(model.beginTerrain(terrainObject.id, 2), brycePreview());
  assert.equal(choose({ gpu: false }).reason, "WebGPU unavailable");
  for (const [delta, reason] of [[{ shadows: true }, "Terrain shadows"],
    [{ sunVisibility: true }, "Terrain shadows"], [{ environment: "project-hdri" }, "Material HDRI"]]) {
    model.setProject({ ...project, render: { ...project.render, ...delta } }, 1, false);
    assert.equal(choose().reason, reason);
  }
  model.setProject({ ...project, render: { ...project.render, shadows: true } }, 1, false);
  assert.equal(choose({ gpu: true, sunShadowsDisabled: true }).backend, "forge3d-web");
  model.setProject({ ...project, render: { ...project.render, shadows: true, sunVisibility: true } }, 1, false);
  assert.equal(choose({ gpu: true, sunShadowsDisabled: true }).reason, "Terrain shadows");
  model.setProject({ ...project, viewport: { ...project.viewport, mode: "rendered" } }, 1, false);
  assert.equal(choose().backend, "native");
});

test("hiding a terrain invalidates its pending and accepted previews", () => {
  const model = new ViewportModel(bryce, 1);
  const pending = model.beginTerrain(terrainObject.id, 2);
  const hidden = { ...terrainObject, visible: false };
  model.setProject({ ...bryce, scene: { ...bryce.scene, objects: [hidden] } }, 1, false);
  assert.equal(model.acceptTerrain(pending, brycePreview()), undefined);
  assert.equal(model.beginTerrain(terrainObject.id, 2), undefined);

  model.setProject(bryce, 1, false);
  assert.ok(model.acceptTerrain(model.beginTerrain(terrainObject.id, 2), brycePreview()));
  model.setProject({ ...bryce, scene: { ...bryce.scene, objects: [hidden] } }, 1, false);
  assert.equal(model.current.terrains.size, 0);
});

test("the preview limit is applied to the sampled grid, independent of source dimensions", () => {
  assert.equal(boundedTerrainResolution(256, 128), 128);
  assert.equal(boundedTerrainResolution(256, 7), undefined);
  const preview = { ...brycePreview(), resolution: 128, heights: Array(128 ** 2).fill(2210) };
  assert.deepEqual([preview.width, preview.height], [1024, 1024]);
  assert.doesNotThrow(() => validateTerrainPreview(preview, 128));
  assert.throws(() => validateTerrainPreview(preview, 127), /GPU texture limit of 127/);
  assert.throws(() => validateTerrainPreview({ ...preview, heights: [] }), /invalid height grid/);
  const wrongSize = { ...preview, resolution: 8, heights: Array(8 ** 2).fill(2210) };
  assert.throws(() => validateTerrainPreview(wrongSize, 256, 160), /8 × 8.*160 × 160/);
});

test("translated, uniformly scaled unequal spans round-trip all four corners and the aim", () => {
  const preview = { ...brycePreview(), spanXz: [4000, 2000], extentMeters: [4000, 2000],
    minElevation: 100, maxElevation: 125, heights: [110, 100, 125, 120] };
  const zScale = 2;
  const transform = terrainTransform(preview, [3, 4, -5], 2);
  const corners = [
    { row: 0, column: 0, studio: [-9, 4.12, -11], runtime: [-2000, 20, -1000] },
    { row: 0, column: 1, studio: [15, 4, -11], runtime: [2000, 0, -1000] },
    { row: 1, column: 0, studio: [-9, 4.3, 1], runtime: [-2000, 50, 1000] },
    { row: 1, column: 1, studio: [15, 4.24, 1], runtime: [2000, 40, 1000] },
  ];
  for (const { row, column, studio, runtime } of corners) {
    const point = terrainSamplePoint(preview, zScale, row, column);
    nearPoint(point, runtime);
    nearPoint(runtimeToStudio(point, transform), studio);
    nearPoint(studioToRuntime(studio, transform), runtime);
    nearPoint(runtimeToStudio(studioToRuntime(studio, transform), transform), studio);
  }

  const eye = [3, 9, 15];
  const aim = [3, 9, -2.6];
  const rolledUp = [-Math.SQRT1_2, Math.SQRT1_2, 0];
  const camera = cameraInput(eye, aim, rolledUp, 42, 0.3, 120, transform.translation, transform.scale);
  nearPoint(camera.up, rolledUp);
  nearPoint(camera.target, [0, 2500 / 3, 400]);
  nearPoint(runtimeToStudio(camera.target, transform), aim);
  near(camera.near, 50);
  near(camera.far, 20000);
  assert.equal(camera.fovYDegrees, 42);

  const input = terrainInput(preview, zScale, [0.2, 0.3, 0.4]);
  assert.deepEqual(input.spacing, [4000, 2000]);
  assert.deepEqual(input.domain, [100, 125]);
  assert.deepEqual(Array.from(input.heights), preview.heights);
  assert.deepEqual([input.exaggeration, preview.heights[0]], [2, 110]);
  const flat = { ...preview, maxElevation: 100, heights: [100, 100, 100, 100] };
  const flatInput = terrainInput(flat, zScale, [0.2, 0.3, 0.4]);
  assert.equal(flatInput.domain[0], 100);
  assert.ok(flatInput.domain[1] > flatInput.domain[0]);
  nearPoint(runtimeToStudio(terrainSamplePoint(flat, zScale, 0, 0), transform), [-9, 4, -11]);
  const fractionalDatum = 12345678.9;
  const fractionalFlat = { ...flat, minElevation: fractionalDatum, maxElevation: fractionalDatum,
    heights: [fractionalDatum, fractionalDatum, fractionalDatum, fractionalDatum] };
  assert.equal(terrainSamplePoint(fractionalFlat, zScale, 0, 0)[1], 0);

  const inFeet = { ...preview, spanMetresPerUnit: 0.3048 };
  const feetTransform = terrainTransform(inFeet, transform.translation, 2);
  const feetInput = terrainInput(inFeet, zScale, [0.2, 0.3, 0.4]);
  near(feetInput.spacing[0], 1219.2);
  near(feetInput.spacing[1], 609.6);
  nearPoint(runtimeToStudio(terrainSamplePoint(inFeet, zScale, 0, 0), feetTransform), [-9, 4 + 0.12 / 0.3048, -11]);
});

test("camera aim distances and half-relief preserve the native handoff", () => {
  const model = new ViewportModel(bryce, 1);
  model.setCamera(orbitCamera);
  assert.deepEqual(cameraTarget(orbitCamera, 10), [0, 0.8, 0]);
  near(nativeRenderView(model.current).target[2], 39.4916666667);

  const forwardCamera = { ...orbitCamera, eye: [3, 4, 15], aim: { forward: [0, 0, -1] } };
  model.setCamera(forwardCamera);
  assert.deepEqual(cameraTarget(forwardCamera), [3, 4, 14]);
  assert.deepEqual(cameraTarget(forwardCamera, 10), [3, 4, 5]);
  const native = nativeRenderView(model.current);
  nearPoint(native.target, [1000, -1666.666666667, 1106.158333333]);
  near(native.radius, 3333.333333333);
  near(native.phiDeg, 270);
  near(native.thetaDeg, 90);
  assert.equal(native.fovDeg, orbitCamera.fovYDegrees);
});

test("native orbit and forward cameras use the translated and uniformly scaled terrain frame", () => {
  const moved = structuredClone(bryce);
  const placement = moved.scene.objects.find(node => node.kind.type === "terrain").transform;
  placement.translation = { x: 2.5, y: 1, z: -3 };
  placement.scale = { x: 1.5, y: 1.5, z: 1.5 };
  const identity = new ViewportModel(bryce, 1);
  const model = new ViewportModel(moved, 1);
  const [low, high] = terrainObject.kind.elevationRange;
  const halfRelief = (high - low) * terrainObject.kind.zScale / 2;
  for (const camera of [orbitCamera, { ...orbitCamera, aim: { forward: [0, 0, -1] } }]) {
    identity.setCamera(camera);
    model.setCamera(camera);
    const previous = nativeRenderView(identity.current);
    const current = nativeRenderView(model.current);
    const aim = cameraTarget(camera, 10);
    const unit = 4000 / 12 / 1.5;
    nearPoint(current.target, [(aim[0] - 2.5) * unit, -(aim[2] + 3) * unit, (aim[1] - 1) * unit - halfRelief]);
    near(current.radius, previous.radius / 1.5);
    near(current.phiDeg, previous.phiDeg);
    near(current.thetaDeg, previous.thetaDeg);
  }
});

test("legacy remote camera framing waits for the current measured footprint", () => {
  const legacyTerrain = { ...terrainObject, kind: { ...terrainObject.kind,
    worldSpanXz: null, worldOriginXz: null, elevationRange: null } };
  const legacy = { ...bryce, assets: bryce.assets.map(asset => asset.id === terrainObject.kind.asset
    ? { ...asset, path: "https://example.com/elevations.tif" } : asset),
  scene: { ...bryce.scene, objects: [legacyTerrain, authoredCamera] } };
  const model = new ViewportModel(legacy, 1);
  model.setCamera(orbitCamera);
  assert.equal(nativeRenderView(model.current), null);
  model.acceptTerrain(model.beginTerrain(legacyTerrain.id, 2), brycePreview());
  const known = new ViewportModel(bryce, 1);
  known.setCamera(orbitCamera);
  assert.deepEqual(nativeRenderView(model.current), nativeRenderView(known.current));
  model.setProject(legacy, 2, false);
  assert.equal(nativeRenderView(model.current), null);
});

test("the viewport keeps CSS size and caps and floors physical size", () => {
  assert.deepEqual(viewportDimensions(801, 599, 1.5), {
    cssWidth: 801, cssHeight: 599, width: 1201, height: 898, pixelRatio: 1.5,
  });
  assert.deepEqual(viewportDimensions(801, 599, 2.5), {
    cssWidth: 801, cssHeight: 599, width: 1602, height: 1198, pixelRatio: 2,
  });
});

test("admitted heights belong only to the current terrain and retain its source footprint", () => {
  const model = new ViewportModel(bryce, 3);
  const grid = { ...brycePreview(), resolution: 16, heights: Array(256).fill(10) };
  const request = model.beginTerrain(terrainObject.id, 16);
  const source = model.acceptTerrain(request, grid);
  const owner = {};
  assert.throws(() => model.admitTerrain(source, 12, new Float32Array(143), owner), /invalid height grid/);
  assert.equal(model.current.terrains.get(terrainObject.id), source);
  const heights = Float32Array.from({ length: 144 }, (_, i) => i);
  const reduced = model.admitTerrain(source, 12, heights, owner);
  assert.equal(reduced.preview.resolution, 12);
  assert.equal(reduced.request.resolution, 12);
  assert.deepEqual(reduced.preview.heights, Array.from(heights));
  assert.deepEqual(reduced.preview.spanXz, grid.spanXz);
  assert.equal(reduced.preview.width, grid.width);
  assert.equal(reduced.admission.owner, owner);
  assert.equal(reduced.admission.requestedResolution, 16);
  assert.equal(model.admitTerrain(source, 8, new Float32Array(64), owner), undefined);
  const again = model.admitTerrain(reduced, 8, new Float32Array(64), owner);
  assert.equal(again.admission.requestedResolution, 16);
  model.setProject(bryce, 4, false);
  assert.equal(model.admitTerrain(again, 8, new Float32Array(64), owner), undefined);
  assert.equal(grid.resolution, 16);
});
