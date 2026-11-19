import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { checkBlockedCapture, compareCaptures } from "./compare.mjs";
import { CANDIDATE_REVISION, CUBE_ID, FIELD_REVISION, TERRAIN_ID, verifyProvenance } from "./fixture.mjs";
import { completedBlockedObservation, VIEWPORT_READY_TIMEOUT_MS } from "./startup.mjs";

async function snapshots(t) {
  const root = await mkdtemp(join(tmpdir(), "vp01-compare-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const field = join(root, "field");
  const candidate = join(root, "candidate");
  await Promise.all([mkdir(field), mkdir(candidate)]);
  const provenance = await verifyProvenance();
  const manifest = role => ({
    version: 2, role, status: "captured", runId: role, target: { id: role },
    revision: role === "field" ? FIELD_REVISION : CANDIDATE_REVISION,
    provenance,
    fixture: { recipe: "vp01-bryce-v1", projectId: "test-project", projectSha256: "0".repeat(64),
      assets: [1, 2].map(id => ({ id, bytes: 128, sha256: String(id).repeat(64) })) },
    loaded: { id: "test-project",
      terrain: { id: TERRAIN_ID, resolution: 96, span: [4000, 3800], previewSpan: [4000, 3800], measuredSpan: [4000, 3800] },
      cube: { id: CUBE_ID, size: 2, translation: [0, 0.85, 0], color: [1, 0, 1],
        visible: true, liveVisible: true, liveColor: [1, 0, 1], liveTranslation: [0, 0.85, 0] },
    },
    toggles: { mode: "material", imagery: true, sky: true, environment: null, hillshade: false,
      gridVisible: false, shadows: false, sunVisibility: false, builtinSky: true, liveGridVisible: false,
      liveSunShadow: false, liveTerrainShadow: false, liveHillshade: false },
    viewport: { physical: { width: 4, height: 4 }, css: { x: 4, y: 4, width: 4, height: 4 },
      dpr: 1, drawingDpr: 1, origin: "top-left" },
    stock: { pose: { position: [0, 2, 4], target: [0, 0, 0], up: [0, 1, 0], quaternion: [0, 0, 0, 1],
      fov: 45, near: 0.05, far: 2000 } },
  });
  const write = (dir, value) => writeFile(join(dir, "manifest.json"), JSON.stringify(value));
  return { field, candidate, manifest, write };
}

test("comparison rejects incompatible captures before loading their masks", async t => {
  const { field, candidate, manifest, write } = await snapshots(t);
  await write(field, manifest("field"));
  const checks = [
    ["FIXTURE_MISMATCH", value => { value.fixture.assets[0].sha256 = "a".repeat(64); }],
    ["PHYSICAL_DIMENSIONS_MISMATCH", value => { value.viewport.css.width = value.viewport.physical.width = 5; }],
    ["POSE_MISMATCH", value => { value.stock.pose.position[0] = 1; }],
    ["INDEPENDENT_RUN_REQUIRED", value => { value.target.id = "field"; }],
    ["SERVED_RUNTIME_EVIDENCE_MISMATCH", value => { value.sourceEvidence = { runtime: {} }; }],
  ];
  for (const [code, mutate] of checks) {
    const value = manifest("candidate");
    mutate(value);
    await write(candidate, value);
    await assert.rejects(compareCaptures(field, candidate), { code });
  }
});

test("a disconnected target or denial without display and realm evidence cannot satisfy the startup control", async t => {
  const { candidate, manifest, write } = await snapshots(t);
  const value = manifest("webgl-blocked");
  value.status = "failed";
  value.reason = "CDP_CONNECTION_ERROR";
  await write(candidate, value);
  assert.equal((await checkBlockedCapture(candidate)).pass, false);
  value.reason = "WEBGL_BLOCKED_NO_VIEWPORT";
  value.startup = { blocked: true, tauri: true, loadedProjectId: value.fixture.projectId,
    liveViewport: false, webgpuAvailable: true,
    canaries: { webgpu: "GPUCanvasContext", twoD: "CanvasRenderingContext2D" }, contexts: [] };
  await write(candidate, value);
  assert.equal((await checkBlockedCapture(candidate)).pass, false);
  value.startup.contexts.push({ canvas: "viewport-canvas", requested: "webgl2", denied: true, result: null,
    stack: "at new WebGLRenderer" });
  await write(candidate, value);
  assert.equal((await checkBlockedCapture(candidate)).pass, false);
  value.startup.liveViewport = true;
  await write(candidate, value);
  assert.equal((await checkBlockedCapture(candidate)).pass, false);
});

test("blocked evidence must cover the normal startup budget from the first viewport denial", () => {
  const contexts = [
    { canvas: "", denied: true, timeMs: 10 },
    { canvas: "viewport-canvas", denied: true, timeMs: 340 },
    { canvas: "viewport-canvas", denied: true, timeMs: 350 },
  ];
  const observation = { denialAtMs: 340, screenAtMs: 1482, budgetMs: VIEWPORT_READY_TIMEOUT_MS };
  assert.equal(completedBlockedObservation(observation, contexts), false);
  observation.screenAtMs = observation.denialAtMs + VIEWPORT_READY_TIMEOUT_MS;
  assert.equal(completedBlockedObservation(observation, contexts), true);
  assert.equal(completedBlockedObservation({ ...observation, denialAtMs: 350 }, contexts), false);
});
