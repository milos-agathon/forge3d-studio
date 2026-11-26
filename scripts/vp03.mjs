import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { decodePng } from "../node_modules/@forge3d/web/dist/png-decode.js";
import { checkBlockedCapture } from "./vp01/compare.mjs";
import { createFixture } from "./vp01/fixture.mjs";
import { observeBlockedRealms, observeContexts, observeStartup } from "./vp01/startup.mjs";
import { installProbe } from "./vp03/page.mjs";
import { checkBlockedCanaries, gateStudio, launchStudio, loopbackUrl } from "./vp03/desktop.mjs";
import { compileReference, nativeSourceHash, observeExecution, sha256 as hash, verifyExecution } from "./vp03/identity.mjs";
import { measureSolidDisplay, requireCurrentQuery, requireNativeCamera, requireSolidDisplay, requireSubmittedCamera } from "./vp03/frames.mjs";
import { cogFixture, serveCog, terrainControls } from "./vp03/cog.mjs";

const { values: args } = parseArgs({ options: {
  shell: { type: "string" }, "shell-sha256": { type: "string" }, endpoint: { type: "string" }, out: { type: "string" }, historical: { type: "string" },
  origin: { type: "string", default: "http://localhost:1426" },
  upstream: { type: "string", default: "http://localhost:1427" },
  "cdp-port": { type: "string" }, "fractional-fixture": { type: "string" },
  "cog-fixture": { type: "string" },
  "public-cog": { type: "boolean" },
}});
if (!args.out) {
  console.error("Usage: node scripts/vp03.mjs --out NEW_DIR [--endpoint LOOPBACK_URL] [--shell STUDIO_EXE] [--shell-sha256 SHA256] [--historical VP01_CAPTURE] [--cog-fixture COG_TIFF] [--public-cog]");
  process.exit(2);
}
const root = fileURLToPath(new URL("../", import.meta.url));
const out = resolve(args.out);
const origin = loopbackUrl(args.origin);
const upstream = loopbackUrl(args.upstream);
const endpoint = loopbackUrl(args.endpoint ?? `http://127.0.0.1:${args["cdp-port"] ?? 9456}`);
assert.ok((Number(endpoint.port) > 0 || args["cdp-port"] === "0") && origin.port !== endpoint.port && upstream.port !== endpoint.port && origin.origin !== upstream.origin);
if (args.endpoint && args["cdp-port"]) assert.equal(endpoint.port, args["cdp-port"], "CDP endpoint and port disagree");
const shell = resolve(args.shell ?? process.env.FORGE3D_STUDIO_SHELL ??
  join(process.env.CARGO_TARGET_DIR ?? join(root, "target"), "debug", "forge3d-studio-shell.exe"));
// Independent reference from the pinned TIFF: 96 x 96 block means clipped
// to its 0.01 / 99.99 percentiles, rounded to centimetres, then Float32.
const bryceReference = {
  fileSha256: "5d6f34b93f2c8a2d18ee077629b2b940e3a0ac610625854abb25f51fe37767db",
  heightSha256: "45fcada88ff9293b0b0580f2045e4ab6a6a64cf4914c9954eafbba53780a76f7",
  center: 2275.6649780273438, offCenter: 2229.0983072916665,
};
const ground = [0, 0];
const offCenter = [2, 0];
const report = { base: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
  groundStudioXz: ground, offCenterStudioXz: offCenter, steps: [], checks: {}, unexercised: ["Authenticated COG endpoints"] };
if (!args["public-cog"]) report.unexercised.push("Public HTTPS COG");
const json = async path => JSON.parse(await readFile(path, "utf8"));
const e = JSON.stringify;
const ready = "Viewport forge3d-web · WebGPU available";
const raf = "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))";

async function until(cdp, expression, label, timeout = 25_000) {
  const deadline = Date.now() + timeout;
  let error;
  while (Date.now() < deadline) {
    try {
      const value = await cdp.evaluate(expression);
      if (value) return value;
    } catch (caught) {
      error = caught;
    }
    await delay(75);
  }
  const last = await cdp.evaluate("window.__vp03?.snapshot?.()").catch(() => null);
  throw Error(`${label} timed out. Last viewport ${e(last)}`, { cause: error });
}

async function click(cdp, selector, text = "") {
  const point = await until(cdp, `(() => {
    const item = [...document.querySelectorAll(${e(selector)})].find(el => !el.disabled &&
      el.textContent.trim().startsWith(${e(text)}) && el.getBoundingClientRect().width > 0);
    if (!item) return null;
    item.scrollIntoView({block:"nearest"});
    const {x,y,width,height} = item.getBoundingClientRect();
    return [x+width/2,y+height/2];
  })()`, selector + " " + text);
  await cdp.click(point);
}

async function fixtureSet() {
  const dir = join(out, "fixtures");
  await mkdir(dir);
  const bryce = await json(join(root, "samples", "bryce-terrain.studio3d"));
  const terrain = bryce.scene.objects.find(object => object.kind.type === "terrain");
  const asset = bryce.assets.find(asset => asset.id === terrain.kind.asset);
  const dem = resolve(root, "samples", asset.path);
  const fixtures = { dem, demSha256: hash(await readFile(dem)), sourceDimensions: terrain.kind.dimensions,
    sample: "samples/bryce-terrain.studio3d", empty: {} };
  for (const name of ["five-states", "late-hide", "late-project-a", "late-project-b", "limit"]) {
    const id = randomUUID();
    const project = { ...bryce, id, name: `VP-03 ${name}`, assets: [], selection: [], cartography: [],
      scene: { ...bryce.scene, objects: [], activeCamera: null },
      viewport: { ...bryce.viewport, mode: "solid", gridVisible: false, hillshade: false },
      render: { ...bryce.render, environment: null, shadows: false, sunVisibility: false },
      timeline: { ...bryce.timeline, tracks: [] } };
    const bytes = e(project, null, 2) + "\n";
    const path = join(dir, `${name}.studio3d`);
    await writeFile(path, bytes);
    fixtures.empty[name] = { id, path, sha256: hash(bytes) };
  }
  fixtures.hybrid = await createFixture(join(dir, "hybrid"));
  // The native camera check uses the same Bryce DEM with a small output and
  // no imagery bake. The unmodified VP-01 fixture tests hybrid composition.
  terrain.kind.overlay = null;
  const native = { ...bryce, id: randomUUID(), name: "VP-03 native Bryce", assets: [{ ...asset, path: dem }], cartography: [],
    viewport: { ...bryce.viewport, gridVisible: false, hillshade: false },
    render: { ...bryce.render, width: 480, height: 360, environment: null, shadows: false, sunVisibility: false } };
  const nativePath = join(dir, "native-bryce.studio3d");
  const nativeBytes = e(native, null, 2) + "\n";
  await writeFile(nativePath, nativeBytes);
  fixtures.native = { id: native.id, path: nativePath, sha256: hash(nativeBytes) };
  fixtures.relief = {};
  for (const zScale of [0.5, 3]) {
    const project = structuredClone(native);
    project.id = randomUUID();
    project.name = `VP-03 relief ${zScale}`;
    project.scene.objects.find(object => object.kind.type === "terrain").kind.zScale = zScale;
    const path = join(dir, `relief-${zScale}.studio3d`);
    const bytes = e(project, null, 2) + "\n";
    await writeFile(path, bytes);
    fixtures.relief[zScale] = { id: project.id, path, sha256: hash(bytes) };
  }
  const failure = { ...native, id: randomUUID(), name: "VP-03 preview failures",
    scene: { ...native.scene, objects: [terrain], activeCamera: null } };
  const failurePath = join(dir, "preview-failures.studio3d");
  await writeFile(failurePath, e(failure, null, 2) + "\n");
  fixtures.failure = { id: failure.id, path: failurePath };
  fixtures.cog = await cogFixture(dem, dir, args["cog-fixture"]);
  fixtures.controls = await terrainControls(dem, dir);
  return fixtures;
}

const expectedNativeSource = await nativeSourceHash(root);

async function onDesktop(role, run, { lane = role, upstreamOrigin = upstream } = {}) {
  try {
    await desktopAttempt(role, run, lane, upstreamOrigin, lane);
  } catch (error) {
    if (error.code !== "VP03_STARTUP_STALL") throw error;
    // Only a fresh document that stalled before the first check is eligible.
    // Keep its profile and diagnosis. A second failure ends the whole gate.
    (report.startupRetries ??= []).push({ lane, cause: error.message });
    console.warn(`Restarting the unopened ${lane} WebView after a startup stall`);
    await desktopAttempt(role, run, lane, upstreamOrigin, lane + "-restart");
  }
}

async function desktopAttempt(role, run, lane, upstreamOrigin, profile) {
  const blocked = role === "webgl-blocked";
  const gate = await gateStudio(origin, upstreamOrigin);
  let desktop;
  try {
    desktop = await launchStudio({ shell, origin, endpoint, dir: join(out, profile), root, blocked });
    const { cdp } = desktop;
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    await cdp.send("Page.bringToFront");
    const measured = await observeExecution(cdp, origin);
    let realms;
    if (blocked) {
      // Pause dedicated workers, including blobs, for the VP-01 observer.
      // The gated canary scripts install the observer in other child realms.
      const dedicated = {
        on: cdp.on.bind(cdp), evaluate: cdp.evaluate.bind(cdp),
        send: (method, params, session) => cdp.send(method, method === "Target.setAutoAttach"
          ? { ...params, filter: [{ type: "worker" }, { exclude: true }] } : params, session),
      };
      realms = await observeBlockedRealms(dedicated);
    }
    const before = await until(cdp, `(() => {
      const root = document.querySelector("#root");
      if (!root || !window.__TAURI_INTERNALS__?.invoke) return null;
      return { timeOrigin: performance.timeOrigin, projectRoot: root.childElementCount,
        resources: performance.getEntriesByType("resource").map(entry => new URL(entry.name).pathname) };
    })()`, "Gated first document");
    assert.equal(before.projectRoot, 0);
    assert.ok(before.resources.every(path => !path.startsWith("/src/") && !path.startsWith("/forge3d-web/")),
      "Studio resources loaded before the startup guard");
    cdp.on("Page.javascriptDialogOpening", ({ type, message }) => {
      if (type === "confirm" && /^"VP-(01|03) /.test(message)) {
        void cdp.send("Page.handleJavaScriptDialog", { accept: true });
      }
    });
    const info = await cdp.evaluate('__TAURI_INTERNALS__.invoke("shell_info")');
    assert.equal(info.nativeSourceSha256, expectedNativeSource,
      "Native shell source differs from this checkout. Rebuild the Studio shell before running VP-03.");
    const runId = randomUUID();
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
      source: `(${installProbe})(${e({ role, runId, ground, offCenter })}, ${observeStartup}, ${observeContexts})`,
      runImmediately: true,
    });
    const armed = await cdp.evaluate(`__vp03?.runId === ${e(runId)} && performance.timeOrigin`);
    assert.equal(armed, before.timeOrigin);
    // Install the observers on the real runtime before Studio can import it.
    // Releasing both module graphs together made first-document startup race.
    gate.startRuntime();
    const loadErrors = [];
    cdp.on("Runtime.exceptionThrown", ({ exceptionDetails }) =>
      loadErrors.push(exceptionDetails.exception?.description ?? exceptionDetails.text));
    cdp.on("Network.loadingFailed", failure => {
      if (!failure.canceled) loadErrors.push(`${failure.type}: ${failure.errorText}`);
    });
    try {
      const probe = await until(cdp, "window.__vp03?.instrumentationError || window.__vp03?.instrumented", "Runtime observation", 75_000);
      assert.equal(probe, true, "Runtime instrumentation failed: " + probe);
      gate.start();
      await until(cdp, '!!document.querySelector(".menu__button")', "First Studio startup", 75_000);
    } catch (error) {
      const startup = await cdp.evaluate(`({document:document.readyState, title:document.title, text:document.body.innerText.slice(0,1000),
        armed:window.__vp03?.runId, instrumented:window.__vp03?.instrumented, error:window.__vp03?.instrumentationError,
        resources:performance.getEntriesByType("resource").slice(-12).map(e=>[new URL(e.name).pathname,e.responseStatus])})`);
      const diagnosis = Error(`First Studio startup in ${profile}: ${e({ ...startup, loadErrors })}`, { cause: error });
      if (startup.armed === runId && startup.document !== "complete" && !startup.error && !loadErrors.length) {
        diagnosis.code = "VP03_STARTUP_STALL";
      }
      throw diagnosis;
    }
    // Recovery is refreshed asynchronously at startup and after opening files.
    // Its banner wraps filenames and can change the framebuffer between controls.
    await cdp.evaluate(`(() => {
      const dismiss = () => {
        const button = document.querySelector('.recovery button[aria-label="Dismiss"]');
        if (button) { observer.disconnect(); button.click(); }
      };
      const observer = new MutationObserver(dismiss);
      observer.observe(document.querySelector("#root"), { childList: true, subtree: true });
      dismiss();
    })()`);
    try {
      await run(cdp, { measured, realms, crossFrame: gate.crossFrame, before,
        held: [...gate.held], flags: desktop.flags, pid: desktop.pid, timeOrigin: armed, nativeSourceSha256: info.nativeSourceSha256 });
      assert.equal(await cdp.evaluate("performance.timeOrigin"), armed, "The first Studio document must remain mounted during the probe");
    } catch (error) {
      report.lastViewport = await cdp.evaluate("window.__vp03?.snapshot?.()").catch(() => null);
      report.lastIpc = await cdp.evaluate("window.__vp03?.ipc?.slice(-15)").catch(() => null);
      if (report.lastViewport?.backend?.includes("Viewport native")) {
        report.nativeStatus = await cdp.evaluate('__TAURI_INTERNALS__.invoke("render_status")').catch(() => null);
      }
      const screen = await cdp.screenshot().catch(() => null);
      if (screen) await writeFile(join(out, `${role}-failure.png`), screen);
      throw error;
    }
  } finally {
    await desktop?.close();
    await gate.close();
  }
}

const projectState = cdp => cdp.evaluate('__TAURI_INTERNALS__.invoke("project_state")');
const queuePicker = (cdp, action, path) => cdp.evaluate(`__vp03.picker = ${e({ action, path })}`);
const snapshot = cdp => cdp.evaluate("__vp03.snapshot()");
const withSnapshot = expression => `(() => {const s = window.__vp03?.snapshot(); return s && (${expression}) && s})()`;
const settle = (cdp, expression, label, timeout) => until(cdp, withSnapshot(expression), label, timeout);
// Older bare-terrain files gain a base relief layer during Studio's v4→v5
// migration. Determine that expectation from the file being opened.
const legacyReliefProjects = new WeakMap();
async function openAction(cdp, fixture) {
  const source = await json(fixture.path);
  legacyReliefProjects.set(cdp, source.schemaVersion < 5 && source.cartography === undefined ? source.id : null);
  await queuePicker(cdp, "open", fixture.path);
  await click(cdp, ".menu__button", "File");
  await click(cdp, '[role="menuitem"]', "Open…");
}
async function open(cdp, fixture) {
  await openAction(cdp, fixture);
  return settle(cdp, `s.projectId === ${e(fixture.id)} && s.submission?.projectId === ${e(fixture.id)}`, "Open " + fixture.path);
}
async function importDem(cdp, file) {
  const start = await cdp.evaluate("__vp03.ipc.length");
  await queuePicker(cdp, "open", file);
  await click(cdp, ".viewport-toolbar [aria-haspopup=menu]", "Add");
  await click(cdp, '[role="menuitem"]', "DEM terrain (GeoTIFF)…");
  const importCall = await until(cdp, `__vp03.ipc.slice(${start}).find(call => call.command === "import_terrain_dem" && call.completed)`,
    "Native DEM import " + file, 90_000);
  assert.ok(importCall.ok, `Studio rejected the DEM import for ${file}`);
}
const terrainRow = '[role="treeitem"]:has(.tree-icon--terrain)';
const hideTerrain = cdp => click(cdp, terrainRow + ' [aria-label="Hide object"]');
const showTerrain = cdp => click(cdp, terrainRow + ' [aria-label="Show object"]');
async function deleteTerrain(cdp) {
  await click(cdp, terrainRow + " .tree-name");
  await click(cdp, '.viewport-toolbar [title="Delete (X or Del)"]');
}
async function closeAction(cdp) {
  await click(cdp, ".menu__button", "File");
  await click(cdp, '[role="menuitem"]', "Close project");
}
async function closeProject(cdp) {
  await closeAction(cdp);
  return settle(cdp, "!window.forge3dViewportDiagnostics && s.liveRuntimes.length === 0", "Unmount");
}

async function capture(cdp, name, condition, expectTerrain, prior = 0, { status = ready, editor = false, strictSettings = true, bryceFile, compositorOnly = false } = {}) {
  const current = withSnapshot(`(${condition}) && s.backend === ${e(status)} &&
    s.submission?.sequence > ${prior} && Boolean(s.submission?.terrain) === ${expectTerrain}`);
  const state = await until(cdp, `(async () => {
    const first = ${current};
    if (!first) return null;
    await ${raf};
    const last = ${current};
    return last && first.submission.sequence === last.submission.sequence && first.runtime === last.runtime && last;
  })()`, name);
  assert.ok(state.canvasVisible && state.successfulFrame?.submitted);
  assert.deepEqual(state.liveRuntimes, [state.runtime]);
  assert.ok(Number.isInteger(state.context), "The active runtime must own a real canvas context");
  assert.deepEqual(state.liveContexts, [state.context]);
  assert.equal(state.editor, editor);
  if (editor) assert.ok(state.successfulWebGL > 0);
  else assert.equal(state.successfulWebGL, 0);
  assert.equal(!!state.query, expectTerrain);
  if (expectTerrain) {
    requireSubmittedCamera(state.runtimeCamera, state.expectedCamera);
    requireCurrentQuery(state.query, state.gridQuery);
    if (state.offCenter.gridQuery) requireCurrentQuery(state.offCenter.hit, state.offCenter.gridQuery, "Off-center active query");
    else assert.equal(state.offCenter.hit, null);
    assert.ok(Number.isInteger(state.successfulFrame.dataset), "The submitted frame must have a query dataset");
    assert.equal(state.queryOwner?.id, state.successfulFrame.dataset, "The active query used a different dataset");
    if (state.offCenter.hit) assert.deepEqual(state.queryOwner, state.offCenter.owner);
    assert.deepEqual(state.queryOwner.request, state.submission.terrain);
    assert.equal(state.queryOwner.runtime, state.runtime);
    const { resolution } = state.accepted;
    state.uploadEvidence = await cdp.evaluate("__vp03.uploadEvidence()");
    assert.deepEqual([state.uploadEvidence.upload.width, state.uploadEvidence.upload.height], [resolution, resolution]);
    assert.equal(state.uploadEvidence.frame, state.successfulFrame.at);
    assert.equal(state.uploadEvidence.submission, state.submission.sequence);
    assert.deepEqual(state.submission.terrain, state.accepted);
    assert.equal(state.object.revision, state.submission.terrain.terrainRevision);
    assert.equal(state.object.id, state.submission.terrain.objectId);
  } else {
    assert.equal(state.offCenter.hit, null);
  }
  const { width, height } = state.dimensions;
  assert.deepEqual(state.runtimeDimensions, [width, height]);
  assert.deepEqual([state.submission.width, state.submission.height], [width, height]);
  const native = await projectState(cdp);
  assert.equal(state.projectId, native.project.id);
  if (strictSettings) checkToggles(native.project, legacyReliefProjects.get(cdp) === native.project.id);
  assert.equal(await cdp.evaluate('localStorage.getItem("studio.viewport.renderer")'), "auto");
  // Enclose the viewport in an integer CSS clip. The compositor comparison
  // accounts for the CDP crop origin at the current display scale.
  const { x, y, width: cssWidth, height: cssHeight } = state.css;
  const clip = { x: Math.floor(x), y: Math.floor(y),
    width: Math.ceil(x + cssWidth) - Math.floor(x), height: Math.ceil(y + cssHeight) - Math.floor(y) };
  const image = await cdp.screenshot(clip);
  const files = { png: name + ".png" };
  await writeFile(join(out, files.png), image);
  let mask, rgba, maskCount = null;
  // At 794 × 727 the pinned runtime's 4.7 MB frame staging allocation
  // exceeds the entire injected terrain budget. The five-state test always
  // uses readRgba. Budget runs retain a compositor crop and physical GPU heights.
  if (!compositorOnly) {
    const readback = await cdp.evaluate(`__vp03.mask(${expectTerrain})`);
    maskCount = readback.count;
    mask = Buffer.from(readback.mask, "base64");
    rgba = readback.rgba && Buffer.from(readback.rgba, "base64");
    assert.equal(mask.length, width * height);
    if (expectTerrain) assert.equal(rgba?.length, width * height * 4);
    assert.equal(maskCount > 0, expectTerrain);
    files.mask = name + ".mask";
    await writeFile(join(out, files.mask), mask);
    if (rgba) {
      files.rgba = name + ".rgba";
      await writeFile(join(out, files.rgba), rgba);
    }
  }
  const png = decodePng(image);
  const display = measureSolidDisplay(png, mask, state.dimensions, state.chrome, rgba,
    { clip, viewport: state.css, displayDpr: state.displayDpr });
  if (compositorOnly && expectTerrain) {
    assert.ok(display.inspected > png.width * png.height * 0.65);
    assert.ok(display.changed > display.inspected * 0.20, "Budgeted Bryce terrain is missing from the compositor");
  } else {
    requireSolidDisplay(display, expectTerrain, png.width * png.height);
  }
  assert.deepEqual((await snapshot(cdp)).submission, state.submission, "A settled submission must survive capture");
  if (expectTerrain) {
    const { upload, acceptedSha256, acceptedGeometry, gpu, queries } = state.uploadEvidence;
    assert.equal(upload.heightSha256, acceptedSha256, "WASM upload heights differ from the accepted grid");
    const { width, height, spacing, exaggeration, domain } = upload;
    assert.deepEqual({ width, height, spacing, exaggeration, domain }, acceptedGeometry, "WASM upload geometry differs from the accepted grid");
    assert.deepEqual(gpu.dimensions, [width, height], "Committed GPU grid differs from the accepted dimensions");
    assert.equal(gpu.count, width * height);
    assert.equal(gpu.sha256, acceptedSha256, "GPU height readback differs from the accepted grid");
    assert.deepEqual(queries.map(query => query.point), state.offCenter.hit ? [ground, offCenter] : [ground]);
    for (const query of queries) {
      assert.deepEqual(query.owner, state.queryOwner);
      assert.equal(query.heightSha256, acceptedSha256, "Active query dataset heights differ from the accepted grid");
      assert.deepEqual(query.geometry, acceptedGeometry, "Active query dataset geometry differs from the accepted grid");
    }
  }
  if (bryceFile) {
    const object = native.project.scene.objects.find(item => item.id === state.submission.terrain.objectId);
    const asset = native.project.assets.find(item => item.id === object?.kind.asset);
    assert.ok(asset, "Missing submitted Bryce source asset");
    assert.equal(await realpath(asset.path), await realpath(bryceFile));
    assert.equal(hash(await readFile(asset.path)), bryceReference.fileSha256, "Bryce source TIFF differs");
    assert.equal(state.accepted.resolution, 96);
    assert.equal(state.uploadEvidence.acceptedSha256, bryceReference.heightSha256, "Preview heights differ from the source TIFF");
    assert.ok(Math.abs(state.query.elevation - bryceReference.center) < 1e-6);
    assert.ok(Math.abs(state.offCenter.hit.elevation - bryceReference.offCenter) < 1e-6);
    state.sourceReference = bryceReference;
  }
  return { name, revision: native.revision, ...state, maskCount, display, clip, files };
}

async function withFrozenViewport(cdp, file, run) {
  const picture = (await readFile(join(out, file))).toString("base64");
  await cdp.evaluate(`(async () => {
    const image = new Image();
    image.id = "vp03-stale-image";
    image.src = ${e("data:image/png;base64," + picture)};
    image.style.cssText = "position:absolute;inset:0;width:100%;height:100%;z-index:100;pointer-events:none";
    await image.decode();
    document.querySelector(".viewport").append(image);
  })()`);
  try {
    await cdp.evaluate(raf);
    return await run();
  } finally {
    await cdp.evaluate('document.querySelector("#vp03-stale-image").remove()');
  }
}

async function withQueryOverride(cdp, replacement, run) {
  await cdp.evaluate(`(() => {
    const adapter = forge3dViewportDiagnostics().terrainViewport;
    __vp03.restoreQuery = adapter.queryTerrain;
    adapter.queryTerrain = ${replacement};
  })()`);
  try {
    return await run();
  } finally {
    await cdp.evaluate("forge3dViewportDiagnostics().terrainViewport.queryTerrain = __vp03.restoreQuery");
  }
}

function withStaleQuery(cdp, hit, run) {
  return withQueryOverride(cdp, `() => (${e(hit)})`, run);
}

function checkToggles(project, migratedRelief = false) {
  const visible = project.cartography?.filter(layer => layer.visible) ?? [];
  assert.deepEqual(visible.map(layer => layer.type), migratedRelief ? ["relief"] : [],
    "Visible cartography layers differ from the expected fixture settings");
  const settings = { mode: project.viewport.mode, grid: project.viewport.gridVisible, hillshade: project.viewport.hillshade,
    sunShadows: project.render.shadows, terrainSunShadows: project.render.sunVisibility, hdri: project.render.environment,
    imagery: !!project.cartography?.some(layer => layer.type === "imagery" && layer.visible),
    cartography: visible.length };
  assert.deepEqual(settings, { mode: "solid", grid: false, hillshade: false, sunShadows: false, terrainSunShadows: false,
    hdri: null, imagery: false, cartography: migratedRelief ? 1 : 0 });
  return { renderer: "auto", mapGrid: false, ...settings };
}

async function captureFiveStates(cdp, fixtures, steps, prefix, terrainOptions) {
  const first = await capture(cdp, prefix + "01-open-empty", `s.projectId === ${e(fixtures.empty["five-states"].id)} && !s.object`, false);
  steps.push(first);
  await importDem(cdp, fixtures.dem);
  const imported = await capture(cdp, prefix + "02-import-dem", "s.object?.visible", true, first.submission.sequence, terrainOptions);
  steps.push(imported);
  await hideTerrain(cdp);
  const hidden = await capture(cdp, prefix + "03-hide-dem", "s.object?.visible === false", false, imported.submission.sequence);
  steps.push(hidden);
  await showTerrain(cdp);
  const shown = await capture(cdp, prefix + "04-show-dem", "s.object?.visible", true, hidden.submission.sequence, terrainOptions);
  steps.push(shown);
  await deleteTerrain(cdp);
  const deleted = await capture(cdp, prefix + "05-delete-dem", "!s.object", false, shown.submission.sequence);
  steps.push(deleted);
  for (const step of steps) {
    assert.deepEqual(step.camera, first.camera);
    assert.deepEqual(step.dimensions, first.dimensions);
    assert.equal(step.projectGeneration, first.projectGeneration);
  }
  assert.equal(first.runtime, imported.runtime);
  assert.notEqual(imported.runtime, hidden.runtime);
  assert.equal(hidden.runtime, shown.runtime);
  assert.notEqual(shown.runtime, deleted.runtime);
}

async function fiveStates(cdp, fixtures) {
  report.toggles = checkToggles((await projectState(cdp)).project);
  await captureFiveStates(cdp, fixtures, report.steps, "", { bryceFile: fixtures.dem });
  const imported = report.steps[1];
  await withFrozenViewport(cdp, imported.files.png, async () => {
    await assert.rejects(capture(cdp, "control-stale-image", "!s.object", false), /foreground pixels on an empty frame/);
    report.checks.staleSurfaceControl = { passed: true, rejected: "control-stale-image.png" };
  });
  const unmounted = await closeProject(cdp);
  assert.deepEqual(unmounted.liveContexts, []);
  report.checks.fiveStates = { passed: true, unmounted };
  console.log("Five blocked-WebGL states passed");
}

async function fractionalDisplay(cdp, fixtures) {
  await open(cdp, fixtures.empty["five-states"]);
  await importDem(cdp, fixtures.dem);
  const rows = [];
  try {
    for (const dpr of [1.25, 1.5, 2.5]) {
      await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1441, height: 895, deviceScaleFactor: dpr, mobile: false });
      rows.push(await capture(cdp, "fractional-display-" + dpr,
        `s.displayDpr === ${dpr} && s.dimensions.pixelRatio === ${Math.min(2, dpr)} && s.object?.visible`, true));
    }
  } finally {
    await cdp.send("Emulation.clearDeviceMetricsOverride");
  }
  await closeProject(cdp);
  report.checks.fractionalDisplay = { passed: true, rows };
}

async function wrongPreviewSource(cdp, fixtures) {
  await open(cdp, fixtures.empty["five-states"]);
  await cdp.evaluate(`(async () => {
    const preview = await __TAURI_INTERNALS__.invoke("terrain_preview", { path: ${e(fixtures.controls.raised.path)}, resolution: 96 });
    __vp03.replayPreview = { path: ${e(fixtures.dem)}, preview };
  })()`);
  await importDem(cdp, fixtures.dem);
  await assert.rejects(capture(cdp, "control-wrong-source", "s.object?.visible", true, 0, { bryceFile: fixtures.dem }),
    /Preview heights differ from the source TIFF/);
  const state = await snapshot(cdp);
  const call = await cdp.evaluate("__vp03.ipc.findLast(call => call.replayedSource)");
  assert.equal(call?.replayedSource.original, bryceReference.heightSha256);
  assert.notEqual(call.replayedSource.delivered, call.replayedSource.original);
  assert.ok(Math.abs(state.query.elevation - bryceReference.center - 512) < 1e-6);
  report.checks.wrongPreviewSource = { passed: true, call, query: state.query };
  await closeProject(cdp);
}

async function matchingTerrainControls(cdp, fixtures) {
  await open(cdp, fixtures.empty["five-states"]);
  await importDem(cdp, fixtures.controls.east.path);
  const east = await capture(cdp, "control-east", "s.object?.visible", true);
  await cdp.evaluate("__vp03.retainTerrain()");
  await open(cdp, fixtures.empty["late-project-a"]);
  await importDem(cdp, fixtures.controls.west.path);
  const west = await capture(cdp, "control-west", "s.object?.visible", true);
  assert.deepEqual(east.camera, west.camera);
  const masks = await Promise.all([east, west].map(frame => readFile(join(out, frame.files.mask))));
  assert.ok(masks[0].equals(masks[1]), "The opposite slopes must have the same silhouette");
  assert.equal(east.query.elevation, west.query.elevation);
  assert.deepEqual(east.query.gridPosition, west.query.gridPosition);
  assert.ok(Math.abs(east.query.aspectRadians - west.query.aspectRadians) > 3);
  await withStaleQuery(cdp, east.query, () => assert.rejects(
    capture(cdp, "control-equal-elevation-query", "s.object?.visible", true), /Active query aspect differs/));
  let colorFailure;
  await withFrozenViewport(cdp, east.files.png, () => assert.rejects(
    capture(cdp, "control-same-outline-image", "s.object?.visible", true), error => {
      colorFailure = error.message;
      return /Compositor terrain colors differ from readback/.test(colorFailure);
    }));
  await open(cdp, fixtures.empty["late-project-b"]);
  await cdp.evaluate(`(async () => {
    const { Forge3DRuntime } = await import("/forge3d-web/index.js");
    const setTerrain = Forge3DRuntime.prototype.setTerrain;
    __vp03.restoreUpload = () => { Forge3DRuntime.prototype.setTerrain = setTerrain; };
    Forge3DRuntime.prototype.setTerrain = function (input) {
      return setTerrain.call(this, { ...input, heights: __vp03.retainedHeights });
    };
  })()`);
  let staleUpload;
  try {
    await importDem(cdp, fixtures.controls.west.path);
    await assert.rejects(capture(cdp, "control-stale-upload", "s.object?.visible", true), /WASM upload heights differ/);
    staleUpload = await cdp.evaluate("__vp03.uploadEvidence()");
    assert.equal(staleUpload.acceptedSha256, west.uploadEvidence.acceptedSha256);
    assert.equal(staleUpload.upload.heightSha256, east.uploadEvidence.acceptedSha256);
    assert.notEqual(staleUpload.upload.heightSha256, staleUpload.acceptedSha256);
    const [staleRgba, eastRgba] = await Promise.all(["control-stale-upload.rgba", east.files.rgba].map(file => readFile(join(out, file))));
    assert.ok(staleRgba.equals(eastRgba), "The substituted heights must draw the old terrain");
  } finally {
    await cdp.evaluate("__vp03.restoreUpload(); delete __vp03.retainedHeights; delete __vp03.retainedQuery");
  }
  await closeProject(cdp);
  report.checks.matchingTerrainControls = { passed: true, east, west, frozenImage: "control-same-outline-image.png", colorFailure };
  report.checks.staleUpload = { passed: true, ...staleUpload, screenshot: "control-stale-upload.png", readback: "control-stale-upload.rgba" };
}

async function nativeTerrainPlacement(cdp, fixtures) {
  const original = await json(fixtures.native.path);
  const rows = [];
  for (const [name, x, scale] of [["identity", 0, 1], ["translated", 2.5, 1], ["scaled", 0, 1.5]]) {
    const project = structuredClone(original);
    project.id = randomUUID();
    project.render.width = 320;
    project.render.height = 240;
    const terrain = project.scene.objects.find(item => item.kind.type === "terrain");
    terrain.transform.translation.x = x;
    terrain.transform.scale = { x: scale, y: scale, z: scale };
    const path = join(out, "native-placement-" + name + ".studio3d");
    await writeFile(path, e(project));
    await open(cdp, { path, id: project.id });
    const solid = await capture(cdp, "placement-" + name, "s.object?.visible", true);
    const { target, position } = solid.runtimeCamera;
    const { domain, exaggeration } = solid.lastUpload;
    const expectedTarget = [target[0], -target[2], target[1] - (domain[1] - domain[0]) * exaggeration / 2];
    const radius = Math.hypot(...position.map((v, i) => v - target[i]));
    assert.ok(expectedTarget.every((v, i) => Math.abs(v - solid.nativeView.target[i]) < 1e-6));
    assert.ok(Math.abs(radius - solid.nativeView.radius) < 1e-6);
    const native = await captureNative(cdp, "placement-" + name, solid.nativeView);
    rows.push({ name, solid, native, stillSha256: hash(await readFile(native.output)) });
  }
  assert.equal(new Set(rows.map(row => row.stillSha256)).size, rows.length, "Each placement must change the native still");
  await closeProject(cdp);
  report.checks.nativeTerrainPlacement = { passed: true, rows };
}

async function cameraAndVisibilityControls(cdp, fixtures) {
  const save = async (label, project) => {
    project.id = randomUUID();
    const path = join(out, label + ".studio3d");
    await writeFile(path, e(project, null, 2) + "\n");
    await open(cdp, { id: project.id, path });
  };
  const original = await json(fixtures.native.path);
  await open(cdp, fixtures.native);
  const before = await capture(cdp, "camera-original", "s.object?.visible", true);
  const translated = structuredClone(original);
  translated.scene.objects.find(object => object.kind.type === "terrain").transform.translation.x = 2.5;
  await save("camera-translated", translated);
  const after = await capture(cdp, "camera-translated", "s.object?.visible", true);
  assert.notDeepEqual(after.runtimeCamera.position, before.runtimeCamera.position);
  await cdp.evaluate(`(async () => {
    const { Forge3DRuntime } = await import("/forge3d-web/index.js");
    const setCamera = Forge3DRuntime.prototype.setCamera;
    __vp03.restoreCamera = () => { Forge3DRuntime.prototype.setCamera = setCamera; };
    Forge3DRuntime.prototype.setCamera = function () { return setCamera.call(this, ${e(before.runtimeCamera)}); };
  })()`);
  try {
    await save("camera-stale", translated);
    await assert.rejects(capture(cdp, "camera-stale", "s.object?.visible", true),
      /Submitted camera position differs from the live viewport pose/);
    const stale = await snapshot(cdp);
    assert.deepEqual(stale.query, after.query);
    assert.deepEqual(stale.runtimeCamera, before.runtimeCamera);
  } finally {
    await cdp.evaluate("__vp03.restoreCamera(); delete __vp03.restoreCamera");
  }
  report.checks.staleCamera = { passed: true, before, after };

  const terrain = original.scene.objects.find(object => object.kind.type === "terrain");
  const hidden = { ...structuredClone(terrain), id: randomUUID(), visible: false, name: "Hidden DEM A" };
  const visible = { ...structuredClone(terrain), id: randomUUID(), name: "Visible DEM B" };
  const asset = original.assets.find(asset => asset.id === terrain.kind.asset);
  for (const [object, input] of [[hidden, fixtures.controls.east], [visible, fixtures.controls.west]]) {
    const dem = { ...asset, path: input.path, id: randomUUID(), byteSize: (await readFile(input.path)).length };
    original.assets.push(dem);
    object.kind.asset = dem.id;
    object.kind.dimensions = [96, 96];
  }
  original.scene.objects = [hidden, visible, ...original.scene.objects.filter(object => object !== terrain)];
  await save("hidden-first", original);
  const mixed = await capture(cdp, "hidden-first", `s.submission?.terrain?.objectId === ${e(visible.id)}`, true);
  assert.equal(mixed.object.id, visible.id);
  const mixedNative = await captureNative(cdp, "hidden-first", mixed.nativeView);
  await hideTerrain(cdp);
  await settle(cdp, "s.object?.visible === false && !s.nativeView", "All terrain hidden");
  const emptyExport = join(out, "hidden-only-export.png");
  const sessionId = (await projectState(cdp)).sessionId;
  for (const [command, args] of [["render_frame", { width: 320, height: 240 }], ["render_still", { path: emptyExport, sessionId }]]) {
    const error = await cdp.evaluate(`__TAURI_INTERNALS__.invoke(${e(command)}, ${e(args)}).then(() => null, String)`);
    assert.match(error, /no visible terrain to render/);
  }
  await assert.rejects(readFile(emptyExport), { code: "ENOENT" });
  assert.equal(await cdp.evaluate('!!document.querySelector(".viewport-rendered img")'), false);
  await closeProject(cdp);

  original.scene.objects.shift();
  await save("visible-only", original);
  const control = await capture(cdp, "visible-only", `s.submission?.terrain?.objectId === ${e(visible.id)}`, true);
  assert.deepEqual(control.query, mixed.query);
  const visibleNative = await captureNative(cdp, "visible-only", control.nativeView);
  assert.ok((await readFile(mixedNative.output)).equals(await readFile(visibleNative.output)),
    "The native export must draw the same DEM with or without the hidden first object");
  report.checks.nativeVisibility = { passed: true, mixed, mixedNative, visibleNative };
  await closeProject(cdp);
}

async function retiredQueryControl(cdp, fixtures) {
  await open(cdp, fixtures.empty["late-hide"]);
  await importDem(cdp, fixtures.controls.centerEast.path);
  const east = await capture(cdp, "query-owner-east", "s.object?.visible", true);
  await cdp.evaluate("__vp03.retainTerrain()");
  await open(cdp, fixtures.empty["late-project-a"]);
  await importDem(cdp, fixtures.controls.centerWest.path);
  const west = await capture(cdp, "query-owner-west", "s.object?.visible", true);
  assert.deepEqual(east.query, west.query);
  assert.notEqual(east.offCenter.hit.elevation, west.offCenter.hit.elevation);
  assert.ok(await cdp.evaluate(`__vp03.runtimes.find(record => record.id === ${east.runtime}).disposed`));
  await withQueryOverride(cdp, "(_, x, z) => __vp03.retainedQuery(x, z)", async () => {
    const stale = await snapshot(cdp);
    assert.deepEqual(stale.query, west.query);
    assert.deepEqual(stale.offCenter.hit, east.offCenter.hit);
    assert.equal(stale.queryOwner.id, east.queryOwner.id);
    await assert.rejects(capture(cdp, "control-retired-query", "s.object?.visible", true), /Off-center active query elevation .* differs from/);
    report.checks.retiredQuery = { passed: true, east, west, stale };
  });
  await cdp.evaluate("delete __vp03.retainedHeights; delete __vp03.retainedQuery");
  await closeProject(cdp);
}

async function staleGeometry(cdp, fixtures) {
  await open(cdp, fixtures.relief[0.5]);
  const low = await capture(cdp, "geometry-low", "s.object?.visible", true);
  await open(cdp, fixtures.relief[3]);
  const high = await capture(cdp, "geometry-high", "s.object?.visible", true);
  assert.deepEqual(low.camera, high.camera);
  assert.equal(low.uploadEvidence.acceptedSha256, high.uploadEvidence.acceptedSha256);
  assert.equal(low.uploadEvidence.upload.exaggeration, 0.5);
  assert.equal(high.uploadEvidence.upload.exaggeration, 3);
  const [lowRgba, highRgba] = await Promise.all([low, high].map(frame => readFile(join(out, frame.files.rgba))));
  assert.notEqual(hash(lowRgba), hash(highRgba));
  await cdp.evaluate(`(async () => {
    const { Forge3DRuntime } = await import("/forge3d-web/index.js");
    const setTerrain = Forge3DRuntime.prototype.setTerrain;
    __vp03.restoreUpload = () => { Forge3DRuntime.prototype.setTerrain = setTerrain; };
    Forge3DRuntime.prototype.setTerrain = function (input) {
      return setTerrain.call(this, { ...input, exaggeration: 0.5 });
    };
  })()`);
  try {
    await openAction(cdp, fixtures.relief[3]);
    const current = `s.projectGeneration > ${high.projectGeneration} && s.object?.visible`;
    await assert.rejects(capture(cdp, "control-stale-exaggeration", current, true), /WASM upload geometry differs/);
    const upload = await cdp.evaluate("__vp03.uploadEvidence()");
    assert.equal(upload.upload.exaggeration, 0.5);
    assert.equal(upload.acceptedGeometry.exaggeration, 3);
    assert.equal(upload.upload.heightSha256, high.uploadEvidence.acceptedSha256);
    const staleRgba = await readFile(join(out, "control-stale-exaggeration.rgba"));
    assert.ok(staleRgba.equals(lowRgba));
    report.checks.staleGeometry = { passed: true, low, high, upload, staleRgbaSha256: hash(staleRgba) };
  } finally {
    await cdp.evaluate("__vp03.restoreUpload(); delete __vp03.restoreUpload");
  }
  await closeProject(cdp);
}

async function staleQueryHeights(cdp, fixtures) {
  const thirdPoint = [-3, 0];
  const thirdQuery = () => cdp.evaluate(`forge3dViewportDiagnostics().queryTerrain(...${e(thirdPoint)})`);
  await open(cdp, fixtures.empty["late-hide"]);
  await importDem(cdp, fixtures.controls.queryOld.path);
  const old = await capture(cdp, "query-data-old", "s.object?.visible", true);
  const oldThird = await thirdQuery();
  await cdp.evaluate("__vp03.retainTerrain()");
  await open(cdp, fixtures.empty["late-project-a"]);
  await importDem(cdp, fixtures.controls.queryNew.path);
  const current = await capture(cdp, "query-data-current", "s.object?.visible", true);
  const currentThird = await thirdQuery();
  assert.deepEqual(old.query, current.query);
  assert.deepEqual(old.offCenter.hit, current.offCenter.hit);
  assert.notEqual(oldThird.elevation, currentThird.elevation);

  await open(cdp, fixtures.empty["late-project-b"]);
  await cdp.evaluate(`(async () => {
    const { TerrainDataset } = await import("/forge3d-web/index.js");
    const fromArray = TerrainDataset.fromArray;
    __vp03.restoreDataset = () => { TerrainDataset.fromArray = fromArray; };
    TerrainDataset.fromArray = function (input) {
      return fromArray.call(this, { ...input, heights: __vp03.retainedHeights.slice() });
    };
  })()`);
  try {
    await importDem(cdp, fixtures.controls.queryNew.path);
    await assert.rejects(capture(cdp, "control-stale-query-heights", "s.object?.visible", true), /Active query dataset heights differ/);
    const stale = await snapshot(cdp);
    const staleThird = await thirdQuery();
    const evidence = await cdp.evaluate("__vp03.uploadEvidence()");
    assert.notEqual(stale.queryOwner.id, old.queryOwner.id);
    assert.deepEqual(stale.queryOwner.request, stale.submission.terrain);
    assert.deepEqual(stale.query, current.query);
    assert.deepEqual(stale.offCenter.hit, current.offCenter.hit);
    assert.deepEqual(staleThird, oldThird);
    assert.equal(evidence.queries[0].heightSha256, old.uploadEvidence.acceptedSha256);
    assert.equal(evidence.upload.heightSha256, current.uploadEvidence.acceptedSha256);
    const [staleRgba, currentRgba] = await Promise.all(["control-stale-query-heights.rgba", current.files.rgba]
      .map(file => readFile(join(out, file))));
    assert.deepEqual(stale.dimensions, current.dimensions, "Stale-query control changed the framebuffer dimensions");
    assert.ok(staleRgba.equals(currentRgba), "Changing only the query heights must preserve every framebuffer byte");
    report.checks.staleQueryHeights = { passed: true, old, current, stale, evidence, thirdPoint, oldThird, currentThird, staleThird };
  } finally {
    await cdp.evaluate("__vp03.restoreDataset(); delete __vp03.restoreDataset; delete __vp03.retainedHeights; delete __vp03.retainedQuery");
  }
  await closeProject(cdp);
}

async function wideFootprints(cdp, fixtures) {
  const rows = [];
  for (const [key, span, name] of [["below", 47760, "late-hide"], ["boundary", 48000, "late-project-a"], ["wide", 112363, "late-project-b"]]) {
    await open(cdp, fixtures.empty[name]);
    await importDem(cdp, fixtures.controls[key].path);
    const frame = await capture(cdp, `span-${span}`, "s.object?.visible", true);
    assert.equal(frame.query.elevation, 2000);
    assert.ok(Math.abs(frame.runtimeCamera.near - frame.camera.near * span / 12) < 1e-6);
    assert.ok(Math.abs(frame.runtimeCamera.far - frame.camera.far * span / 12) < 1e-6);
    if (span >= 48000) {
      assert.equal(frame.runtimeShadows.enabled, false);
      assert.equal(frame.runtimeShadows.csm.enabled, false);
      assert.ok(frame.runtimeShadows.csm.maxDistance > Math.fround(frame.runtimeCamera.near));
    }
    if (rows.length) {
      assert.deepEqual(frame.camera, rows[0].frame.camera);
      assert.equal(frame.uploadEvidence.acceptedSha256, rows[0].frame.uploadEvidence.acceptedSha256);
    }
    rows.push({ span, frame });
  }
  await closeProject(cdp);
  report.checks.wideFootprints = { passed: true, rows };
}

async function latePreview(cdp, fixtures, replaceProject) {
  const name = replaceProject ? "late-project" : "late-hide";
  const fixture = fixtures.empty[replaceProject ? "late-project-a" : "late-hide"];
  const empty = await open(cdp, fixture);
  await cdp.evaluate("__vp03.holdPreview = true");
  await importDem(cdp, fixtures.dem);
  const loading = await settle(cdp, 's.object?.visible && s.backend?.includes("Loading terrain") && !!__vp03.releasePreview',
    name + " pending preview");
  assert.equal(loading.query, null);
  assert.equal(loading.runtime, empty.runtime);
  if (replaceProject) await open(cdp, fixtures.empty["late-project-b"]);
  else await hideTerrain(cdp);
  const pending = await settle(cdp, 's.backend === "Viewport forge3d-web · WebGPU available" && !s.object?.visible',
    name + " invalidation");
  assert.equal(pending.query, null);
  assert.equal(pending.accepted, null);
  await cdp.evaluate("__vp03.releasePreview()");
  await until(cdp, "__vp03.ipc.findLast(call => call.held)?.completed", name + " completion");
  await cdp.evaluate(raf);
  const frame = await capture(cdp, name, "!s.object?.visible", false);
  assert.equal(frame.runtime, empty.runtime, "An already-empty runtime can be reused");
  if (replaceProject) assert.notEqual(frame.projectGeneration, loading.projectGeneration);
  report.checks[name] = { passed: true, loading, frame };
}

async function limitedPreview(cdp, fixtures) {
  await closeProject(cdp);
  await cdp.evaluate("__vp03.terrainLimit = 128; __vp03.skipTerrainFrame = true");
  const initial = await open(cdp, fixtures.empty.limit);
  await importDem(cdp, fixtures.dem);
  await settle(cdp, "s.object?.visible", "Limit fixture DEM");
  await setPreviewResolution(cdp, 256);
  const frame = await capture(cdp, "limit-128", "s.accepted?.resolution === 128", true, initial.submission.sequence);
  const detail = await cdp.evaluate(`({runtime: __vp03.runtimes.find(r => r.id === ${frame.runtime}),
    calls: __vp03.ipc.filter(call => call.command === "terrain_preview" && call.started > ${initial.successfulFrame.at})})`);
  assert.ok(detail.runtime.realTextureLimit > 128);
  assert.ok(detail.runtime.uploads.length > 0 && detail.runtime.uploads.every(({ width, height }) => width <= 128 && height <= 128));
  const landed = detail.calls.findLast(call => call.args.resolution === 128);
  assert.deepEqual(landed?.preview?.grid, [128, 128]);
  const skipped = detail.runtime.frames.find(frame => frame.skippedByProbe);
  assert.ok(skipped && detail.runtime.frames.some(frame => frame.at > skipped.at && frame.submitted));

  const source = project => {
    const kind = project.scene.objects.find(object => object.kind.type === "terrain").kind;
    return { dimensions: kind.dimensions, origin: kind.worldOriginXz, span: kind.worldSpanXz,
      asset: project.assets.find(asset => asset.id === kind.asset) };
  };
  const project = (await projectState(cdp)).project;
  const before = source(project);
  await click(cdp, '[title="Save (Ctrl+S)"]');
  await until(cdp, '__vp03.ipc.findLast(call => call.command === "save_project")?.completed', "Save limited preview project");
  const savedPath = fixtures.empty.limit.path;
  const saved = await json(savedPath);
  const after = source(saved);
  assert.deepEqual(saved.viewport, project.viewport);
  assert.deepEqual(saved.render, project.render);
  assert.deepEqual(after.dimensions, fixtures.sourceDimensions);
  assert.deepEqual({ ...after, asset: { ...after.asset, path: before.asset.path } }, before);
  const resolvedAsset = await realpath(resolve(dirname(savedPath), after.asset.path));
  assert.equal(resolvedAsset, await realpath(fixtures.dem));
  assert.equal(hash(await readFile(resolvedAsset)), fixtures.demSha256);
  report.checks.limit = { passed: true, requested: [256, 256], effective: landed.args.resolution,
    returned: landed.preview, uploaded: detail.runtime.uploads, saved: after, frame, skipped };
  const replacement = fixtures.empty["late-project-b"];
  await open(cdp, replacement);
  const cleared = await capture(cdp, "committed-project-replacement", `s.projectId === ${e(replacement.id)} && !s.object`, false,
    frame.submission.sequence);
  assert.notEqual(cleared.runtime, frame.runtime);
  assert.notEqual(cleared.projectGeneration, frame.projectGeneration);
  report.checks.committedReplacement = { passed: true, frame: cleared };
  await resizeEmpty(cdp, cleared);
  await closeProject(cdp);
}

async function setPreviewResolution(cdp, resolution) {
  await click(cdp, terrainRow + " .tree-name");
  await click(cdp, '.props__rail [title^="Object:"]');
  await until(cdp, '[...document.querySelectorAll("label.field")].some(el => el.textContent.includes("Solid mesh"))',
    "Terrain resolution slider");
  await cdp.evaluate(`(() => {
    const slider = [...document.querySelectorAll("label.field")].find(el => el.textContent.includes("Solid mesh")).querySelector("input");
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(slider, ${resolution});
    slider.dispatchEvent(new Event("input", {bubbles:true}));
  })()`);
  const text = `Solid mesh · ${resolution} × ${resolution}`;
  await until(cdp, `document.querySelector(".inspector-body").textContent.includes(${e(text)})`, text);
}

async function resizeEmpty(cdp, original) {
  const windowSize = await cdp.evaluate("({width: innerWidth, height: innerHeight})");
  await cdp.send("Emulation.setDeviceMetricsOverride", { ...windowSize, mobile: false, deviceScaleFactor: 1.5 });
  let scaled;
  try {
    scaled = await settle(cdp, `s.dimensions?.pixelRatio === 1.5 && s.submission?.sequence > ${original.submission.sequence}`,
      "Resize WebGPU at fractional display scaling");
    const { cssWidth, cssHeight, width, height } = scaled.dimensions;
    assert.deepEqual([width, height], [Math.floor(cssWidth * 1.5), Math.floor(cssHeight * 1.5)]);
    assert.deepEqual(scaled.runtimeDimensions, [width, height]);
    assert.equal(scaled.runtime, original.runtime);
  } finally {
    await cdp.send("Emulation.clearDeviceMetricsOverride");
  }
  const restored = await settle(cdp, `s.submission?.sequence > ${scaled.submission.sequence} && s.dimensions?.pixelRatio === ${original.dimensions.pixelRatio}`,
    "Restore desktop display scaling");
  assert.deepEqual(restored.dimensions, original.dimensions);
  const resizes = await cdp.evaluate(`__vp03.runtimes.find(r => r.id === ${original.runtime}).resizes`);
  assert.deepEqual(resizes.at(-2), { width: scaled.dimensions.width, height: scaled.dimensions.height, devicePixelRatio: 1 });
  report.checks.resize = { passed: true, scaled: scaled.dimensions, restored: restored.dimensions, resizes };
}

async function lateCreation(cdp, fixtures, unmount) {
  await cdp.evaluate("__vp03.holdCreation = true");
  await openAction(cdp, fixtures.empty["late-project-a"]);
  const held = await until(cdp, "__vp03.releaseCreation && __vp03.runtimes.at(-1)?.ready && __vp03.runtimes.at(-1)", "Pending runtime");
  const replacement = fixtures.empty["late-project-b"];
  if (unmount) {
    await closeAction(cdp);
    await until(cdp, "!window.forge3dViewportDiagnostics", "Unmount during runtime creation");
  } else {
    await openAction(cdp, replacement);
    await settle(cdp, `s.projectId === ${e(replacement.id)} && !s.submission`, "Replace project during runtime creation");
  }
  await cdp.evaluate("__vp03.releaseCreation()");
  const retired = await until(cdp, `__vp03.runtimes.find(r => r.id === ${held.id} && r.disposed)`, "Dispose the late runtime");
  let clean;
  if (unmount) {
    clean = await settle(cdp, "!s.liveRuntimes.length && !s.liveContexts.length", "Zero runtimes after pending unmount");
  } else {
    clean = await capture(cdp, "late-runtime-replacement", `s.projectId === ${e(replacement.id)}`, false);
    const created = await cdp.evaluate(`__vp03.runtimes.find(r => r.id === ${clean.runtime})`);
    assert.ok(created.create > retired.disposed);
    assert.equal(created.context, retired.context);
    await closeProject(cdp);
  }
  assert.deepEqual(retired.frames, []);
  report.checks[unmount ? "lateCreationUnmount" : "lateCreationReplacement"] = { passed: true, retired, clean };
}

async function chooseRenderer(cdp, label) {
  await click(cdp, ".menu__button", "View");
  await click(cdp, '[role="menuitemradio"]', label);
}

function disableEditorAxes(cdp) {
  return cdp.evaluate(`(() => {
    const runtime = forge3dViewportDiagnostics().runtime;
    for (const object of runtime.scene.children) if (object.type === "AxesHelper") object.visible = false;
    runtime.needsRender = true;
  })()`);
}

async function editorSkippedFrame(cdp, fixtures) {
  await open(cdp, fixtures.empty["five-states"]);
  await disableEditorAxes(cdp);
  const empty = await capture(cdp, "skip-01-empty", "!s.object", false, 0, { editor: true });
  await cdp.evaluate('__vp03.skipTerrainFrame = "hold-retry"');
  let waiting;
  let display;
  let skip;
  try {
    await importDem(cdp, fixtures.dem);
    waiting = await settle(cdp, '__vp03.retryHeld && s.backend?.includes("Waiting for WebGPU frame") && s.accepted && s.editor',
      "Held retry after the first terrain frame skipped");
    assert.equal(waiting.runtime, empty.runtime);
    assert.equal(waiting.query, null);
    assert.equal(waiting.submission, undefined);
    assert.equal(waiting.canvasVisible, false);
    skip = await cdp.evaluate(`__vp03.runtimes.find(r => r.id === ${waiting.runtime}).frames.at(-1)`);
    assert.ok(skip.skippedByProbe && !skip.submitted && skip.uploads === 1);
    await cdp.evaluate(raf);
    const image = await cdp.screenshot(waiting.css);
    await writeFile(join(out, "skip-02-waiting.png"), image);
    const png = decodePng(image);
    display = measureSolidDisplay(png, new Uint8Array(waiting.dimensions.width * waiting.dimensions.height),
      waiting.dimensions, waiting.chrome, undefined, { clip: waiting.css, viewport: waiting.css, displayDpr: waiting.displayDpr });
    requireSolidDisplay(display, false, png.width * png.height);
    assert.equal(waiting.terrainGroupVisible, false);
  } finally {
    await cdp.evaluate("__vp03.releaseTerrainRetry?.()");
  }
  const retry = await capture(cdp, "skip-03-retry", "s.object?.visible", true, empty.submission.sequence, { editor: true });
  assert.equal(retry.runtime, waiting.runtime);
  assert.deepEqual(retry.submission.terrain, waiting.accepted);
  assert.ok(retry.successfulFrame.at > skip.at);
  assert.deepEqual(retry.camera, empty.camera);
  report.checks.editorSkippedFrame = { passed: true, empty, waiting, skip, waitingDisplay: display, retry };
}

async function editorPreviewErrors(cdp) {
  const fixture = report.fixtures.failure;
  await open(cdp, fixture);
  await disableEditorAxes(cdp);
  await chooseRenderer(cdp, "three.js");
  const three = await settle(cdp, 's.backend?.includes("View menu override") && s.accepted && s.editor', "Accepted three.js DEM");
  await cdp.evaluate(raf);
  const before = await cdp.screenshot(three.css);
  await writeFile(join(out, "cap-7-editor-before.png"), before);
  const beforeDisplay = measureSolidDisplay(decodePng(before), new Uint8Array(three.dimensions.width * three.dimensions.height),
    three.dimensions, three.chrome, undefined, { clip: three.css, viewport: three.css, displayDpr: three.displayDpr });
  assert.ok(beforeDisplay.changed > 10_000, "The editor-only DEM must be visible before switching to Auto");
  await cdp.evaluate("__vp03.terrainLimit = 7");
  await chooseRenderer(cdp, "Auto");
  const capError = await settle(cdp, 's.backend?.includes("GPU texture limit of 7") && s.submission && !s.submission.terrain', "Unusable cap with an editor");
  const cleared = await capture(cdp, "cap-7-editor-cleared", "s.object?.visible && s.accepted === null", false, 0,
    { editor: true, status: capError.backend });
  assert.ok(cleared.problem.includes("minimum 8"));
  report.checks.editorUnusableLimit = { passed: true, three, beforeDisplay, cleared };

  await chooseRenderer(cdp, "three.js");
  await settle(cdp, 's.backend?.includes("View menu override") && s.accepted', "Recover editor preview");
  await cdp.evaluate("delete __vp03.terrainLimit");
  await chooseRenderer(cdp, "Auto");
  const healthy = await settle(cdp, `s.backend === ${e(ready)} && s.submission?.terrain`, "Restore healthy terrain");
  await cdp.evaluate("__vp03.wrongPreviewRequest = 160");
  await setPreviewResolution(cdp, 160);
  const wrongSize = await settle(cdp, 's.backend?.includes("8 × 8 for a 160 × 160") && s.submission && !s.submission.terrain',
    "Reject a valid-shaped grid of the wrong size");
  const wrong = await capture(cdp, "wrong-size-cleared", "s.object?.visible && s.accepted === null", false, healthy.submission.sequence,
    { editor: true, status: wrongSize.backend });
  const reply = await cdp.evaluate("__vp03.ipc.findLast(call => call.replacedGrid)");
  assert.deepEqual(reply.preview.grid, [8, 8]);
  assert.equal(reply.args.resolution, 160);
  assert.notEqual(healthy.runtime, wrong.runtime);
  assert.ok(!wrong.lastUpload);
  report.checks.wrongSize = { passed: true, reply, frame: wrong };
  await hideTerrain(cdp);
  await settle(cdp, "s.object?.visible === false && !s.query", "Hide invalid preview");
  await showTerrain(cdp);
  const recovered = await capture(cdp, "wrong-size-recovered", "s.object?.visible && s.accepted?.resolution === 160",
    true, wrong.submission.sequence, { editor: true });
  const calls = await cdp.evaluate('__vp03.ipc.filter(c => c.command === "terrain_preview" && c.started > ' + reply.completed + ' && c.args.resolution === 160)');
  assert.ok(calls.some(call => call.ok && call.preview?.samples === 160 * 160));
  report.checks.invalidPreviewRetry = { passed: true, recovered, calls };
}

async function openRemoteDialog(cdp) {
  if (!await cdp.evaluate(`!!document.querySelector('[role="dialog"][aria-label="New project"]')`)) {
    await click(cdp, ".menu__button", "File");
    await click(cdp, '[role="menuitem"]', "New project");
  }
  // Activate the Gallery's button directly. Closing the nested URL dialog can
  // move the Gallery's scroll position during the next pointer event.
  await until(cdp, `(() => {
    const gallery = document.querySelector('[role="dialog"][aria-label="New project"]');
    const button = [...(gallery?.querySelectorAll("button.preset") ?? [])]
      .find(item => !item.disabled && item.textContent.trim().startsWith("Remote DEM (COG)"));
    if (!button) return false;
    button.click();
    return true;
  })()`, "Remote DEM Gallery action");
  await until(cdp, 'Boolean(document.querySelector(".remote-dem input"))', "Remote DEM URL input");
}

function setRemoteUrl(cdp, url) {
  return cdp.evaluate(`(() => {
    const input = document.querySelector(".remote-dem input");
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, ${e(url)});
    input.dispatchEvent(new Event("input", {bubbles:true}));
  })()`);
}

const remoteCanOpen = `[...document.querySelectorAll(".remote-dem button")]
  .some(button => button.textContent.trim() === "Open DEM" && !button.disabled)`;
const waitRemoteProbe = cdp => until(cdp, `document.querySelector(".remote-dem .hint--error")?.textContent ||
    ((${remoteCanOpen}) && "ready")`,
  // Gallery runs two native calls in series, each with a 30-second script deadline.
  "Remote DEM probe", 75_000);

async function probeRemoteDem(cdp, url) {
  await openRemoteDialog(cdp);
  await setRemoteUrl(cdp, url);
  await click(cdp, ".remote-dem button", "Probe");
  return waitRemoteProbe(cdp);
}

async function rejectRemoteDem(cdp, fixture, name, reason, expectPreviewFailure = false) {
  const remote = await serveCog(fixture.path);
  try {
    const before = await projectState(cdp);
    const gallery = await probeRemoteDem(cdp, remote.url);
    assert.match(gallery, reason);
    const galleryCalls = await cdp.evaluate(`__vp03.ipc.filter(call => call.args.url === ${e(remote.url)})`);
    assert.deepEqual(galleryCalls.map(call => [call.command, call.ok]), expectPreviewFailure
      ? [["remote_cog_info", true], ["remote_cog_preview", false]] : [["remote_cog_info", false]]);
    const preview = await cdp.evaluate(`__TAURI_INTERNALS__.invoke("remote_cog_preview", {url: ${e(remote.url)}, resolution: 96})
      .then(() => "accepted", error => String(error))`);
    assert.match(preview, reason);
    assert.equal(await cdp.evaluate(remoteCanOpen), false);
    assert.deepEqual(await projectState(cdp), before);
    assert.ok(remote.ranges.some(request => request.status === 206));
    await writeFile(join(out, name + ".png"), await cdp.screenshot());
    await click(cdp, '.remote-dem button[aria-label="Cancel"]');
    await until(cdp, '!document.querySelector(".remote-dem")', "Close the rejected remote DEM dialog");
    report.checks[name] = { passed: true, fixture, url: remote.url, gallery, galleryCalls, preview, ranges: remote.ranges };
  } finally {
    remote.close();
  }
}

async function editedGalleryUrl(cdp, fixtures) {
  const remote = await serveCog(fixtures.controls.metres.path);
  const rgb = await serveCog(fixtures.controls.rgbCog.path);
  const hold = { command: "remote_cog_info", url: remote.url };
  try {
    const before = await projectState(cdp);
    const first = await cdp.evaluate("__vp03.ipc.length");
    await openRemoteDialog(cdp);
    const copy = await cdp.evaluate('document.querySelector(".remote-dem .modal__footer .hint").textContent.trim()');
    assert.match(copy, /saves the URL and reads the DEM by byte range/);
    await setRemoteUrl(cdp, remote.url);
    await cdp.evaluate(`__vp03.holdGallery = ${e(hold)}`);
    await click(cdp, ".remote-dem button", "Probe");
    await until(cdp, 'typeof __vp03.releaseGallery === "function"', "Real Gallery metadata held");
    await setRemoteUrl(cdp, rgb.url);
    await cdp.evaluate("__vp03.releaseGallery()");
    await until(cdp, `__vp03.ipc.slice(${first}).find(call => call.held && call.completed)`, "Release edited Gallery metadata");
    await cdp.evaluate(raf);
    const edited = await cdp.evaluate(`({url: document.querySelector(".remote-dem input").value, canOpen: ${remoteCanOpen},
      summary: Boolean(document.querySelector(".remote-dem .probe-summary")), preview: Boolean(document.querySelector(".remote-dem .cog-preview"))})`);
    assert.deepEqual(edited, { url: rgb.url, canOpen: false, summary: false, preview: false });
    await writeFile(join(out, "gallery-edited-url.png"), await cdp.screenshot());
    await click(cdp, ".remote-dem button", "Probe");
    const rejection = await waitRemoteProbe(cdp);
    assert.match(rejection, /single elevation band.*red, green, blue/);
    const calls = await cdp.evaluate(`__vp03.ipc.slice(${first}).filter(call => call.args.url === ${e(remote.url)} || call.args.url === ${e(rgb.url)})`);
    assert.deepEqual(calls.map(call => [call.command, call.args.url, call.ok]),
      [["remote_cog_info", remote.url, true], ["remote_cog_info", rgb.url, false]]);
    assert.deepEqual(await projectState(cdp), before);
    await click(cdp, '.remote-dem button[aria-label="Cancel"]');
    await until(cdp, '!document.querySelector(".remote-dem")', "Close the edited Gallery dialog");
    report.checks.editedGalleryUrl = { passed: true, copy, edited, rejection, calls };
  } finally {
    await cdp.evaluate("__vp03.releaseGallery?.(); delete __vp03.holdGallery");
    remote.close();
    rgb.close();
  }
}

async function remoteScale(cdp, fixtures) {
  const rows = {};
  for (const key of ["metres", "packed", "feet", "verticalFeet"]) {
    const fixture = fixtures.controls[key];
    const remote = await serveCog(fixture.path);
    try {
      assert.equal(await probeRemoteDem(cdp, remote.url), "ready");
      await click(cdp, ".remote-dem button", "Open DEM");
      const project = await until(cdp, `__TAURI_INTERNALS__.invoke("project_state").then(s =>
        s?.project.assets.some(a => a.path === ${e(remote.url)}) && s.project)`, "Open differently encoded elevation DEM", 40_000);
      const source = project.scene.objects.find(object => object.kind.type === "terrain").kind;
      assert.deepEqual(source.dimensions, [192, 192]);
      const unit = source.spanMetresPerUnit ?? 1;
      assert.ok(source.worldSpanXz.every(side => Math.abs(side * unit - 3840) < 1e-6));
      await click(cdp, '.props__rail [aria-label="Render"]');
      if (project.render.shadows) await click(cdp, "label.toggle", "Sun shadows");
      const frame = await capture(cdp, `remote-elevation-${key}`, `s.projectId === ${e(project.id)} && s.object?.visible`,
        true, 0, { strictSettings: false });
      assert.equal(frame.query.elevation, 1302.5);
      const sampled = await cdp.evaluate(`__vp03.ipc.findLast(call => call.command === "remote_cog_preview" && call.args.url === ${e(remote.url)})`);
      assert.equal(sampled.preview.level, 1);
      assert.deepEqual(sampled.preview.overview, [96, 96]);
      assert.ok(remote.ranges.some(request => request.status === 206));
      rows[key] = { fixture, frame, elevationRange: source.elevationRange, zScale: source.zScale, sampled, ranges: remote.ranges };
      await closeProject(cdp);
    } finally {
      remote.close();
    }
  }
  assert.deepEqual(rows.metres.elevationRange, rows.packed.elevationRange);
  assert.equal(rows.feet.zScale, rows.metres.zScale);
  assert.deepEqual(rows.metres.frame.uploadEvidence.acceptedGeometry, rows.packed.frame.uploadEvidence.acceptedGeometry);
  assert.equal(rows.metres.frame.uploadEvidence.acceptedSha256, rows.packed.frame.uploadEvidence.acceptedSha256);
  assert.deepEqual(rows.metres.frame.query, rows.packed.frame.query);
  const metre = rows.metres.frame;
  const foot = rows.feet.frame;
  requireCurrentQuery(foot.query, metre.query, "Survey-foot CRS query");
  requireSubmittedCamera(foot.runtimeCamera, metre.runtimeCamera);
  assert.ok(Math.abs(foot.nativeView.radius - metre.nativeView.radius) < 1e-6);
  assert.equal(foot.uploadEvidence.acceptedSha256, metre.uploadEvidence.acceptedSha256);
  await open(cdp, fixtures.empty["five-states"]);
  await importDem(cdp, fixtures.controls.packed.path);
  await setPreviewResolution(cdp, metre.accepted.resolution);
  const local = await capture(cdp, "local-elevation-packed", `s.object?.visible && s.accepted?.resolution === ${metre.accepted.resolution}`, true);
  assert.deepEqual(local.query, metre.query);
  assert.equal(local.uploadEvidence.acceptedSha256, metre.uploadEvidence.acceptedSha256);
  await closeProject(cdp);
  const bandFeet = rows.verticalFeet.frame;
  requireCurrentQuery(bandFeet.query, metre.query, "Foot-valued elevation band");
  assert.equal(bandFeet.uploadEvidence.acceptedSha256, metre.uploadEvidence.acceptedSha256);
  await open(cdp, fixtures.empty["five-states"]);
  await importDem(cdp, fixtures.controls.verticalFeet.path);
  await setPreviewResolution(cdp, metre.accepted.resolution);
  const localFeet = await capture(cdp, "local-elevation-feet", `s.object?.visible && s.accepted?.resolution === ${metre.accepted.resolution}`, true);
  requireCurrentQuery(localFeet.query, metre.query, "Local foot-valued elevation band");
  assert.equal(localFeet.uploadEvidence.acceptedSha256, metre.uploadEvidence.acceptedSha256);
  await closeProject(cdp);
  report.checks.remoteScale = { passed: true, ...rows, local, localFeet };
}

async function publicCog(cdp) {
  const tile = "Copernicus_DSM_COG_10_N37_00_W113_00_DEM";
  const url = `https://copernicus-dem-30m.s3.amazonaws.com/${tile}/${tile}.tif`;
  const response = await fetch(url, { headers: { Range: "bytes=0-0" }, signal: AbortSignal.timeout(15_000) });
  const range = response.headers.get("content-range");
  if (response.status !== 206) await response.body?.cancel();
  assert.equal(response.status, 206);
  assert.equal(range, "bytes 0-0/39903643");
  assert.equal((await response.arrayBuffer()).byteLength, 1);
  assert.equal(await probeRemoteDem(cdp, url), "ready");
  await click(cdp, ".remote-dem button", "Open DEM");
  const gallery = await until(cdp, `__TAURI_INTERNALS__.invoke("project_state").then(s =>
    s?.project.assets.some(a => a.path === ${e(url)}) && s)`, "Public COG Gallery project", 60_000);
  const object = gallery.project.scene.objects.find(object => object.kind.type === "terrain");
  assert.deepEqual(object.kind.dimensions, [3600, 3600]);
  assert.equal(gallery.project.render.sunVisibility, false);
  await click(cdp, '.props__rail [aria-label="Render"]');
  if (gallery.project.render.shadows) await click(cdp, "label.toggle", "Sun shadows");
  const frame = await capture(cdp, "public-cog", `s.projectId === ${e(gallery.project.id)} && s.object?.visible`,
    true, 0, { strictSettings: false });
  const { render, viewport } = (await projectState(cdp)).project;
  assert.equal(viewport.mode, "solid");
  assert.equal(render.shadows, false);
  assert.equal(render.sunVisibility, false);
  assert.ok(Math.abs(frame.query.elevation - 2260.8624877929688) < 0.0005);
  assert.ok(Math.abs(frame.runtimeCamera.near - frame.camera.near * Math.max(...object.kind.worldSpanXz) / 12) < 1e-6);
  assert.equal(frame.runtimeShadows.enabled, false);
  assert.ok(frame.runtimeShadows.csm.maxDistance > Math.fround(frame.runtimeCamera.near));
  await closeProject(cdp);
  report.checks.publicCOG = { passed: true, url, range, object: object.kind, frame };
}

async function remoteRoundtrip(cdp) {
  const fixture = report.fixtures.cog;
  const remote = await serveCog(fixture.path);
  const assetFor = project => project.assets.find(asset => asset.kind === "dem");
  const terrainFor = project => project.scene.objects.find(object => object.kind.type === "terrain").kind;
  try {
    const result = await probeRemoteDem(cdp, remote.url);
    assert.equal(result, "ready");
    await click(cdp, ".remote-dem button", "Open DEM");
    const gallery = await until(cdp, `__TAURI_INTERNALS__.invoke("project_state").then(s =>
      s?.project.assets.some(a => a.path === ${e(remote.url)}) && s)`, "Remote gallery project", 40_000);
    const seed = assetFor(gallery.project);
    assert.equal(seed.byteSize, fixture.byteSize);
    assert.deepEqual(terrainFor(gallery.project).dimensions, fixture.oracle.dimensions);
    assert.deepEqual(terrainFor(gallery.project).worldOriginXz, fixture.oracle.origin);
    assert.deepEqual(terrainFor(gallery.project).worldSpanXz, fixture.oracle.span);
    assert.equal(gallery.project.render.shadows, true);
    await click(cdp, '.props__rail [aria-label="Render"]');
    const beforeViewportReads = remote.ranges.length;
    await click(cdp, "label.toggle", "Sun shadows");
    const drawn = await capture(cdp, "remote-gallery", "s.object?.visible && !s.problem", true, 0, { strictSettings: false });
    assert.equal((await projectState(cdp)).project.render.shadows, false);
    assert.ok(Math.abs(drawn.query.elevation - fixture.oracle.elevation) < 0.0005,
      "The live remote query must match the actual overview, including its geographic footprint");
    const viewportReads = remote.ranges.slice(beforeViewportReads);
    assert.ok(viewportReads.some(entry => entry.status === 206));
    assert.ok(viewportReads.reduce((sum, entry) => sum + entry.bytes, 0) < fixture.byteSize);
    const calls = await cdp.evaluate('__vp03.ipc.filter(call => call.command === "remote_cog_preview")');
    assert.equal(calls.at(-1).preview.level, 3);
    assert.deepEqual(calls.at(-1).preview.overview, fixture.oracle.overview);

    const staleHit = report.steps[1].query;
    await withStaleQuery(cdp, staleHit, async () => {
      await assert.rejects(capture(cdp, "control-stale-query", "s.object?.visible", true, 0, { strictSettings: false }),
        /differs from accepted grid elevation/);
      report.checks.staleQueryControl = { passed: true, stale: staleHit.elevation, current: drawn.query.elevation };
    });

    const savedPath = join(out, "remote-roundtrip.studio3d");
    await queuePicker(cdp, "save", savedPath);
    await click(cdp, ".menu__button", "File");
    await click(cdp, '[role="menuitem"]', "Save as");
    await until(cdp, `__vp03.ipc.findLast(call => call.command === "save_project" &&
      call.args.path === ${e(savedPath)} && call.ok)?.completed`, "Save remote project");
    const saved = await json(savedPath);
    assert.deepEqual(assetFor(saved), seed);
    const priorRanges = remote.ranges.length;
    const priorCalls = await cdp.evaluate("__vp03.ipc.length");
    await openAction(cdp, { path: savedPath });
    const reopened = await capture(cdp, "remote-reopened", `s.projectGeneration > ${drawn.projectGeneration} && s.object?.visible`,
      true, 0, { strictSettings: false });
    const actual = await projectState(cdp);
    assert.deepEqual(assetFor(actual.project), seed);
    assert.deepEqual(terrainFor(actual.project), terrainFor(saved));
    assert.deepEqual(actual.project.render, saved.render);
    assert.equal(reopened.query.elevation, drawn.query.elevation);
    const reopenedIpc = await cdp.evaluate(`__vp03.ipc.slice(${priorCalls})`);
    assert.ok(reopenedIpc.some(call => call.command === "remote_cog_preview" && call.args.url === remote.url));
    assert.ok(reopenedIpc.every(call => call.command !== "terrain_preview"));
    const reopenReads = remote.ranges.slice(priorRanges);
    assert.ok(reopenReads.some(entry => entry.status === 206));

    remote.setAvailable(false);
    await closeProject(cdp);
    const priorOffline = remote.ranges.length;
    await openAction(cdp, { path: savedPath });
    const offlineStatus = await settle(cdp, `s.projectId === ${e(saved.id)} && s.problem?.includes("503")`, "Unavailable remote source");
    const offline = await capture(cdp, "remote-unavailable", `s.projectId === ${e(saved.id)} && s.object?.visible`,
      false, 0, { status: offlineStatus.backend, strictSettings: false });
    const offlineReads = remote.ranges.slice(priorOffline);
    assert.ok(offlineReads.some(entry => entry.status === 503));
    await closeProject(cdp);
    remote.setAvailable(true);
    report.checks.remoteCOG = { passed: true, fixture, seed, drawn, calls, viewportReads, reopened, reopenReads, savedPath,
      offline, offlineReads };

    const legacy = structuredClone(saved);
    legacy.id = randomUUID();
    legacy.name = "VP-03 legacy remote DEM";
    legacy.render.width = 480;
    legacy.render.height = 360;
    assetFor(legacy).byteSize = 0;
    delete terrainFor(legacy).worldOriginXz;
    delete terrainFor(legacy).worldSpanXz;
    const legacyPath = join(out, "legacy-remote.studio3d");
    const legacyBytes = e(legacy, null, 2) + "\n";
    await writeFile(legacyPath, legacyBytes);
    assert.ok(legacy.scene.activeCamera);
    const legacyFixture = { path: legacyPath, id: legacy.id, sha256: hash(legacyBytes) };
    await open(cdp, legacyFixture);
    const legacySolid = await capture(cdp, "legacy-remote-solid", `s.projectId === ${e(legacy.id)} && s.object?.visible`,
      true, 0, { strictSettings: false });
    assert.equal(legacySolid.query.elevation, drawn.query.elevation);
    const span = Math.max(...fixture.oracle.span);
    const aim = legacySolid.camera.aim.orbitTarget;
    const metres = Math.hypot(...legacySolid.camera.eye.map((axis, index) => axis - aim[index])) * span / 12;
    assert.ok(Math.abs(legacySolid.nativeView.radius - metres) < 1e-6, "Legacy camera must use measured footprint metres");
    const initialNative = await captureNative(cdp, "legacy-remote", legacySolid.nativeView);
    const coldOpens = [];
    for (const withCamera of [true, false]) {
      const cold = structuredClone(legacy);
      cold.id = randomUUID();
      cold.viewport.mode = "rendered";
      if (!withCamera) {
        cold.scene.objects = cold.scene.objects.filter(object => object.kind.type !== "camera");
        cold.scene.activeCamera = null;
      }
      const name = withCamera ? "legacy-rendered-authored" : "legacy-rendered-no-camera";
      const path = join(out, name + ".studio3d");
      await writeFile(path, e(cold, null, 2) + "\n");
      const start = await cdp.evaluate("__vp03.ipc.length");
      await openAction(cdp, { path });
      await settle(cdp, `s.projectId === ${e(cold.id)} && s.backend?.includes("Viewport native")`, "Direct Rendered open");
      const openedAt = await cdp.evaluate(`__vp03.ipc.slice(${start}).find(call =>
        call.command === "open_project" && call.args.path === ${e(path)}).completed`);
      const native = await captureNative(cdp, name, legacySolid.nativeView, { start, openedAt });
      assert.deepEqual(native.rendered.args.view, legacySolid.nativeView);
      await click(cdp, '.viewport-toolbar [aria-label="Viewport mode"] button', "Solid");
      const solid = await capture(cdp, name + "-solid", `s.projectId === ${e(cold.id)} && s.object?.visible`,
        true, 0, { strictSettings: false });
      assert.deepEqual(solid.query, legacySolid.query);
      coldOpens.push({ withCamera, native, solid });
      await closeProject(cdp);
    }
    assert.equal(hash(await readFile(legacyPath)), legacyFixture.sha256);
    report.checks.legacyRemoteNative = { passed: true, fixture: legacyFixture, span: fixture.oracle.span, legacySolid,
      initialNative, coldOpens };
  } finally {
    remote.close();
  }
}

function magentaPixels(png) {
  const { data } = decodePng(png);
  let count = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i] > data[i + 1] + 24 && data[i + 2] > data[i + 1] + 24) count++;
  }
  return count;
}

async function captureCube(cdp, name, state) {
  assert.ok(state.editor && state.successfulWebGL > 0);
  const png = await cdp.screenshot(state.css);
  const pixels = magentaPixels(png);
  assert.ok(pixels > 400, name + " must display the magenta VP-01 cube");
  await writeFile(join(out, name + ".png"), png);
  return { ...state, magentaPixels: pixels, png: name + ".png" };
}

async function regressions(cdp) {
  const hybrid = await settle(cdp, `s.backend === "Viewport forge3d-web · WebGPU available" && s.editor && s.submission?.terrain &&
    forge3dViewportDiagnostics().terrainViewport.diagnosticAppearance?.drape?.settled`, "Hybrid Bryce");
  const hybridCube = await captureCube(cdp, "hybrid-bryce", hybrid);
  // Leave the WebGPU canvas visible and cover only the three.js editor layer.
  await cdp.evaluate('forge3dViewportDiagnostics().runtime.renderer.domElement.style.visibility = "hidden"');
  let noEditor;
  try {
    await cdp.evaluate(raf);
    noEditor = await cdp.screenshot(hybrid.css);
  } finally {
    await cdp.evaluate('forge3dViewportDiagnostics().runtime.renderer.domElement.style.visibility = ""');
  }
  assert.ok(magentaPixels(noEditor) < hybridCube.magentaPixels * 0.05, "The cube must come from the editor layer");
  await writeFile(join(out, "hybrid-bryce-without-editor.png"), noEditor);
  report.checks.hybrid = { passed: true, fixture: report.fixtures.hybrid.identity, ...hybridCube };

  await chooseRenderer(cdp, "three.js");
  const override = await settle(cdp, 's.backend?.includes("three.js · View menu override") && !s.liveRuntimes.length', "three.js override");
  report.checks.override = { passed: true, ...await captureCube(cdp, "explicit-three", override) };
  const injected = "VP-03 forced creation failure";
  await cdp.evaluate(`__vp03.createFailure = ${e(injected)}`);
  await chooseRenderer(cdp, "Auto");
  const fallback = await settle(cdp, `s.backend?.includes("three.js · WebGPU startup failed") && s.backend.includes(${e(injected)}) &&
    !s.liveRuntimes.length`, "Auto fallback");
  report.checks.fallback = { passed: true, ...await captureCube(cdp, "auto-webgpu-failure", fallback) };

  await cdp.evaluate("delete __vp03.createFailure");
  await chooseRenderer(cdp, "three.js");
  await settle(cdp, 's.backend?.includes("View menu override")', "Reset WebGPU creation");
  await chooseRenderer(cdp, "Auto");
  await settle(cdp, 's.backend === "Viewport forge3d-web · WebGPU available" && s.submission?.terrain', "Restored Auto");
  const fixture = report.fixtures.native;
  await openAction(cdp, fixture);
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 420, mobile: false, deviceScaleFactor: 1 });
  try {
    await nativeHandoff(cdp, fixture);
  } finally {
    await cdp.send("Emulation.clearDeviceMetricsOverride");
  }
}

async function nativeHandoff(cdp, fixture) {
  const initial = await settle(cdp, `s.projectId === ${e(fixture.id)} && s.backend === ${e(ready)} && s.submission?.terrain`,
    "Native handoff fixture");
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: initial.css.x + initial.css.width / 2,
    y: initial.css.y + initial.css.height / 2, deltaX: 0, deltaY: -120 });
  const before = await settle(cdp, `s.submission?.sequence > ${initial.submission.sequence} &&
    s.nativeView?.radius !== ${e(initial.nativeView.radius)}`, "Live camera zoom before native handoff");
  report.checks.native = { passed: true, fixture, initialCamera: initial.nativeView, ...await captureNative(cdp, "native", before.nativeView) };
}

async function captureNative(cdp, name, view, directOpen) {
  const start = directOpen?.start ?? await cdp.evaluate("__vp03.ipc.length");
  if (!directOpen) {
    await click(cdp, '.viewport-toolbar [aria-label="Viewport mode"] button', "Rendered");
  }
  const renderedImage = 'document.querySelector(".viewport-rendered img")?.naturalWidth > 0';
  const previewError = 'document.querySelector(".viewport-problem")?.textContent';
  const firstPreview = await until(cdp, `(${renderedImage}) ? "frame" :
    (${previewError})`, "Native Rendered frame " + name, 120_000);
  const coldTimeout = firstPreview.includes("the renderer did not answer in time");
  assert.ok(firstPreview === "frame" || coldTimeout, firstPreview);
  const output = join(out, name + "-export.png");
  await queuePicker(cdp, "save", output);
  await click(cdp, '[title^="Render a full-resolution still"]');
  const still = await until(cdp, `__vp03.ipc.slice(${start}).find(call => call.command === "render_still" && call.completed)`, "Native still " + name, 200_000);
  assert.ok(still.ok, "Studio did not complete the native still");
  if (coldTimeout) {
    // A cold native pipeline can exceed the interactive deadline. The still
    // has a longer deadline and warms the renderer before a normal retry.
    await click(cdp, ".viewport-rendered button", "Re-render");
    await until(cdp, renderedImage, "Native Rendered frame after still export", 120_000);
  }
  const native = await settle(cdp, 's.backend?.includes("Viewport native") && !s.liveRuntimes.length', "Native backend");
  const screenshot = name + "-rendered.png";
  await writeFile(join(out, screenshot), await cdp.screenshot(native.css));
  const calls = await cdp.evaluate(`__vp03.ipc.slice(${start}).filter(call => call.started > ${directOpen?.openedAt ?? 0})`);
  const firstRequest = calls.find(call => call.command === "render_frame");
  assert.deepEqual(firstRequest?.args.view, view);
  const rendered = calls.findLast(call => call.render && call.command === "render_frame");
  const exportCall = calls.findLast(call => call.render && call.command === "render_still");
  for (const call of [rendered, exportCall]) {
    assert.equal(call?.render.renderPath, "mapscene");
    assert.deepEqual(call.args.view, view);
  }
  const sidecar = join(out, name + "-export.json");
  const description = await json(sidecar);
  assert.equal(description.renderer, "forge3d.mapscene.render");
  requireNativeCamera(description.camera, view);
  const png = decodePng(await readFile(output));
  assert.deepEqual([png.width, png.height], [description.width, description.height]);
  return { rendered, exportCall, firstPreview, camera: description.camera, backend: native.backend, screenshot, output, sidecar };
}

// Hold the real GPUBuffer.mapAsync before it resolves inside WASM. A timer
// around the outer read promise would leave the native runtime idle.
async function holdGpuRead(cdp) {
  await cdp.evaluate("(" + (() => {
    const runtime = forge3dViewportDiagnostics().terrainViewport.diagnosticRuntime;
    const map = GPUBuffer.prototype.mapAsync;
    GPUBuffer.prototype.mapAsync = function (mode, ...args) {
      if (!(mode & GPUMapMode.READ)) return map.call(this, mode, ...args);
      GPUBuffer.prototype.mapAsync = map;
      return new Promise((resolve, reject) => {
        __vp03.releaseMap = () => {
          delete __vp03.releaseMap;
          try { resolve(map.call(this, mode, ...args)); } catch (error) { reject(error); }
        };
      });
    };
    const outcome = operation => operation.then(value => ({ length: value.length }), error => ({ error: error.code }));
    __vp03.reads = Promise.all([outcome(runtime.readRgba()), outcome(runtime.readTerrainHeights())]);
  }).toString() + ")()");
  await until(cdp, "!!__vp03.releaseMap", "GPU buffer read held inside WASM");
}

async function releaseGpuRead(cdp) {
  return cdp.evaluate("(__vp03.releaseMap(), __vp03.reads)");
}

function readGpuGrid(cdp) {
  return cdp.evaluate("(" + (async () => {
    const heights = await forge3dViewportDiagnostics().terrainViewport.diagnosticRuntime.readTerrainHeights();
    const side = Math.sqrt(heights.length);
    const mid = side / 2;
    const center = [mid - 1, mid].flatMap(z => [mid - 1, mid].map(x => heights[z * side + x]));
    const digest = await crypto.subtle.digest("SHA-256", heights);
    return { side, length: heights.length, center: center.reduce((a, b) => a + b) / 4,
      sha256: [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("") };
  }).toString() + ")()");
}

async function uploadDuringRead(cdp, fixtures) {
  await open(cdp, fixtures.native);
  const rows = [];
  for (const reject of [false, true]) {
    await setPreviewResolution(cdp, 96);
    const prior = await capture(cdp, "upload-before-" + reject, "s.accepted?.resolution === 96", true);
    const oldGrid = await readGpuGrid(cdp);
    assert.equal(oldGrid.sha256, prior.uploadEvidence.acceptedSha256);
    assert.ok(Math.abs(oldGrid.center - prior.query.elevation) < 1e-6);
    await holdGpuRead(cdp);
    let held, reads;
    try {
      if (reject) await cdp.evaluate("__vp03.rejectUploadWidth = 256");
      await setPreviewResolution(cdp, 256);
      held = await settle(cdp, 's.accepted?.resolution === 256 && s.backend?.includes("Waiting for WebGPU frame")',
        "Accepted revision waiting on readback");
      assert.equal(held.query, null);
      assert.ok(!held.submission && !held.canvasVisible);
      assert.equal(held.lastUpload.at, prior.lastUpload.at);
      assert.equal(held.successfulFrame.at, prior.successfulFrame.at);
    } finally { reads = await releaseGpuRead(cdp); }
    assert.equal(reads[0].length, prior.dimensions.width * prior.dimensions.height * 4);
    assert.equal(reads[1].length, 96 * 96);
    if (reject) {
      const failed = await settle(cdp, 's.backend?.includes("heights length must equal width * height") && !s.liveRuntimes.length',
        "Native upload failure reaches Studio");
      assert.ok(!failed.submission && !failed.canvasVisible && !failed.query);
      const retired = await cdp.evaluate(`__vp03.runtimes.find(r => r.id === ${prior.runtime})`);
      assert.ok(retired.rejectedUpload && retired.disposed > retired.rejectedUpload.at);
      assert.ok(failed.backend.includes(retired.rejectedUpload.reason));
      assert.ok(retired.uploads.at(-1).width === 96 && retired.frames.every(frame => frame.at < retired.rejectedUpload.at));
      await setPreviewResolution(cdp, 96);
      const recovered = await capture(cdp, "upload-recovered", "s.accepted?.resolution === 96", true);
      assert.equal(recovered.uploadEvidence.acceptedSha256, oldGrid.sha256);
      rows.push({ reject, oldGrid, held, reads, failed, retired, recovered });
    } else {
      const success = await capture(cdp, "upload-committed", "s.accepted?.resolution === 256", true);
      const gpu = await readGpuGrid(cdp);
      assert.deepEqual([gpu.side, gpu.length], [256, 256 * 256]);
      assert.equal(gpu.sha256, success.uploadEvidence.acceptedSha256);
      assert.ok(Math.abs(gpu.center - success.query.elevation) < 1e-6);
      assert.notEqual(gpu.center, oldGrid.center);
      rows.push({ reject, oldGrid, held, reads, success, gpu });
    }
  }
  report.checks.uploadDuringRead = { passed: true, rows };
  await closeProject(cdp);
}

async function retireDuringRead(cdp, fixtures) {
  const rows = [];
  for (const action of ["hide", "delete", "replace", "unmount"]) {
    await open(cdp, fixtures.native);
    const before = await capture(cdp, "retire-before-" + action, "s.object?.visible", true);
    await holdGpuRead(cdp);
    let held, reads;
    try {
      if (action === "hide") await hideTerrain(cdp);
      else if (action === "delete") await deleteTerrain(cdp);
      else if (action === "replace") await openAction(cdp, fixtures.empty["late-project-b"]);
      else await closeAction(cdp);
      await until(cdp, `__vp03.runtimes.find(r => r.id === ${before.runtime})?.disposeRequested`, "Revoke populated owner");
      await cdp.evaluate(raf);
      held = await snapshot(cdp);
      assert.equal(held.query, null);
      assert.ok(!held.submission && !held.runtime);
      assert.deepEqual(held.liveRuntimes, [before.runtime]);
      assert.deepEqual(held.liveContexts, action === "unmount" ? [] : [before.context]);
      const owners = await cdp.evaluate("__vp03.runtimes");
      assert.ok(!owners.at(-1).disposed && owners.at(-1).id === before.runtime, "A replacement began before native disposal");
    } finally { reads = await releaseGpuRead(cdp); }
    assert.deepEqual(reads, [{ error: "RUNTIME_DISPOSED" }, { error: "RUNTIME_DISPOSED" }]);
    const old = await until(cdp, `__vp03.runtimes.find(r => r.id === ${before.runtime} && r.disposed)`, "Native WASM disposal");
    assert.ok(old.nativeReady < old.disposeRequested && old.disposeRequested < old.disposed);
    let clean;
    if (action === "unmount") {
      clean = await settle(cdp, "!window.forge3dViewportDiagnostics && !s.liveRuntimes.length && !s.liveContexts.length", "Unmount drained");
    } else {
      clean = await capture(cdp, "retire-clean-" + action, "!s.object?.visible", false);
      const owner = await cdp.evaluate(`__vp03.runtimes.find(r => r.id === ${clean.runtime})`);
      assert.ok(old.disposed < owner.create && owner.create < owner.nativeReady);
      assert.equal(old.canvas, owner.canvas);
      assert.equal(old.context, owner.context);
      assert.equal(clean.maskCount, 0);
      await closeProject(cdp);
    }
    rows.push({ action, before, held, reads, old, clean });
  }
  report.checks.nativeRetirement = { passed: true, rows };
}

async function writeProbeProject(project, name) {
  project.id = randomUUID();
  project.name = "VP-03 " + name;
  const path = join(out, name + ".studio3d");
  await writeFile(path, e(project, null, 2) + "\n");
  return { path, id: project.id };
}

async function recoverSceneErrors(cdp, fixtures) {
  const project = await json(fixtures.native.path);
  const terrain = project.scene.objects.find(o => o.kind.type === "terrain");
  terrain.transform.translation = { x: 1e9, y: 1e9, z: 1e9 };
  const rows = [];
  for (const action of ["hide", "delete"]) {
    const fixture = await writeProbeProject(project, "far-" + action);
    await openAction(cdp, fixture);
    const failed = await settle(cdp, `s.projectId === ${e(fixture.id)} && s.backend?.includes("camera target must differ from position") && !s.liveRuntimes.length`,
      "Translated DEM triggers native camera validation");
    assert.ok(!failed.submission && !failed.query);
    if (action === "hide") await hideTerrain(cdp);
    else await deleteTerrain(cdp);
    const clean = await capture(cdp, "recovered-far-" + action, action === "hide" ? "s.object?.visible === false" : "!s.object", false);
    assert.equal(clean.maskCount, 0);
    assert.equal(clean.projectGeneration, failed.projectGeneration);
    rows.push({ action, failed, clean });
    await closeProject(cdp);
  }
  report.checks.sceneErrorRecovery = { passed: true, rows };
}

function renderedSizeOptions(cdp) {
  // A render finishing changes the width of the centered bar. Activate its
  // actual button and inspect the options after React has opened the menu.
  return until(cdp, `(() => {
    const trigger = document.querySelector(".viewport-rendered__scale-button");
    if (!trigger || trigger.disabled || !trigger.getClientRects().length) return null;
    if (trigger.getAttribute("aria-expanded") !== "true") {
      trigger.click();
      return null;
    }
    const options = [...document.querySelectorAll(".viewport-rendered__menu button")].map(button => button.textContent.trim());
    return options.length && options;
  })()`, "Open Rendered size menu");
}

async function visibleNativeSize(cdp, fixtures) {
  const project = await json(fixtures.native.path);
  const visible = project.scene.objects.find(o => o.kind.type === "terrain");
  const asset = { ...project.assets.find(a => a.id === visible.kind.asset), id: randomUUID(), name: "hidden-128.tif",
    path: fixtures.controls.hiddenSmall.path, byteSize: (await readFile(fixtures.controls.hiddenSmall.path)).length };
  const hidden = { ...structuredClone(visible), id: randomUUID(), name: "Hidden 128 DEM", visible: false };
  hidden.kind.asset = asset.id;
  hidden.kind.dimensions = [128, 128];
  project.assets.push(asset);
  project.scene.objects.unshift(hidden);
  const fixture = await writeProbeProject(project, "hidden-first-native-size");
  await open(cdp, fixture);
  const solid = await capture(cdp, "native-size-solid", `s.submission?.terrain?.objectId === ${e(visible.id)}`, true);
  const start = await cdp.evaluate("__vp03.ipc.length");
  await click(cdp, '.viewport-toolbar [aria-label="Viewport mode"] button', "Rendered");
  const label = (await renderedSizeOptions(cdp)).find(option => option.startsWith("DEM ("));
  assert.equal(label, "DEM (1024 × 1024)");
  await click(cdp, ".viewport-rendered__menu button", label);
  const call = await until(cdp, `__vp03.ipc.slice(${start}).findLast(i => i.command === "render_frame" && i.args.width === 1024 && i.args.height === 1024 && i.completed)`,
    "Completed visible DEM-sized request", 150_000);
  assert.ok(call.ok);
  assert.equal(call.render.renderPath, "mapscene");
  assert.deepEqual([call.render.width, call.render.height], [1024, 1024]);
  assert.deepEqual(call.args.view, solid.nativeView);
  const data = await until(cdp, '(() => {const img = document.querySelector(".viewport-rendered img"); return img?.naturalWidth === 1024 && img.naturalHeight === 1024 && img.src.split(",")[1]})()',
    "Displayed 1024 pixel native PNG");
  const bytes = Buffer.from(data, "base64");
  const pixels = decodePng(bytes);
  assert.deepEqual([pixels.width, pixels.height], [1024, 1024]);
  assert.ok(new Set(pixels.data).size > 32, "Native image must contain visible detail");
  const file = "visible-dem-native.png";
  await writeFile(join(out, file), bytes);
  await hideTerrain(cdp);
  await settle(cdp, "!s.object?.visible && !s.nativeView", "All DEMs hidden");
  const emptyOptions = await renderedSizeOptions(cdp);
  assert.deepEqual(emptyOptions, ["1× viewport", "2× viewport", "4× viewport",
    `Project (${project.render.width} × ${project.render.height})`]);
  report.checks.visibleNativeSize = { passed: true, fixture, hidden: hidden.kind.dimensions, visible: visible.kind.dimensions,
    label, call, file, pngSha256: hash(bytes), emptyOptions };
  await closeProject(cdp);
}

// Interpolate the actual height buffer in the untransformed Bryce footprint.
async function compareBudgetVertices(cdp, side) {
  const result = await cdp.evaluate("(" + (async () => {
    const d = forge3dViewportDiagnostics(), runtime = d.terrainViewport.diagnosticRuntime;
    const geometry = runtime.getTerrainGeometryReport(), memory = runtime.getMemoryReport();
    const [width, height] = geometry.shadowCasterResolution;
    const heights = await runtime.readTerrainHeights();
    const fractions = [[37, 47], [36, 74], [73, 49], [91, 81], [125, 117], [15, 101]].map(([i,j]) => [i/147,j/147]);
    fractions.push([0.5, 0.5], [2/3, 0.5]);
    const samples = fractions.map(([u, v]) => {
      const point = [(u - 0.5) * 12, (v - 0.5) * 11.4];
      const x = u*(width-1), y = v*(height-1), i = Math.floor(x), j = Math.floor(y);
      const at = j*width+i, fx = x-i, fy = y-j;
      const north = heights[at]*(1-fx) + heights[at+1]*fx;
      const south = heights[at+width]*(1-fx) + heights[at+width+1]*fx;
      const gpu = north*(1-fy) + south*fy;
      const hit = d.queryTerrain(...point);
      return { point, gpu, elevation: hit?.elevation, gridPosition: hit?.gridPosition, expectedPosition: [x,y] };
    });
    return { width, height, count: heights.length, geometry, memory, samples };
  }).toString() + ")()");
  assert.deepEqual([result.width, result.height, result.count], [side, side, side*side]);
  for (const sample of result.samples) {
    assert.ok(Math.abs(sample.gpu - sample.elevation) < 0.001, "Active query differs from GPU elevation at " + sample.point);
    assert.ok(sample.gridPosition.every((v, i) => Math.abs(v - sample.expectedPosition[i]) < 1e-6));
  }
  return result;
}

async function nativeTerrainBudget(cdp, fixtures, editor = false) {
  const budget = 2 * 1024 * 1024;
  const rows = [];
  let tightBudget;
  for (const limited of editor ? [true] : [false, true]) {
    await cdp.evaluate(`__vp03.memoryOptions = ${limited ? e({memoryBudgetBytes:budget}) : "undefined"}`);
    await open(cdp, fixtures.native);
    if (editor) await disableEditorAxes(cdp);
    await setPreviewResolution(cdp, 96);
    const before = await capture(cdp, "budget-96-" + limited + "-" + editor, "s.accepted?.resolution === 96", true, 0, { editor, compositorOnly: limited });
    const memory = await cdp.evaluate("forge3dViewportDiagnostics().terrainViewport.diagnosticRuntime.getMemoryReport()");
    tightBudget ??= memory.currentBytes + 64*1024;
    const projectBefore = (await projectState(cdp)).project;
    await setPreviewResolution(cdp, 256);
    const side = limited ? 148 : 256;
    const status = limited ? ready + " · 148 × 148 terrain (256 × 256 requested)" : ready;
    const after = await capture(cdp, "budget-" + side + "-" + editor, `s.accepted?.resolution === ${side}`, true, before.submission.sequence, { status, editor, compositorOnly: limited });
    const vertices = await compareBudgetVertices(cdp, side);
    assert.ok(Math.abs(vertices.samples[0].elevation - (limited ? 2335.640 : 2341.779)) < 0.001);
    const owner = await cdp.evaluate(`__vp03.runtimes.find(r => r.id === ${after.runtime})`);
    assert.equal(before.runtime, after.runtime);
    let editorMesh;
    if (limited) {
      const saved = (await projectState(cdp)).project;
      assert.deepEqual(saved.assets, projectBefore.assets);
      assert.deepEqual(saved.scene.objects, projectBefore.scene.objects);
      assert.deepEqual(saved.viewport, projectBefore.viewport);
      assert.deepEqual(saved.render, projectBefore.render);
      const span = grid => grid.spacing.map((value, axis) => value * ([grid.width, grid.height][axis] - 1));
      const startSpan = span(before.uploadEvidence.acceptedGeometry);
      const endSpan = span(after.uploadEvidence.acceptedGeometry);
      assert.ok(endSpan.every((value, i) => Math.abs(value - startSpan[i]) < 1e-6 * startSpan[i]));
      assert.equal(vertices.memory.budgetBytes, budget);
      assert.equal(after.submission.requestedTerrainResolution, 256);
      const first = owner.uploads.find(upload => upload.width === 256);
      assert.deepEqual(first.committedGrid, [148,148]);
      assert.deepEqual([owner.uploads.at(-1).width, owner.uploads.at(-1).height], [148,148]);
      assert.ok(!owner.frames.some(frame => frame.submitted && frame.at > first.at && frame.at < owner.uploads.find(upload => upload.width === 148).at));
      if (editor) {
        editorMesh = await cdp.evaluate(`(() => { const d=forge3dViewportDiagnostics(), id=${e(after.object.id)};
          const node=d.runtime.objects.get(id).children.find(c=>c.userData.forgeTerrain===d.frame.terrains.get(id));
          return {vertices:node.geometry.getAttribute("position").count, resolution:node.userData.forgeTerrain.preview.resolution}; })()`);
        assert.deepEqual(editorMesh, { vertices:148*148, resolution:148 });
      }
      // A different owner can honor the same saved sampling preference at full resolution.
      await chooseRenderer(cdp, "three.js");
      await settle(cdp, 's.backend?.includes("View menu override") && !s.liveRuntimes.length', "Retire the budget-limited owner");
      await cdp.evaluate("delete __vp03.memoryOptions");
      await chooseRenderer(cdp, "Auto");
      const restored = await capture(cdp, "budget-restored-" + editor, "s.accepted?.resolution === 256", true, 0, { editor });
      assert.equal(restored.submission.requestedTerrainResolution, undefined);
    }
    rows.push({ limited, before, after, owner, vertices, editorMesh });
    await setPreviewResolution(cdp, 96);
    await settle(cdp,"s.submission?.terrain?.resolution === 96","Restore starting resolution");
    await closeProject(cdp);
  }
  report.checks[editor ? "editorBudgetAdmission" : "budgetAdmission"] = { passed:true, rows };
  return tightBudget;
}

async function rejectedTerrainBudget(cdp, fixtures, budget) {
  const rows = [];
  for (const [policy, hold, action] of [["downscale",true,"hide"], ["reject",true,"delete"], ["reject",false,"hide"]]) {
    await cdp.evaluate(`__vp03.memoryOptions = ${e({memoryBudgetBytes:budget,overflowPolicy:policy})}`);
    await open(cdp, fixtures.native);
    await setPreviewResolution(cdp, 96);
    const before = await settle(cdp,"s.submission?.terrain?.resolution === 96 && s.query", "Affordable initial terrain");
    if (hold) await holdGpuRead(cdp);
    let waiting;
    try {
      await setPreviewResolution(cdp, 256);
      if (hold) {
        waiting = await settle(cdp,'s.accepted?.resolution===256 && s.backend?.includes("Waiting for WebGPU frame")',"Budget upload waiting on read");
        assert.ok(!waiting.submission && !waiting.query);
      }
    } finally { if (hold) await releaseGpuRead(cdp); }
    const failed = await settle(cdp,'s.backend?.includes("RESOURCE_LIMIT_EXCEEDED") && !s.liveRuntimes.length',"Rejected real memory admission");
    const retired = await cdp.evaluate(`__vp03.runtimes.find(r=>r.id===${before.runtime})`);
    assert.equal(retired.rejectedUpload.code, "RESOURCE_LIMIT_EXCEEDED");
    assert.ok(failed.backend.includes(retired.rejectedUpload.reason));
    assert.ok(!failed.submission && !failed.query && !failed.canvasVisible);
    assert.ok(retired.disposed > retired.rejectedUpload.at);
    if (action === "hide") await hideTerrain(cdp); else await deleteTerrain(cdp);
    const clean = await capture(cdp, "budget-error-" + policy + "-" + hold, "!s.object?.visible", false, 0, { compositorOnly: true });
    assert.ok(clean.runtime !== before.runtime && clean.context === before.context && clean.display.changed === 0);
    if (action === "hide") {
      await deleteTerrain(cdp);
      const deleted = await capture(cdp, "budget-error-deleted-" + policy, "!s.object", false, 0, { compositorOnly: true });
      assert.equal(deleted.runtime, clean.runtime);
    }
    rows.push({ policy, hold, action, before, waiting, failed, retired, clean });
    await closeProject(cdp);
  }
  await cdp.evaluate("delete __vp03.memoryOptions");
  report.checks.rejectedTerrainBudget = { passed:true, budget, rows };
}

async function holdAdmissionRead(cdp) {
  await cdp.evaluate("(" + (() => {
    const map = GPUBuffer.prototype.mapAsync;
    GPUBuffer.prototype.mapAsync = function(mode,...args) {
      const upload = __vp03.runtimes.at(-1)?.uploads.at(-1);
      if (!(mode & GPUMapMode.READ) || upload?.width !== 256 || upload.committedGrid[0] !== 148) return map.call(this,mode,...args);
      GPUBuffer.prototype.mapAsync = map;
      return new Promise((resolve,reject) => {
        __vp03.releaseAdmission = () => {
          delete __vp03.releaseAdmission;
          try { resolve(map.call(this,mode,...args)); } catch (error) { reject(error); }
        };
      });
    };
  }).toString() + ")()");
  await setPreviewResolution(cdp, 256);
  return settle(cdp,"!!__vp03.releaseAdmission && s.accepted?.resolution===256 && !s.submission && !s.query","Real downscaled height read held");
}

async function interruptedAdmission(cdp, fixtures) {
  await cdp.evaluate("__vp03.memoryOptions = { memoryBudgetBytes: 2097152 }");
  await open(cdp, fixtures.native);
  await setPreviewResolution(cdp, 96);
  const before = await settle(cdp,"s.submission?.terrain?.resolution===96 && s.query","Current terrain before admission read");
  const held = await holdAdmissionRead(cdp);
  await openAction(cdp, fixtures.empty["late-project-b"]);
  const replacement = await settle(cdp,`s.projectId === ${e(fixtures.empty["late-project-b"].id)} && !s.runtime && !s.submission`, "Replace before effective heights arrive");
  assert.deepEqual(replacement.liveRuntimes,[before.runtime]);
  assert.equal(replacement.query,null);
  await cdp.evaluate("__vp03.releaseAdmission()");
  const clean = await capture(cdp,"budget-stale-admission","!s.object",false,0,{ compositorOnly: true });
  assert.notEqual(clean.projectGeneration,held.projectGeneration);
  assert.equal(clean.display.changed,0);
  assert.deepEqual(clean.liveRuntimes,[clean.runtime]);
  await closeProject(cdp);
  await cdp.evaluate("delete __vp03.memoryOptions");
  report.checks.interruptedAdmission = { passed:true, before, held, replacement, clean };
}

// A native owner may outlive its React host and its disconnected canvas.
async function openWhileRetiring(cdp, project, oldRuntime) {
  await openAction(cdp, project);
  await settle(cdp, `s.projectId === ${e(project.id)} && s.camera && s.dimensions`, "Replacement viewport mounted");
  await cdp.evaluate(raf);
  const state = await snapshot(cdp);
  const owners = await cdp.evaluate("__vp03.runtimes");
  assert.equal(owners.at(-1).id, oldRuntime, "Replacement creation began before the previous native runtime retired");
  assert.deepEqual(state.liveRuntimes, [oldRuntime]);
  assert.deepEqual(state.liveContexts, []);
  assert.ok(!state.runtime && !state.submission && !state.canvasVisible && !state.query);
  return state;
}

async function closeViewportHost(cdp) {
  await closeAction(cdp);
  return settle(cdp, "!window.forge3dViewportDiagnostics", "File Close removed the viewport host");
}

async function remountViewport(cdp, fixtures, mode) {
  const empty = fixtures.empty["five-states"];
  const admission = mode === "admission";
  let oldRuntime, initial;
  if (mode === "creation") {
    await cdp.evaluate("__vp03.holdCreation = true");
    await openAction(cdp, fixtures.empty["late-project-a"]);
    const held = await until(cdp, "__vp03.releaseCreation && __vp03.runtimes.at(-1)", "Hold A's created native instance");
    assert.ok(held.nativeReady && !held.disposed);
    oldRuntime = held.id;
  } else {
    if (admission) await cdp.evaluate("__vp03.memoryOptions = { memoryBudgetBytes: 2 * 1024 * 1024 }");
    await open(cdp, fixtures.native);
    await setPreviewResolution(cdp, 96);
    initial = await settle(cdp, "s.submission?.terrain?.resolution === 96 && s.query", "Bryce submitted at 96 × 96");
    oldRuntime = initial.runtime;
    if (admission) await holdAdmissionRead(cdp);
    else await holdGpuRead(cdp);
  }

  let closed, waiting, superseded, reads;
  try {
    if (mode === "control") reads = await releaseGpuRead(cdp);
    if (mode === "diagnostic") {
      await chooseRenderer(cdp, "three.js");
      await settle(cdp, "!s.runtime && !s.submission && !s.query", "Release the adapter before closing its host");
      await chooseRenderer(cdp, "Auto");
    }
    await cdp.evaluate("delete __vp03.memoryOptions");
    closed = await closeViewportHost(cdp);
    assert.deepEqual(closed.liveContexts, []);
    if (mode === "control") {
      assert.deepEqual(closed.liveRuntimes, []);
      await openAction(cdp, empty);
    } else {
      assert.deepEqual(closed.liveRuntimes, [oldRuntime]);
      if (mode === "creation") {
        superseded = await openWhileRetiring(cdp, fixtures.empty["late-project-b"], oldRuntime);
        await closeViewportHost(cdp);
      }
      waiting = await openWhileRetiring(cdp, empty, oldRuntime);
    }
  } finally {
    if (admission) await cdp.evaluate("__vp03.releaseAdmission()");
    else if (mode === "creation") await cdp.evaluate("__vp03.releaseCreation()");
    else if (mode === "diagnostic") reads = await releaseGpuRead(cdp);
  }

  if (mode === "diagnostic") assert.deepEqual(reads, [{ error: "RUNTIME_DISPOSED" }, { error: "RUNTIME_DISPOSED" }]);
  if (mode === "control") assert.ok(reads.every(result => result.length > 0));
  const frames = [];
  if (admission) {
    await captureFiveStates(cdp, fixtures, frames, "remount-");
    for (const step of [frames[1], frames[3]]) {
      assert.equal(step.accepted.resolution, 256);
      assert.ok(Math.abs(step.query.elevation - 2273.8750610351562) < 0.0005);
    }
  } else {
    frames.push(await capture(cdp, "remount-" + mode, `s.projectId === ${e(empty.id)} && !s.object`, false));
  }
  const unmounted = await closeProject(cdp);
  assert.deepEqual(unmounted.liveContexts, []);
  const owners = await cdp.evaluate(`__vp03.runtimes.filter(r => r.id >= ${oldRuntime})`);
  const [old, next] = owners;
  assert.equal(next.id, frames[0].runtime);
  assert.notEqual(next.canvas, old.canvas);
  assert.notEqual(next.context, old.context);
  assert.ok(old.nativeReady < old.disposed && old.disposed < next.create);
  if (mode === "creation") assert.deepEqual(old.frames, []);
  for (const [index, owner] of owners.entries()) {
    assert.ok(owner.nativeReady && owner.disposed);
    if (index > 0) assert.ok(owners[index - 1].disposed < owner.create, "Native viewport lifetimes overlapped");
  }
  report.checks["remount-" + mode] = { passed: true, initial, closed, waiting, superseded, reads, frames, owners, unmounted };
}

async function writeEvidence() {
  const sources = report.served;
  const table = [
    "| State | Project generation / revision | Terrain revision SHA-256 prefix | Physical size | Backend | Submission / event | Runtime / context | Successful WebGL | Readback pixels | Display pixels | Compositor color matches | Query |",
    "| --- | --- | --- | --- | --- | --- | --- | ---: | ---: | ---: | ---: | --- |",
    ...report.steps.map(row => `| ${row.name} | ${row.projectGeneration} / ${row.revision} | ${row.object ? hash(row.object.revision).slice(0, 12) : "—"} | ${row.dimensions.width} × ${row.dimensions.height} | ${row.backend} | ${row.submission.sequence} / ${row.successfulFrame.at} | ${row.runtime} / ${row.context} | ${row.successfulWebGL} | ${row.maskCount} | ${row.display.changed} | ${row.display.opaque ? `${row.display.matchingColor} / ${row.display.opaque}` : "—"} | ${row.query ? `Hit, ${row.query.elevation.toFixed(3)} m` : "Miss"} |`),
  ];
  const metadata = [
    ["Studio base", report.base],
    ["Desktop shell SHA-256", report.shell?.sha256],
    ["Native source SHA-256", report.shell?.expectedNativeSource],
    ["CDP endpoint", report.endpoint],
    ["Runtime revision", sources?.provenance.commit],
    ["Archive SHA-256", sources?.provenance.sha256],
    ["Served Viewport3D.tsx SHA-256", sources?.sources["src/viewport/Viewport3D.tsx"].sourceSha256],
    ["First-party executables verified", sources && Object.keys(sources.sources).length],
    ["Viewport runtime files observed", sources && Object.keys(sources.executedRuntime).length],
    ["DEM fixture", report.fixtures?.sample],
    ["DEM SHA-256", report.fixtures?.demSha256],
    ["Empty fixture SHA-256", report.fixtures?.empty["five-states"].sha256],
    ["Renderer and mode", report.toggles && "Auto, Solid"],
    ["Disabled settings", report.toggles && "Sun shadows, Terrain sun shadows, custom HDRI, imagery, cartography, hillshade and grids"],
    ["Desktop", report.webview?.product],
    ["Native engine", report.engine && `Forge3D ${report.engine.packageVersion} · ${report.engine.backend} · ${report.engine.adapter}`],
  ].map(([field, value]) => `| ${field} | ${value ?? "unverified"} |`);
  const md = ["# VP-03 desktop viewport evidence", "", "| Evidence | Value |", "| --- | --- |", ...metadata, "",
    `Five-state test **${report.checks.fiveStates?.passed ? "passed" : "incomplete"}**`, "",
    ...table, "", ...Object.entries(report.checks).map(([name, result]) => `- ${name} ${result.passed ? "passed" : "failed"}`), "",
    `Unexercised cases ${report.unexercised.join(", ") || "none"}`, "",
    "The JSON records full revision values, served asset hashes, fixtures, settings and instance lifetimes.", ""].join("\n");
  await Promise.all([writeFile(join(out, "evidence.json"), e(report, null, 2) + "\n"), writeFile(join(out, "evidence.md"), md)]);
}

await mkdir(dirname(out), { recursive: true });
await mkdir(out);
let reference;
try {
  report.shell = { path: shell, sha256: hash(await readFile(shell)), expectedNativeSource };
  if (args["shell-sha256"]) {
    assert.equal(report.shell.sha256, args["shell-sha256"].toLowerCase(), "Native shell executable SHA-256 differs from the supplied build");
  }
  report.endpoint = endpoint.port === "0" ? "Per-lane loopback port (recorded in WebView2 flags)" : endpoint.href;
  report.fixtures = await fixtureSet();
  reference = await compileReference(root, join(out, "reference-vite-cache"));
  if (args.historical) {
    const prior = await checkBlockedCapture(resolve(args.historical));
    assert.ok(prior.pass && prior.code === "WEBGL_BLOCKED_NO_VIEWPORT");
    report.checks.historical = { passed: true, source: resolve(args.historical), ...prior };
  } else {
    report.unexercised.push("Replay of the frozen VP-01 capture");
  }
  await onDesktop("webgl-blocked", async (cdp, boot) => {
    const { measured, realms, crossFrame, ...firstDocument } = boot;
    report.target = cdp.page.url;
    report.webview = await cdp.send("Browser.getVersion");
    report.engine = await cdp.evaluate('__TAURI_INTERNALS__.invoke("forge3d_probe", {force:false})');
    report.canaries = await checkBlockedCanaries(cdp, crossFrame);
    await open(cdp, report.fixtures.empty["five-states"]);
    await fiveStates(cdp, report.fixtures);
    await matchingTerrainControls(cdp, report.fixtures);
    await cameraAndVisibilityControls(cdp, report.fixtures);
    await retiredQueryControl(cdp, report.fixtures);
    await staleGeometry(cdp, report.fixtures);
    await staleQueryHeights(cdp, report.fixtures);
    await wideFootprints(cdp, report.fixtures);
    await latePreview(cdp, report.fixtures, false);
    await latePreview(cdp, report.fixtures, true);
    await limitedPreview(cdp, report.fixtures);
    await lateCreation(cdp, report.fixtures, false);
    await lateCreation(cdp, report.fixtures, true);
    await rejectRemoteDem(cdp, report.fixtures.controls.png, "remote-invalid-format", /Expected a GeoTIFF DEM\. The source uses the PNG driver/);
    for (const [key, name] of [["rgb", "remote-rgb-tiff"], ["rgbCog", "remote-rgb-cog"]]) {
      await rejectRemoteDem(cdp, report.fixtures.controls[key], name, /single elevation band.*red, green, blue/);
    }
    await rejectRemoteDem(cdp, report.fixtures.controls.intensity, "remote-intensity-no-georeference", /missing geographic metadata/);
    await rejectRemoteDem(cdp, report.fixtures.controls.nodata, "remote-all-nodata", /no valid samples/, true);
    await editedGalleryUrl(cdp, report.fixtures);
    await remoteRoundtrip(cdp);
    if (args["public-cog"]) await publicCog(cdp);
    report.served = await verifyExecution(cdp, measured, reference, origin);
    await realms.settle();
    assert.deepEqual(realms.errors, []);
    assert.ok(realms.targets.some(target => target.type === "worker" && target.waitingForDebugger));
    report.blocked = await cdp.evaluate("({runtimes: __vp03.runtimes, ipc: __vp03.ipc, pickers: __vp03.pickers, startup: __vp01Startup})");
    report.blocked.firstDocument = firstDocument;
    report.blocked.realms = { requests: realms.requests, targets: realms.targets };
    const webgl = new Set(["webgl", "webgl2", "experimental-webgl"]);
    const entries = [...report.blocked.startup.contexts, ...realms.requests, ...Object.values(report.canaries).flatMap(realm => realm.requests ?? [])];
    for (const entry of entries.filter(entry => webgl.has(entry.requested))) assert.ok(entry.denied && entry.result === null);
    const lastByContext = new Map();
    for (const instance of report.blocked.runtimes) {
      assert.ok(instance.disposed, `Runtime ${instance.id} leaked across an unmount`);
      assert.equal(instance.queryAtDisposal, null);
      assert.equal(instance.options.devicePixelRatio, 1);
      assert.ok(instance.resizes.every(resize => resize.devicePixelRatio === 1));
      const previous = lastByContext.get(instance.context);
      if (previous) assert.ok(previous.disposed < instance.create, "Canvas recreation overlapped the previous owner");
      lastByContext.set(instance.context, instance);
    }
  });
  await onDesktop("webgl-blocked", async (cdp, { measured }) => {
    await uploadDuringRead(cdp, report.fixtures);
    await retireDuringRead(cdp, report.fixtures);
    await recoverSceneErrors(cdp, report.fixtures);
    await visibleNativeSize(cdp, report.fixtures);
    report.recoveryServed = await verifyExecution(cdp, measured, reference, origin);
    report.recoveryOwners = await cdp.evaluate("__vp03.runtimes");
    assert.ok(report.recoveryOwners.length && report.recoveryOwners.every(owner =>
      owner.nativeReady && owner.disposeRequested < owner.disposed && owner.queryAtDisposal === null));
  }, { lane: "readback-recovery" });
  await onDesktop("webgl-blocked", async (cdp, { measured }) => {
    const budget = await nativeTerrainBudget(cdp, report.fixtures);
    await rejectedTerrainBudget(cdp, report.fixtures, budget);
    await interruptedAdmission(cdp, report.fixtures);
    report.admissionServed = await verifyExecution(cdp, measured, reference, origin);
  }, { lane: "terrain-memory" });
  await onDesktop("webgl-blocked", async (cdp, { measured }) => {
    for (const mode of ["admission", "creation", "diagnostic", "control"]) {
      await remountViewport(cdp, report.fixtures, mode);
    }
    report.remountServed = await verifyExecution(cdp, measured, reference, origin);
  }, { lane: "viewport-remount" });
  // A fresh blocked document keeps the raster and native-placement controls
  // independent of the faults injected into the core lifecycle run.
  await onDesktop("webgl-blocked", async (cdp, { measured, nativeSourceSha256 }) => {
    if (args["fractional-fixture"]) {
      const path = resolve(args["fractional-fixture"]), project = await json(path);
      await open(cdp, {id:project.id, path});
      const frame = await capture(cdp, "fractional-datum", "s.object?.visible", true);
      const migrated = (await projectState(cdp)).project;
      if (project.schemaVersion < 5 && project.cartography === undefined) {
        checkToggles(migrated, true);
        assert.throws(() => checkToggles({ ...migrated, cartography: [] }, true), /Visible cartography layers/);
      }
      assert.equal(frame.uploadEvidence.heightOrigin, 4150.24);
      assert.deepEqual(frame.uploadEvidence.acceptedGeometry.domain, [0, 4150.25 - 4150.24]);
      assert.ok(Math.abs(frame.offCenter.hit.worldPosition[1] - 1.2) < 1e-6);
      assert.ok(Math.abs(frame.offCenter.hit.elevation - 4150.25) < 1e-6);
      report.checks.fractionalDatum = {passed:true, frame};
      await closeProject(cdp);
    }
    await remoteScale(cdp, report.fixtures);
    await wrongPreviewSource(cdp, report.fixtures);
    await fractionalDisplay(cdp, report.fixtures);
    await nativeTerrainPlacement(cdp, report.fixtures);
    report.terrainServed = await verifyExecution(cdp, measured, reference, origin);
    const owners = await cdp.evaluate("({runtimes:__vp03.runtimes, contexts:__vp01Startup.contexts})");
    assert.ok(owners.runtimes.length && owners.runtimes.every(runtime => runtime.disposed && runtime.queryAtDisposal === null));
    assert.ok(owners.contexts.filter(event => /^(webgl2?|experimental-webgl)$/.test(event.requested))
      .every(event => event.denied && event.result === null));
    report.terrainInputs = { nativeSourceSha256, ...owners };
  }, { lane: "terrain-inputs" });
  await onDesktop("candidate", async (cdp, { measured, realms, crossFrame, ...firstDocument }) => {
    await nativeTerrainBudget(cdp, report.fixtures, true);
    await editorSkippedFrame(cdp, report.fixtures);
    await open(cdp, { id: report.fixtures.hybrid.identity.projectId, path: report.fixtures.hybrid.path });
    await regressions(cdp);
    await editorPreviewErrors(cdp);
    report.regressionServed = await verifyExecution(cdp, measured, reference, origin);
    report.regression = await cdp.evaluate("({runtimes: __vp03.runtimes, ipc: __vp03.ipc, pickers: __vp03.pickers, startup: __vp01Startup})");
    report.regression.firstDocument = firstDocument;
  });
  const controls = [];
  for (const [lane, path, before, after] of [
    ["tamper-hillshade", "/src/viewport/hillshade.ts", "return data;", "return data.fill(0);"],
    ["tamper-camera", "/src/viewport/viewMath.ts", "spanXz ?? dimensions", "spanXz"],
  ]) {
    const alteredUpstream = await gateStudio(new URL("http://127.0.0.1:0"), upstream);
    alteredUpstream.start({ altered: { path, before, after } });
    try {
      await onDesktop("candidate", async (cdp, { measured }) => {
        await open(cdp, report.fixtures.empty["five-states"]);
        assert.equal(await cdp.evaluate("window.__vp03TamperedModule"), true);
        if (lane === "tamper-camera") {
          assert.equal(await cdp.evaluate(`(async () => {
            const { computeRenderView } = await import(${e(path)});
            return computeRenderView({camera:[9.5,7,11], aim:[0,0.8,0], fovDeg:45,
              spanXz:null, dimensions:[1024,1024], elevationRange:[0,100], zScale:1});
          })()`), null);
        }
        const response = await fetch(new URL(path, alteredUpstream.origin));
        assert.ok(response.ok);
        const altered = hash(await response.text());
        const { compilerSha256 } = await reference.get(new URL(path, origin));
        await assert.rejects(verifyExecution(cdp, measured, reference, origin), error =>
          error.code === "VP03_EXECUTABLE_MISMATCH" && error.message.endsWith(path) &&
          error.bodySha256 === altered && error.compilerSha256 === compilerSha256);
        controls.push({ path, executedAlteration: true, upstreamSha256: altered, compilerSha256 });
      }, { lane, upstreamOrigin: alteredUpstream.origin });
    } finally {
      await alteredUpstream.close();
    }
  }
  report.checks.executableTamper = { passed: true, controls };
  report.passed = true;
  console.log("VP-03 evidence in " + out);
} catch (error) {
  report.passed = false;
  report.error = error.stack;
  console.error(error);
  process.exitCode = 1;
} finally {
  await reference?.close();
  await writeEvidence();
}
