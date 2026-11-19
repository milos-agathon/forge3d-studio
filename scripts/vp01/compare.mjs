import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { isDeepStrictEqual as equal } from "node:util";
import { completedPresentationProbe, confirmedBlockedScreen, displayThresholds, measureCanvasContribution, measureDisplay,
  measureErrorPaint, measureImageryAlignment, readFrame } from "./composition.mjs";
import { completedBlockedObservation } from "./startup.mjs";
import { CANDIDATE_REVISION, CUBE_ID, FIELD_REVISION, isPinnedProvenance, isPinnedRuntimeInventory, TERRAIN_ID } from "./fixture.mjs";

const poseNames = ["default", "low-oblique", "near-nadir"];
const expectedToggles = {
  mode: "material", imagery: true, sky: true, environment: null,
  hillshade: false, gridVisible: false, shadows: false, sunVisibility: false,
  builtinSky: true, liveGridVisible: false, liveSunShadow: false, liveTerrainShadow: false, liveHillshade: false,
};
const historicalFieldCube = { pixels: 16091, width: 794, height: 727, dpr: 1 };

export class ComparisonError extends Error {
  constructor(code, detail) {
    super(`${code}: ${detail}`);
    this.code = code;
  }
}

function requireEvidence(condition, code, detail) {
  if (!condition) throw new ComparisonError(code, detail);
}

function check(code, pass, evidence) {
  return { code, status: pass ? "pass" : "unexpected-failure", evidence };
}

async function loadCapture(dir) {
  const path = join(dir, "manifest.json");
  let manifest;
  try {
    manifest = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new ComparisonError("MANIFEST_UNREADABLE", `${path} (${error.message})`);
  }
  requireEvidence(manifest?.version === 2, "MANIFEST_VERSION_MISMATCH", path);
  return manifest;
}

function verifyFixtureIdentity(fixture) {
  requireEvidence(fixture?.recipe === "vp01-bryce-v1" && typeof fixture.projectId === "string" &&
    /^[a-f0-9]{64}$/.test(fixture.projectSha256) && fixture.assets?.length === 2 &&
    fixture.assets.every(asset => Number.isInteger(asset.bytes) && asset.bytes > 0 && /^[a-f0-9]{64}$/.test(asset.sha256)),
  "FIXTURE_IDENTITY_MISSING", "Missing project or asset digest in the capture");
}

function verifyLoadedFixture(manifest) {
  const { loaded, fixture, toggles } = manifest;
  const expected = {
    id: fixture.projectId,
    terrain: { id: TERRAIN_ID, resolution: 96, span: [4000, 3800], previewSpan: [4000, 3800], measuredSpan: [4000, 3800] },
    cube: { id: CUBE_ID, size: 2, translation: [0, 0.85, 0], color: [1, 0, 1],
      visible: true, liveVisible: true, liveColor: [1, 0, 1], liveTranslation: [0, 0.85, 0] },
  };
  requireEvidence(equal(loaded, expected), "LOADED_FIXTURE_MISMATCH", manifest.role);
  requireEvidence(Object.entries(expectedToggles).every(([name, value]) => toggles?.[name] === value),
    "FIXTURE_TOGGLES_MISMATCH", manifest.role);
}

function tuple(value, length) {
  return Array.isArray(value) && value.length === length && value.every(Number.isFinite);
}

function sameCamera(a, b) {
  const same = (x, y) => Number.isFinite(x) && Number.isFinite(y) && Math.abs(x - y) <= 1e-6;
  return ["near", "far", "fov"].every(key => same(a?.[key], b?.[key])) &&
    ["position", "target", "up", "quaternion"].every(key => tuple(a[key], key === "quaternion" ? 4 : 3) &&
      tuple(b[key], key === "quaternion" ? 4 : 3) &&
      a[key].every((value, index) => same(value, b[key][index])));
}

function physicalDimensions(viewport) {
  const { width, height } = viewport?.physical ?? {};
  requireEvidence([width, height].every(n => Number.isInteger(n) && n > 0),
    "PHYSICAL_DIMENSIONS_INVALID", "Expected a nonempty drawing buffer");
  requireEvidence(viewport.origin === "top-left" && tuple([viewport.css?.x, viewport.css?.y], 2) &&
    [viewport.dpr, viewport.drawingDpr, viewport.css?.width, viewport.css?.height].every(n => Number.isFinite(n) && n > 0) &&
    Math.abs(width - viewport.css.width * viewport.drawingDpr) <= 1 &&
    Math.abs(height - viewport.css.height * viewport.drawingDpr) <= 1,
  "PIXEL_MAPPING_INVALID", "Expected a top-left buffer and CSS box at the recorded DPR");
  return { width, height };
}

async function readMask(dir, entry, { width, height }) {
  requireEvidence(typeof entry?.mask === "string" && entry.mask === basename(entry.mask) && !/[\\/]/.test(entry.mask),
    "MASK_PATH_INVALID", `${dir}: expected a mask file name`);
  let bytes;
  try {
    bytes = await readFile(join(dir, entry.mask));
  } catch (error) {
    throw new ComparisonError("MASK_UNREADABLE", `${entry.mask} (${error.message})`);
  }
  requireEvidence(bytes.length === width * height && !bytes.some(value => value > 1),
    "MASK_FORMAT_INVALID", `${entry.mask}: expected ${width * height} top-left binary pixels`);
  const count = bytes.reduce((sum, value) => sum + value, 0);
  requireEvidence(entry.count === count, "MASK_COUNT_MISMATCH", `${entry.mask}: declared ${entry.count}, read ${count}`);
  return { bytes, count, file: entry.mask };
}

function interiorPixel([x, y], mask, { width, height }) {
  if (![x, y].every(Number.isInteger) || x < 1 || y < 1 || x >= width - 1 || y >= height - 1) return false;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (!mask[(y + dy) * width + x + dx]) return false;
    }
  }
  return true;
}

const writable = draw => draw?.colorWrite === true && equal(draw.colorMask, [true, true, true, true]);
const depthOnly = draw => draw?.colorWrite === false && equal(draw.colorMask, [false, false, false, false]) &&
  draw.depthWrite === true && draw.depthTest === true;
const observedDraws = (draws, predicate) => Array.isArray(draws) && draws.length > 0 &&
  draws.every(draw => draw.elements > 0 && predicate(draw));

async function checkObject(dir, capture, size) {
  const { upper, click, selection } = capture.object ?? {};
  const [visible, hidden, restored] = await Promise.all([
    readMask(dir, upper?.visible, size), readMask(dir, upper?.hidden, size), readMask(dir, upper?.restored, size),
  ]);
  const counts = { visible: visible.count, hidden: hidden.count, restored: restored.count };
  const checks = [check("VISIBLE_CUBE_MASK_EMPTY", visible.count > 0, counts),
    check("CUBE_MASK_HIDE_RESTORE", visible.count > 0 && hidden.count === 0 && restored.bytes.equals(visible.bytes), counts),
    check("CUBE_WEBGL_DRAW", observedDraws(upper.visible.cubeDraw, writable), upper.visible.cubeDraw)];
  const clickPixel = click?.physical;
  const { css, drawingDpr } = capture.viewport;
  const cssCentre = tuple(clickPixel, 2) ? [css.x + (clickPixel[0] + 0.5) * css.width / size.width,
    css.y + (clickPixel[1] + 0.5) * css.height / size.height] : null;
  const pointer = selection?.pointer;
  const raycast = selection?.raycast;
  const cssNdc = tuple(pointer?.css, 2) ? [2 * (pointer.css[0] - css.x) / css.width - 1,
    1 - 2 * (pointer.css[1] - css.y) / css.height] : null;
  const near = (a, b, epsilon) => tuple(a, 2) && tuple(b, 2) && a.every((value, i) => Math.abs(value - b[i]) <= epsilon);
  const clickVerified = cssCentre && interiorPixel(clickPixel, restored.bytes, size) &&
    click.drawingDpr === drawingDpr && near(click.css, cssCentre, 1e-6) && pointer?.trusted === true &&
    pointer.button === 0 && near(pointer.css, click.css, 1);
  checks.push(check("CUBE_INTERIOR_TRUSTED_CLICK", Boolean(clickVerified), { click, pointer, cssCentre }));
  checks.push(check("STUDIO_THREE_RAYCAST_SELECTION", Boolean(clickVerified) && raycast?.uuid === CUBE_ID &&
    raycast.handler === "onPointerUp" && raycast.recursive === true && near(raycast.ndc, cssNdc, 1e-5) &&
    raycast.source === "three.js Raycaster.intersectObjects" && /onPointerUp[^\n]*Viewport3D\.tsx/.test(raycast.stack) &&
    selection.selectedUuid === CUBE_ID && equal(selection.selection, [CUBE_ID]),
  { selectedUuid: selection?.selectedUuid, selection: selection?.selection, raycast, cssNdc }));
  return { counts, checks };
}

async function checkDisplay(dir, capture, size) {
  const { viewport, stock, composition, object, terrain } = capture;
  const [cube, ground] = await Promise.all([
    readMask(dir, object.upper.visible, size), readMask(dir, terrain.poses.default, size),
  ]);
  let measured;
  try {
    const [visible, noCube, noTerrain] = await Promise.all(
      [stock, composition?.noCube, composition?.noTerrain].map(frame => readFrame(dir, frame, viewport)));
    measured = measureDisplay({ stock: visible, noCube, noTerrain }, cube.bytes, ground.bytes, size, object.click?.physical,
      { css: viewport.css, chrome: stock.displayChrome });
  } catch (error) {
    throw new ComparisonError("DISPLAY_EVIDENCE_INVALID", capture.role + " · " + error.message);
  }
  const { imagery, ...evidence } = measured;
  return { cube, imagery, checks: [
    check("DISPLAY_CUBE_COVERAGE", evidence.cubeFraction >= displayThresholds.cube, evidence),
    check("DISPLAY_CUBE_AT_CLICK", evidence.clickVisible, { pixel: object.click?.physical, visible: evidence.clickVisible }),
    ...terrainDisplayChecks(evidence),
  ] };
}

function terrainDisplayChecks(evidence) {
  return [
    check("DISPLAY_TERRAIN_COVERAGE", evidence.terrainFraction >= displayThresholds.terrain &&
      evidence.chromeFraction <= displayThresholds.maximumChromeCoverage, evidence),
    check("DISPLAY_TERRAIN_SILHOUETTE_IOU", evidence.silhouette.iou >= displayThresholds.terrainIou,
      { ...evidence.silhouette, minimum: displayThresholds.terrainIou }),
  ];
}

function checkTerrainAppearance(field, candidate, size) {
  const { color, ...alignment } = measureImageryAlignment(field, candidate, size);
  return {
    imagery: check("DISPLAY_TERRAIN_IMAGERY_ALIGNMENT", alignment.directions.every(direction =>
      direction.cosine >= displayThresholds.imageryCosine && direction.contrastRatio >= displayThresholds.minimumImageryContrast),
    { ...alignment, minimumCosine: displayThresholds.imageryCosine, minimumContrastRatio: displayThresholds.minimumImageryContrast }),
    color: check("DISPLAY_TERRAIN_COLOR_PARITY", color.samples > 0 && color.fraction <= displayThresholds.maximumColorMismatch,
      { ...color, channelDelta: displayThresholds.channelDelta, maximumFraction: displayThresholds.maximumColorMismatch }),
  };
}

async function measurePoseDisplay(dir, capture, name, size, terrain) {
  const display = capture.terrain.poses[name].display;
  const detail = capture.role + " · " + name;
  requireEvidence(display?.screen && display?.noTerrain && display.screen.png !== display.noTerrain.png,
    "POSE_DISPLAY_EVIDENCE_MISSING", detail);
  try {
    const [screen, noTerrain] = await Promise.all([display.screen, display.noTerrain]
      .map(frame => readFrame(dir, frame, capture.viewport)));
    const { imagery, ...evidence } = measureDisplay({ stock: screen, noCube: screen, noTerrain },
      new Uint8Array(terrain.length), terrain, size, null,
      { css: capture.viewport.css, chrome: display.displayChrome });
    return { imagery, checks: terrainDisplayChecks(evidence) };
  } catch (error) {
    throw new ComparisonError("POSE_DISPLAY_EVIDENCE_INVALID", detail + " · " + error.message);
  }
}

function cubeParity(field, candidate) {
  let intersection = 0;
  for (let i = 0; i < field.bytes.length; i++) intersection += field.bytes[i] & candidate.bytes[i];
  const union = field.count + candidate.count - intersection;
  const iou = union === 0 ? 0 : intersection / union;
  // Different colour paths and antialiasing can shift boundary pixels.
  return check("CUBE_SILHOUETTE_IOU", iou >= 0.97, { fieldPixels: field.count, candidatePixels: candidate.count,
    intersection, union, iou, minimum: 0.97 });
}

async function checkPasses(dir, capture, size) {
  const hybrid = capture.role === "candidate";
  const { stock, object } = capture;
  const { webgl, webgpu, canvases } = stock ?? {};
  const contexts = capture.startup?.contexts ?? [];
  const expectedLayers = hybrid ? ["lower", "upper"] : ["upper"];
  const visibleLayers = (canvases ?? []).filter(canvas => !canvas.hidden);
  const layers = visibleLayers.map(canvas => canvas.pass);
  const contextsMatch = webgl?.context === "WebGL2RenderingContext" && Boolean(webgl.renderer) &&
    contexts.some(context => context.canvas === "viewport-canvas" && context.result === webgl.context) &&
    (hybrid ? Boolean(webgpu?.adapter?.backend) && webgpu.width === size.width && webgpu.height === size.height &&
      contexts.some(context => context.canvas === "viewport-canvas viewport-canvas--terrain" && context.result === "GPUCanvasContext") : !webgpu);
  const terrainDraw = object.upper.visible.terrainDraw;
  const checks = [check("VIEWPORT_CONTEXTS", contextsMatch, { webgl, webgpu, contexts }),
  check("VIEWPORT_CANVAS_ORDER", equal(layers, expectedLayers) && visibleLayers.every(canvas =>
    canvas.width === size.width && canvas.height === size.height), canvases),
  check(hybrid ? "UPPER_TERRAIN_DEPTH_ONLY" : "WEBGL_TERRAIN_COLOR_DRAW",
    observedDraws(terrainDraw, hybrid ? depthOnly : writable) && object.upper.visible.clearAlpha === Number(!hybrid),
    { draws: terrainDraw, clearAlpha: object.upper.visible.clearAlpha })];
  if (!hybrid) return checks;

  const lower = object.lower;
  const [visible, hidden, unobstructed] = await Promise.all([
    readMask(dir, lower?.visible, size), readMask(dir, lower?.hidden, size),
    readMask(dir, object.upper.terrainHidden, size),
  ]);
  checks.push(check("UPPER_TERRAIN_OCCLUDES_CUBE", object.upper.visible.count > 0 &&
    unobstructed.count > object.upper.visible.count && object.upper.terrainHidden.terrainDraw.length === 0,
  { visibleCubePixels: object.upper.visible.count, cubePixelsWithoutUpperTerrain: unobstructed.count }));
  checks.push(check("LOWER_WEBGPU_TERRAIN_COLOR", visible.count > 0 && hidden.count > 0 &&
    visible.bytes.equals(hidden.bytes) && lower.changedPixels === 0 && lower.magentaPixels === 0 &&
    lower.visible.colorPixels > 0 && lower.hidden.colorPixels > 0 &&
    lower.visible.material?.enabled === true && lower.visible.imagery?.enabled === true,
  { visible: visible.count, hidden: hidden.count, changedPixels: lower.changedPixels, magentaPixels: lower.magentaPixels,
    colorPixels: lower.visible.colorPixels, material: lower.visible.material, imagery: lower.visible.imagery }));
  return checks;
}

function compareLandmarks(a, b) {
  requireEvidence(Array.isArray(a) && Array.isArray(b) && a.length === 5 && b.length === 5,
    "LANDMARKS_MISSING", "Expected the four terrain corners and the peak");
  const corners = [0, 95, 96 * 95, 96 * 96 - 1];
  const points = a.map((point, i) => {
    const other = b[i];
    requireEvidence(tuple(point.pixel, 2) && tuple(other?.pixel, 2) && point.index === other.index &&
      (i < 4 ? point.index === corners[i] : Number.isInteger(point.index) && point.index >= 0 && point.index < 96 * 96),
    "LANDMARK_MISMATCH", `Expected the same sample at landmark ${i}`);
    return { name: point.name, index: point.index, field: point.pixel, candidate: other.pixel,
      error: Math.hypot(point.pixel[0] - other.pixel[0], point.pixel[1] - other.pixel[1]) };
  });
  return { points, maxError: Math.max(...points.map(point => point.error)) };
}

async function compareTerrain(fieldDir, candidateDir, field, candidate, size) {
  return Promise.all(poseNames.map(async name => {
    const a = field.terrain?.poses?.[name];
    const b = candidate.terrain?.poses?.[name];
    requireEvidence(sameCamera(a?.pose, b?.pose), "POSE_MISMATCH", name);
    const [fieldMask, candidateMask] = await Promise.all([
      readMask(fieldDir, a, size), readMask(candidateDir, b, size),
    ]);
    let intersection = 0;
    for (let i = 0; i < fieldMask.bytes.length; i++) intersection += fieldMask.bytes[i] & candidateMask.bytes[i];
    const union = fieldMask.count + candidateMask.count - intersection;
    const nonempty = fieldMask.count > 0 && candidateMask.count > 0;
    const raster = { fieldPixels: fieldMask.count, candidatePixels: candidateMask.count,
      intersection, union, iou: nonempty ? intersection / union : null };
    const projection = compareLandmarks(a.landmarks, b.landmarks);
    const web = candidate.role === "candidate";
    const renderer = { field: a.renderer, candidate: b.renderer, cameraSubmissions: b.cameraSubmissions };
    const [fieldDisplay, candidateDisplay] = await Promise.all([
      measurePoseDisplay(fieldDir, field, name, size, fieldMask.bytes),
      measurePoseDisplay(candidateDir, candidate, name, size, candidateMask.bytes),
    ]);
    const appearance = checkTerrainAppearance(fieldDisplay.imagery, candidateDisplay.imagery, size);
    const display = { field: fieldDisplay.checks, candidate: candidateDisplay.checks, ...appearance };
    return { name, raster, projection, renderer, display, checks: [
      check(nonempty ? "TERRAIN_SILHOUETTE_IOU" : "TERRAIN_MASK_EMPTY", nonempty && raster.iou >= 0.995, raster),
      check("TERRAIN_CPU_PROJECTED_LANDMARKS", projection.maxError <= 1, { maxError: projection.maxError }),
      check("TERRAIN_RENDER_PATHS", a.renderer === "three.js / WebGL2" &&
        (web ? b.renderer === "forge3d-web / WebGPU" && b.cameraSubmissions === 3 : b.renderer === a.renderer), renderer),
      ...display.field, ...display.candidate, appearance.imagery, appearance.color,
    ] };
  }));
}

export async function compareCaptures(fieldDir, candidateDir) {
  const [field, candidate] = await Promise.all([loadCapture(fieldDir), loadCapture(candidateDir)]);
  requireEvidence(field.role === "field" && ["candidate", "forced-three"].includes(candidate.role),
    "CAPTURE_ROLE_MISMATCH", "Expected Field followed by Auto candidate or forced-three control");
  requireEvidence(field.status === "captured" && candidate.status === "captured", "CAPTURE_INCOMPLETE", "Both runs must capture a viewport");
  requireEvidence(field.revision === FIELD_REVISION && candidate.revision === CANDIDATE_REVISION && isPinnedProvenance(candidate.provenance),
    "CAPTURE_REVISION_MISMATCH", "Expected Field PR #1, its PR #2 child and the pinned forge3d-web archive");
  requireEvidence(typeof field.runId === "string" && typeof candidate.runId === "string" && field.runId !== candidate.runId,
    "INDEPENDENT_RUN_REQUIRED", "Use separate Studio launches for Field and candidate");
  requireEvidence(typeof field.target?.id === "string" && typeof candidate.target?.id === "string" && field.target.id !== candidate.target.id,
    "INDEPENDENT_RUN_REQUIRED", "CDP target IDs must differ between runs");
  verifyFixtureIdentity(field.fixture);
  requireEvidence(equal(field.fixture, candidate.fixture), "FIXTURE_MISMATCH", "Project or copied asset digest differs");
  verifyLoadedFixture(field);
  verifyLoadedFixture(candidate);
  const size = physicalDimensions(field.viewport);
  requireEvidence(equal(size, physicalDimensions(candidate.viewport)), "PHYSICAL_DIMENSIONS_MISMATCH", "Drawing buffer sizes differ");
  requireEvidence(field.viewport.dpr === candidate.viewport.dpr && field.viewport.drawingDpr === candidate.viewport.drawingDpr &&
    ["width", "height"].every(key =>
    Math.abs(field.viewport.css[key] - candidate.viewport.css[key]) <= 0.01), "PIXEL_MAPPING_MISMATCH", "CSS viewport size or DPR differs");
  requireEvidence(sameCamera(field.stock?.pose, candidate.stock?.pose), "POSE_MISMATCH", "stock");
  requireEvidence(isPinnedRuntimeInventory(candidate.sourceEvidence?.runtime),
    "SERVED_RUNTIME_EVIDENCE_MISMATCH", "Expected the complete pinned runtime file inventory");

  const [poses, fieldObject, candidateObject] = await Promise.all([
    compareTerrain(fieldDir, candidateDir, field, candidate, size),
    checkObject(fieldDir, field, size), checkObject(candidateDir, candidate, size),
  ]);
  const [fieldPasses, candidatePasses, fieldDisplay, candidateDisplay] = await Promise.all([
    checkPasses(fieldDir, field, size), checkPasses(candidateDir, candidate, size),
    checkDisplay(fieldDir, field, size), checkDisplay(candidateDir, candidate, size),
  ]);
  const resize = candidate.role === "candidate" ? check("WEBGPU_FIXED_SIZE_RESIZES", candidate.terrain.resizes === 0 &&
    equal(candidate.terrain.resizeCalls, []),
    { count: candidate.terrain.resizes, calls: candidate.terrain.resizeCalls }) :
    { code: "WEBGPU_FIXED_SIZE_RESIZES", status: "unexercised" };
  const object = { field: fieldObject, candidate: candidateObject, historicalFieldCube,
    parity: cubeParity(fieldDisplay.cube, candidateDisplay.cube) };
  const renderer = { field: fieldPasses, candidate: candidatePasses };
  const appearance = checkTerrainAppearance(fieldDisplay.imagery, candidateDisplay.imagery, size);
  const display = { field: fieldDisplay.checks, candidate: candidateDisplay.checks, ...appearance };
  const checks = [resize, ...poses.flatMap(pose => pose.checks), ...fieldObject.checks, ...candidateObject.checks,
    object.parity, ...fieldPasses, ...candidatePasses, ...display.field, ...display.candidate, appearance.imagery, appearance.color];
  return { pass: !checks.some(result => result.status === "unexpected-failure"),
    roles: { field: field.role, candidate: candidate.role }, fixture: field.fixture, viewport: { ...size, dpr: field.viewport.dpr },
    object, renderer, display, poses, resize };
}

export async function checkBlockedCapture(dir) {
  const manifest = await loadCapture(dir);
  const startup = manifest.startup ?? {};
  const requests = startup.contexts ?? [];
  const aliases = ["webgl", "webgl2", "experimental-webgl"];
  const webgl = new Set(aliases);
  const denied = requests.filter(request => request.denied === true && webgl.has(request.requested));
  const realmRequests = startup.realmObservation?.requests ?? [];
  const denialsMatch = [...requests, ...realmRequests].every(request =>
    webgl.has(request.requested) === request.denied && (!request.denied || request.result === null));
  const realmVerified = realm => aliases.every(name => realmRequests.some(request => request.realm === realm &&
    request.requested === name && request.denied && request.result === null));
  const viewportDenied = denied.filter(request => request.canvas === "viewport-canvas");
  verifyFixtureIdentity(manifest.fixture);
  const observationComplete = completedBlockedObservation(startup.observation, requests);
  const presentationProbeComplete = completedPresentationProbe(startup);
  let presentationContribution;
  let errorPaint;
  let displayError;
  if (manifest.stock && manifest.composition?.withoutPresentation) {
    try {
      const [stock, withoutPresentation] = await Promise.all([manifest.stock, manifest.composition.withoutPresentation]
        .map(frame => readFrame(dir, frame, manifest.viewport)));
      presentationContribution = measureCanvasContribution(stock, withoutPresentation);
      if (manifest.composition.withoutErrorText) {
        const withoutErrorText = await readFrame(dir, manifest.composition.withoutErrorText, manifest.viewport);
        errorPaint = measureErrorPaint(stock, withoutErrorText, manifest.viewport, startup.failureScreen?.problemBounds);
      }
    } catch (error) {
      displayError = error.message;
    }
  }
  const failureScreenConfirmed = confirmedBlockedScreen(startup, errorPaint) && equal(errorPaint, startup.errorPaint);
  const { canaries } = startup;
  const pass = manifest.role === "webgl-blocked" && manifest.revision === CANDIDATE_REVISION &&
    isPinnedProvenance(manifest.provenance) && manifest.status === "failed" && manifest.reason === "WEBGL_BLOCKED_NO_VIEWPORT" &&
    isPinnedRuntimeInventory(manifest.sourceEvidence?.runtime) &&
    startup.tauri === true && startup.loadedProjectId === manifest.fixture.projectId &&
    startup.blocked === true && observationComplete && presentationProbeComplete && failureScreenConfirmed &&
    startup.liveViewport === false && startup.webgpuAvailable === true &&
    presentationContribution?.fraction < displayThresholds.liveViewport &&
    equal(presentationContribution, startup.presentationContribution) &&
    canaries?.webgpu === "GPUCanvasContext" && canaries?.twoD === "CanvasRenderingContext2D" &&
    canaries.iframe?.denied === true && canaries.iframe.webgpu === "GPUCanvasContext" &&
    canaries.iframe.twoD === "CanvasRenderingContext2D" && canaries.worker?.denied === true &&
    canaries.worker.webgpu === "GPUCanvasContext" && canaries.worker.twoD === "OffscreenCanvasRenderingContext2D" &&
    equal(startup.realmObservation?.errors, []) && realmVerified("iframe") && realmVerified("worker") &&
    startup.realmObservation.targets.some(target => target.type === "worker" && target.waitingForDebugger) &&
    denialsMatch && viewportDenied.some(request => request.result === null && /WebGLRenderer/.test(request.stack));
  let code = manifest.reason;
  if (code === "WEBGL_BLOCKED_NO_VIEWPORT") {
    if (!observationComplete) code = "BLOCKED_OBSERVATION_INCOMPLETE";
    else if (!presentationProbeComplete) code = "BLOCKED_PRESENTATION_PROBE_INCOMPLETE";
    else if (!failureScreenConfirmed) code = "BLOCKED_FAILURE_SCREEN_UNVERIFIED";
  }
  return { pass, status: pass ? "expected-failure" : "unexpected-failure", code, observationComplete, presentationProbeComplete,
    failureScreenConfirmed, denialCount: viewportDenied.length, presentationContribution, errorPaint, displayError, startup };
}

export async function runOfflineControls(fieldDir, candidateDir, outDir) {
  const [field, candidate] = await Promise.all([loadCapture(fieldDir), loadCapture(candidateDir)]);
  requireEvidence(candidate.role === "candidate", "CAPTURE_ROLE_MISMATCH", "Negative controls require the Auto candidate");
  const size = physicalDimensions(field.viewport);
  const writeDerived = async (source, name, make) => {
    const path = join(outDir, name);
    await mkdir(path);
    await cp(source, path, { recursive: true, force: false, errorOnExist: true });
    const manifest = await loadCapture(path);
    manifest.derived = { control: name, source: resolve(source) };
    await make(manifest, path);
    await writeFile(join(path, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    return path;
  };
  const zeroDefault = async (manifest, path) => {
    const mask = "control-empty-terrain.mask";
    await writeFile(join(path, mask), Buffer.alloc(size.width * size.height), { flag: "wx" });
    Object.assign(manifest.terrain.poses.default, { mask, count: 0 });
  };
  await mkdir(outDir, { recursive: true });
  const [emptyField, emptyCandidate, missingCandidate] = await Promise.all([
    writeDerived(fieldDir, "empty-field", zeroDefault), writeDerived(candidateDir, "empty-candidate", zeroDefault),
    writeDerived(candidateDir, "missing-cube", async manifest => {
      const { visible, hidden } = manifest.object.upper;
      Object.assign(visible, { mask: hidden.mask, count: hidden.count, cubeDraw: hidden.cubeDraw });
      manifest.object.click = null;
      manifest.object.selection = null;
    }),
  ]);
  const [empty, missing] = await Promise.all([compareCaptures(emptyField, emptyCandidate), compareCaptures(fieldDir, missingCandidate)]);
  const expecting = (report, code, pass) => ({ code, status: pass && !report.pass ? "expected-failure" : "unexpected-failure", report });
  const checks = [expecting(empty, "TERRAIN_MASK_EMPTY", empty.poses[0].raster.fieldPixels === 0 &&
    empty.poses[0].raster.candidatePixels === 0 && empty.poses[0].checks[0].code === "TERRAIN_MASK_EMPTY"),
  expecting(missing, "VISIBLE_CUBE_MASK_EMPTY", missing.object.candidate.checks[0].status === "unexpected-failure" &&
    missing.poses.every(pose => pose.checks.every(result => result.status === "pass")))];
  const result = { pass: checks.every(result => result.status === "expected-failure"), checks };
  await writeFile(join(outDir, "negative-controls.json"), `${JSON.stringify(result, null, 2)}\n`, { flag: "wx" });
  return result;
}
