import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildShell, desktop as runDesktop, fieldCheckout, until } from "./viewport-desktop.mjs";
import { parseArgs } from "node:util";
import { createServer } from "vite";
import "./prepare-viewport-runtime.mjs";
import { FIELD_REVISION, verifyProvenance } from "./vp01/fixture.mjs";
import { installProbe } from "./vp01/page.mjs";
import { sha256 } from "./vp03/identity.mjs";
import { checkFootprint, checkPlacement, measureFootprint } from "./vp04/projection.mjs";
import { checkExaggeration, setVerticalScale } from "./vp04/exaggeration.mjs";
import { checkHover, checkRoundedMesh } from "./vp04/hover.mjs";
import { checkDatums, checkAdmission, checkRetainedCorner, checkExactEdges } from "./vp04/datum.mjs";
import { fixtures } from "./vp04/fixtures.mjs";
import { observeUpload, packagedControl, sampleStudio } from "./vp04/page.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
// The native vector preview imports Studio's Python service from the checkout.
process.env.PYTHONDONTWRITEBYTECODE = "1";
const { values } = parseArgs({ options: { field: { type: "string" }, shell: { type: "string" },
  "field-shell": { type: "string" }, "with-vp03": { type: "boolean" }, out: { type: "string" } } });
const field = fieldCheckout(root, values.field);
const out = values.out ? resolve(values.out) : await mkdtemp(join(tmpdir(), "studio-vp04-"));
if (values.out) await mkdir(out);
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const report = { base: git(root, "rev-parse", "HEAD"), field: FIELD_REVISION, runtime: await verifyProvenance(), placement: {}, poses: {} };
report.sourceSha256 = {};
for (const path of ["src/viewport/Viewport3D.tsx", "src/viewport/forge3dWebViewport.ts", "src/viewport/forge3dWebMapping.ts",
  "src/viewport/cartography.ts", "src/viewport/viewportState.ts", "src-tauri/src/studio_cog.py",
  "scripts/vp01/cdp.mjs", "scripts/vp03.mjs", "scripts/vp03/desktop.mjs", "scripts/vp03/page.mjs", "scripts/viewport-desktop.mjs", "scripts/vp04.mjs", "scripts/vp04/datum.mjs",
  "scripts/vp04/exaggeration.mjs", "scripts/vp04/fixtures.mjs", "scripts/vp04/hover.mjs", "scripts/vp04/page.mjs", "scripts/vp04/projection.mjs"]) {
  report.sourceSha256[path] = sha256(await readFile(join(root, path)));
}
const projects = await fixtures(root, out);
console.log("VP-04 evidence", out);

const desktop = (role, run, beforeStudio) => runDesktop({ root, field, out, values, report, role, beforeStudio,
  // Run the real entry only after the observers for this document are installed.
  candidatePlugins: [{ name: "vp04-observe-before-mount", transform(code, id) {
    if (id.endsWith("/src/main.tsx")) return "await window.vp04BeforeStudio();\n" + code;
  } }],
  observeCandidate: cdp => cdp.send("Page.addScriptToEvaluateOnNewDocument", { runImmediately: true,
    source: `window.vp04BeforeStudio = async () => { await window.vp04LimitBudget?.(); await (${observeUpload})(); }` }),
}, run);

async function loadProject(cdp, fixture, blocked) {
  const opened = await cdp.evaluate(`__TAURI_INTERNALS__.invoke("open_project", {path:${JSON.stringify(fixture.path)}})
    .catch(error => { throw Error(String(error)) })`);
  assert.equal(opened.project.id, fixture.id);
  await cdp.evaluate("window.vp04PreviousDocument = true");
  await cdp.send("Page.reload", { ignoreCache: true });
  await until(cdp, "!window.vp04PreviousDocument && document.readyState === 'complete'");
  await until(cdp, blocked
    ? `window.forge3dViewportDiagnostics?.().terrainViewport.diagnosticSubmission?.projectId === ${JSON.stringify(fixture.id)}
      && !!window.forge3dViewportDiagnostics().terrainViewport.diagnosticSubmission.terrain && !!window.vp04Calls?.setTerrain && !!window.vp04Calls.submittedCamera`
    : '!!window.__vp01FieldDiagnostics?.().runtime.objects.values().find(g => g.children.some(c => c.userData.elevation))');
  await cdp.evaluate(`document.querySelector('.recovery button[aria-label="Dismiss"]')?.click()`);
  await cdp.evaluate("new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))");
}

function near(actual, expected, label) {
  assert.ok(Number.isFinite(actual) && Math.abs(actual - expected) <= 1e-4, `${label}: ${actual} vs ${expected}`);
}
function vector(actual, expected, label) {
  assert.equal(actual?.length, expected.length, label);
  expected.forEach((v, i) => near(actual[i], v, label));
}

async function placements(cdp) {
  for (const name of ["identity", "placed", "exaggerated", "translated", "edge", "flat", "flatPlaced"]) {
    const fixture = name === "exaggerated" ? { ...projects.placed, zScale: 3 } : projects[name];
    if (name === "exaggerated") {
      await cdp.evaluate(`[...document.querySelectorAll('[role="tab"]')].find(el => el.textContent === "Cartography").click()`);
      await until(cdp, '!!document.querySelector(".layerrow__main")');
      await cdp.evaluate(`[...document.querySelectorAll(".layerrow__main")].find(el => el.textContent.includes("Terrain relief")).click()`);
      await setVerticalScale(cdp, until, 3);
    } else await loadProject(cdp, fixture, true);
    if (name === "edge") {
      const before = await cdp.evaluate("forge3dViewportDiagnostics().terrainViewport.diagnosticSubmission.sequence");
      await cdp.evaluate("forge3dViewportDiagnostics().setOrbitPose([12,12,56],[0,2,42])");
      await until(cdp, "forge3dViewportDiagnostics().terrainViewport.diagnosticSubmission.sequence > " + before);
    }
    if (name === "translated") {
      const before = await cdp.evaluate("forge3dViewportDiagnostics().terrainViewport.diagnosticSubmission.sequence");
      await cdp.evaluate(`(() => { const d = forge3dViewportDiagnostics(), c = d.frame.camera;
        const move = ([x,y,z]) => [x,y,z+42.75]; d.setOrbitPose(move(c.eye),move(c.aim.orbitTarget)); })()`);
      await until(cdp, "forge3dViewportDiagnostics().terrainViewport.diagnosticSubmission.sequence > " + before);
    }
    const flat = fixture.raster === "flat", datum = flat ? 3210.1234 : 10;
    const { scale, zScale } = fixture;
    const span = name === "edge" ? [25,7] : [2688,960];
    const [tx, ty, tz] = name === "edge" ? [0,0,42] : scale === 1 ? [0, 0, 0] : [1.5, 2, name === "translated" ? 42 : -0.75];
    // Oracle from the raster recipe, independent of Studio's preview, transform and query.
    const points = [[0,0,11],[0,95,14],[95,0,17],[95,95,22],[19,70,29]].map(([row,col,h]) => {
      const elevation = flat ? datum : h;
      return { index: row*96+col, elevation, datumY: ty, position: [tx+scale*12*(col/95-0.5),
        ty+scale*(elevation-datum)*zScale*12/span[0],
        name === "edge" && (row === 0 || row === 95) ? (row === 0 ? 39.48 : 44.52) : tz+scale*span[1]*(row/95-0.5)*12/span[0]] };
    });
    const data = await cdp.evaluate(`(${sampleStudio})(${JSON.stringify(points)})`);
    report.placement[name] = data;
    checkPlacement(name, data, points);
    if (name === "placed") await writeFile(join(out, "placed.mask"), Buffer.from(data.mask, "base64"));
    delete data.mask;
    if (name === "exaggerated") {
      assert.equal(data.heightSha256, report.placement.placed.heightSha256);
      report.exaggerationNegativeControl = await checkExaggeration(cdp, until, points, data, out);
    }
    assert.equal(data.editor, false);
    assert.ok(data.visible && data.count && data.backend.includes("WebGPU available"));
    assert.deepEqual(data.source, [192, 96]);
    assert.deepEqual(data.grid, [96, 96]);
    assert.deepEqual(data.span, span);
    vector(data.spacing, span.map(side => side/95), name + " spacing");
    assert.equal(data.exaggeration, zScale);
    vector(data.rawDomain, [datum, flat ? datum : 29], name + " raw domain");
    near(data.domain[0], datum, name + " lower datum");
    assert.ok(data.domain[1] > data.domain[0]);
    if (!flat) assert.equal(data.peak, points[4].index);
    for (const [i, p] of points.entries()) {
      const measured = data.landmarks[i];
      near(measured.height, Math.fround(p.elevation), name + " GPU elevation at " + p.index);
      vector(measured.studio, p.position, name + " placement at " + p.index);
      assert.ok(measured.hit, name + " query missed vertex " + p.index);
      near(measured.hit.elevation, p.elevation, name + " query elevation");
      if (flat) assert.equal(measured.hit.position[1], ty, "Flat DEM must lie on its lower datum");
      vector(measured.hit.position, p.position, name + " query position");
    }
    if (name === "identity") {
      // The peak is the SE corner of this cell. Half its relief lies on the
      // drawn triangle here, while the raw DEM query uses all four samples.
      const x = 12*(69.75/95 - 0.5), z = 12*960/2688*(18.75/95 - 0.5);
      const hit = await cdp.evaluate(`forge3dViewportDiagnostics().queryTerrain(${x},${z})`);
      near(hit.elevation, 10 + 19*0.75**2, "raw interior sample");
      vector(hit.worldPosition, [x,19*0.5*12/2688,z], "interior mesh position");
      data.interior = hit;
    }
    if (name === "placed") {
      // Substitute the camera downstream of the public facade, at WASM dispatch.
      const sequence = () => cdp.evaluate("forge3dViewportDiagnostics().terrainViewport.diagnosticSubmission.sequence");
      const replay = async () => {
        const before = await sequence();
        await cdp.evaluate(`forge3dViewportDiagnostics().setOrbitPose(${JSON.stringify(data.camera.eye)},${JSON.stringify(data.camera.aim.orbitTarget)})`);
        await until(cdp, "forge3dViewportDiagnostics().terrainViewport.diagnosticSubmission.sequence > " + before);
      };
      await cdp.evaluate(`(async () => {
        const {Forge3DRuntime} = await import("/forge3d-web/forge3d_web.js");
        const p = Forge3DRuntime.prototype, original = p.setCamera;
        window.vp04RestoreCamera = () => { p.setCamera = original; delete window.vp04RestoreCamera; };
        p.setCamera = function(input) {
          const c = forge3dViewportDiagnostics().frame.camera;
          const units = 12/2688;
          return original.call(this, {...input, position:c.eye.map(v=>v/units), target:c.aim.orbitTarget.map(v=>v/units),
            near:c.near/units,far:c.far/units});
        };
      })()`);
      try {
        await replay();
        const bad = await cdp.evaluate(`(${sampleStudio})(${JSON.stringify(points)})`);
        assert.ok(bad.count > 0);
        assert.throws(() => checkPlacement("untransformed camera",bad,points), /projection error/);
        assert.ok(bad.footprint.actual && bad.footprint.iou < 0.995, "Camera substitution must move the rendered footprint");
        // Replaying the correct landmark telemetry must still fail the pixel test.
        assert.throws(() => checkPlacement("stale camera observation", {...bad, landmarks:structuredClone(data.landmarks)}, points), /rendered footprint/);
        report.cameraNegativeControl = { coverage: bad.count, landmarks: bad.landmarks, footprint: bad.footprint };
      } finally {
        await cdp.evaluate("vp04RestoreCamera()");
        await replay();
      }
    }
  }
}

let reference;
try {
  await desktop("cartography", async cdp => {
    await loadProject(cdp, projects.overlay, true);
    await until(cdp, '!!forge3dViewportDiagnostics().runtime?.overlay.children.length && !!document.querySelector(".cartography-label--feature")');
    await cdp.evaluate("new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))");
    const peak = [1.5 + 15 * (70/95 - 0.5), 2 + 1.25 * 19 * 12 / (384 * 1200/3937), -0.75 + 1.25 * 3.75 * (19/95 - 0.5)];
    const lifted = [peak[0], peak[1] + 1.25 * 0.02, peak[2]];
    const overlay = await cdp.evaluate(`(() => {
      const d = forge3dViewportDiagnostics(), r = d.runtime, line = r.overlay.children[0];
      const v = r.camera.position.clone();
      const linePosition = line.localToWorld(v.fromBufferAttribute(line.geometry.attributes.instanceStart, 0)).toArray();
      const p = v.fromArray(${JSON.stringify(lifted)}).project(r.camera);
      const label = document.querySelector(".cartography-label--feature");
      const m = label.style.transform.match(/translate3d\\(([-.\\d]+)px,\\s*([-.\\d]+)px/);
      return { linePosition, label: label.textContent, pixel: m?.slice(1).map(Number), visible: getComputedStyle(label).display !== "none",
        projected: [(1+p.x)*d.frame.dimensions.width/2, (1-p.y)*d.frame.dimensions.height/2],
        hit: d.queryTerrain(${peak[0]},${peak[2]}), backend: document.querySelector("[data-viewport-backend]").textContent };
    })()`);
    report.overlay = { ...overlay, expectedLine: lifted };
    vector(overlay.hit.worldPosition, peak, "overlay peak query");
    vector(overlay.linePosition, lifted, "draped line at peak");
    assert.ok(overlay.visible && overlay.label === "Peak" && Math.hypot(...overlay.projected.map((v,i) => v-overlay.pixel[i])) <= 1,
      "Projected label must sit at the transformed peak");
    await checkAdmission(cdp, projects.budget, loadProject, until, report);
    report.retainedCorner = await checkRetainedCorner(cdp, projects.admit, loadProject, until);
    report.twoPlateaux = await checkRetainedCorner(cdp, projects.twoPlateaux, loadProject, until);
    await loadProject(cdp, projects.fractional, true);
    await until(cdp, '!![...forge3dViewportDiagnostics().runtime.objects.values()].find(g => g.children.some(c => c.userData.elevation))');
    report.fractionalMeshY = await cdp.evaluate(`[...forge3dViewportDiagnostics().runtime.objects.values()].flatMap(g=>g.children)
      .find(c=>c.userData.elevation).geometry.attributes.position.getY(25*96+70)`);
    near(report.fractionalMeshY, (4150.25-4150.24)*20*12/2, "fractional mesh Y");
    await loadProject(cdp, projects.upperRounded, true);
    report.fallbackRoundedMesh = await checkRoundedMesh(cdp, false, until);
    await cdp.evaluate('localStorage.removeItem("studio.viewport.renderer")');
    await loadProject(cdp, projects.identity, true);
    report.fallbackHover = await checkHover(cdp, false, until);
    await cdp.evaluate('localStorage.removeItem("studio.viewport.renderer")');
    await loadProject(cdp, projects.clip, true);
    report.fallbackPlateauHover = await checkHover(cdp, false, until, "102 m");
    await cdp.evaluate('localStorage.removeItem("studio.viewport.renderer")');
    await loadProject(cdp, projects.halfHover, true);
    report.fallbackHalfHover = await checkHover(cdp, false, until, "101 m");
  });
  await desktop("field", async cdp => {
    await loadProject(cdp, projects.bryce, false);
    await cdp.evaluate(`(${installProbe})({role:"field"})`);
    const { viewport, toggles, stock } = await cdp.evaluate("__vp01Probe.inspect()");
    assert.equal(toggles.mode, "solid");
    assert.equal(toggles.liveSunShadow || toggles.liveTerrainShadow || toggles.shadows || toggles.sunVisibility, false);
    assert.equal(stock.webgl.context, "WebGL2RenderingContext");
    report.reference = { viewport, toggles, webgl: stock.webgl };
    const capture = await cdp.evaluate(`(async () => {
      const renderer = __vp01FieldDiagnostics().runtime.renderer;
      let resizes = 0;
      const setSize = renderer.setSize;
      const setBuffer = renderer.setDrawingBufferSize;
      renderer.setSize = function (...args) { resizes++; return setSize.apply(this, args); };
      renderer.setDrawingBufferSize = function (...args) { resizes++; return setBuffer.apply(this, args); };
      try {
        const gen = __vp01Probe.captureTerrain();
        for (;;) { const step = await gen.next(); if (step.done) return { poses: step.value.poses, resizes }; }
      } finally {
        renderer.setSize = setSize;
        renderer.setDrawingBufferSize = setBuffer;
      }
    })()`);
    report.reference.repeatedResizes = capture.resizes;
    assert.equal(capture.resizes, 0);
    reference = capture.poses;
    await loadProject(cdp, projects.upperRounded, false);
    report.fieldRoundedMesh = await checkRoundedMesh(cdp, true, until);
    await loadProject(cdp, projects.identity, false);
    report.fieldHover = await checkHover(cdp, true, until);
    await loadProject(cdp, projects.clip, false);
    report.fieldPlateauHover = await checkHover(cdp, true, until, "102 m");
    await loadProject(cdp, projects.halfHover, false);
    report.fieldHalfHover = await checkHover(cdp, true, until, "101 m");
    assert.equal(report.fallbackHalfHover.meshY, report.fieldHalfHover.meshY);
    for (const key of ["pixel","camera","aim","size","dpr","cursor"]) {
      assert.deepEqual(report.fallbackHalfHover[key], report.fieldHalfHover[key], "half-metre mesh hover " + key);
      assert.deepEqual(report.fallbackPlateauHover[key], report.fieldPlateauHover[key], "rounded plateau hover " + key);
      assert.deepEqual(report.fallbackHover[key], report.fieldHover[key], "fallback hover " + key);
    }
  });
  async function packagedControls(cdp) {
    const control = report.control = await cdp.evaluate(`(${packagedControl})()`);
    const mask = Buffer.from(control.footprintMask, "base64");
    delete control.footprintMask;
    control.footprint = measureFootprint(mask, control.heights);
    await writeFile(join(out, "packaged-nadir.mask"), mask);
    checkFootprint(control.footprint);
    control.negativeControls = {};
    for (const [name, override] of Object.entries({ spacing: {spacing:[1,1]}, domain: {domain:[9,12]},
      both: {spacing:[1,1],domain:[9,12]} })) {
      const displaced = await cdp.evaluate(`(${packagedControl})(${JSON.stringify(override)})`);
      const footprint = measureFootprint(Buffer.from(displaced.footprintMask,"base64"), displaced.heights);
      assert.ok(footprint.actual > 0);
      assert.throws(() => checkFootprint(footprint), /Packaged footprint IoU/);
      control.negativeControls[name] = { override, coverage: displaced.coverage, footprint };
    }
    assert.ok(control.coverage > 0 && control.coverage < 192*128);
    vector(control.heights, Array.from({length:15}, (_,i) => 10+i/10), "packaged readback");
    near(control.hit.elevation, 11.4, "packaged query");
    vector(control.hit.worldPosition, [4,1.4,1], "packaged position");
    assert.equal(control.outside, null);
  }
  await desktop("candidate", async cdp => {
    await loadProject(cdp, projects.bryce, true);
    const initialResizes = await cdp.evaluate("vp04Calls.resizes");
    for (const [name, ref] of Object.entries(reference)) {
      const { position, target } = ref.pose;
      for (let i = 0; i < 3; i++) {
        const before = await cdp.evaluate("forge3dViewportDiagnostics().terrainViewport.diagnosticSubmission.sequence");
        await cdp.evaluate(`forge3dViewportDiagnostics().setOrbitPose(${JSON.stringify(position)},${JSON.stringify(target)})`);
        await until(cdp, `forge3dViewportDiagnostics().terrainViewport.diagnosticSubmission.sequence > ${before}`);
      }
      const { mask, ...data } = await cdp.evaluate(`(${sampleStudio})()`);
      const a = Buffer.from(mask, "base64"), b = Buffer.from(ref.mask, "base64");
      assert.deepEqual(data.size, report.reference.viewport.physical);
      assert.equal(data.dpr, report.reference.viewport.dpr);
      assert.equal(data.mode, "solid");
      assert.deepEqual(data.shadows, [false,false]);
      assert.ok(data.visible && !data.editor && data.backend.includes("WebGPU available"));
      assert.equal(a.length, b.length);
      assert.equal(a.length, data.size.width * data.size.height);
      assert.ok(data.count && ref.count);
      vector(data.camera.eye, position, name + " eye");
      vector(data.camera.aim.orbitTarget, target, name + " aim");
      const intersection = a.reduce((n,v,i) => n + (v & b[i]), 0);
      const union = data.count + ref.count - intersection;
      const errors = data.landmarks.map((p,i) => {
        const q = ref.landmarks[i];
        assert.equal(p.index, q.index);
        return Math.hypot(p.pixel[0]-q.pixel[0], p.pixel[1]-q.pixel[1]);
      });
      await writeFile(join(out, name + ".webgpu.mask"), a);
      await writeFile(join(out, name + ".field.mask"), b);
      report.poses[name] = { ...data, fieldLandmarks: ref.landmarks, referenceCount: ref.count, intersection, union,
        iou: intersection / union, errors, maxError: Math.max(...errors), repeatedResizes: data.resizes-initialResizes };
      assert.ok(intersection / union >= 0.995 && Math.max(...errors) <= 1, name + " Bryce parity");
      assert.equal(data.resizes, initialResizes);
    }
    await placements(cdp);
    await loadProject(cdp, projects.farEdge, true);
    const before = await cdp.evaluate("forge3dViewportDiagnostics().terrainViewport.diagnosticSubmission.sequence");
    await cdp.evaluate("forge3dViewportDiagnostics().setOrbitPose([4000000009.5,7,11],[4000000000,.8,0])");
    await until(cdp,"forge3dViewportDiagnostics().terrainViewport.diagnosticSubmission.sequence > " + before);
    report.farEdges = await cdp.evaluate(`(async () => {
      const d = forge3dViewportDiagnostics(), rgba = await d.terrainViewport.diagnosticRuntime.readRgba();
      return {covered:rgba.filter((v,i) => i%4===3 && v).length, edges:[-1,1].map(sign => {
        const x = 4000000000 + sign*6;
        return {x, hit:d.queryTerrain(x,0), outside:[2**-21,1e-6,1e-5].map(delta =>
          ({x:x+sign*delta, hit:d.queryTerrain(x+sign*delta,0) ?? null}))};
      })};
    })()`);
    assert.ok(report.farEdges.covered > 0);
    for (const {x,hit,outside} of report.farEdges.edges) {
      assert.deepEqual(hit.worldPosition,[x,0,0]);
      assert.ok(outside.every(p => p.x !== x && p.hit === null));
    }
    report.exactEdges = await checkExactEdges(cdp, projects, loadProject, until);
    await checkDatums(cdp, projects, loadProject, until, report, out);
  }, packagedControls);
  if (values["with-vp03"]) {
    const origin = new URL("http://localhost:1426");
    const shell = values.shell ?? buildShell(root, "candidate", origin);
    const vite = await createServer({root, server:{host:"localhost",port:0}, logLevel:"error"});
    const dir = join(out,"vp03");
    try {
      await vite.listen();
      console.log("Running full VP-03 desktop regression",dir);
      const child = spawn(process.execPath, [join(root,"scripts/vp03.mjs"), "--shell", shell,
        "--upstream", vite.resolvedUrls.local[0], "--cdp-port", "0", "--out", dir, "--fractional-fixture", projects.fractional.path],
        {cwd:root, windowsHide:true, stdio:"inherit"});
      const [exitCode] = await once(child, "close");
      assert.equal(exitCode, 0, "VP-03 desktop regression failed. See " + dir);
      const regression = JSON.parse(await readFile(join(dir,"evidence.json"),"utf8"));
      assert.equal(regression.passed,true);
      assert.ok(Object.keys(regression.checks).length >= 52 && Object.values(regression.checks).every(check => check.passed),
        "Expected every check in the full VP-03 regression to pass");
      for (const key of ["staleQueryHeights","fractionalDatum","nativeTerrainPlacement"]) assert.equal(regression.checks[key]?.passed, true, key);
      report.vp03 = {passed:true, checks:Object.keys(regression.checks), evidence:"vp03/evidence.json"};
    } finally { await vite.close(); }
  }
  report.passed = true;
  console.log("All VP-04 gates passed");
} catch (error) {
  report.passed = false;
  report.error = error.stack ?? String(error);
  throw error;
} finally {
  await writeFile(join(out, "evidence.json"), JSON.stringify(report, null, 2) + "\n");
}
