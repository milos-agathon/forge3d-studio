import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { decodePng } from "../node_modules/@forge3d/web/dist/png-decode.js";
import { Camera, encodePng } from "@forge3d/web";
import "./prepare-viewport-runtime.mjs";
import { createFixture, CUBE_ID as C, TERRAIN_ID as T, verifyProvenance } from "./vp01/fixture.mjs";
import { transformedTriangleFixture, triangleStrokeFixture } from "./vp06/triangle-stroke-fixture.mjs";
import { overlappingCutouts, thinCutouts } from "./vp06/cutouts.mjs";
import { terrainHierarchy } from "./vp06/terrain-hierarchy.mjs";
import { terrainFoldControl } from "./vp06/terrain-fold.mjs";
import { terrainEdgeControl } from "./vp06/terrain-edges.mjs";
import { touchGestures } from "./vp06/touch.mjs";
import { mipmappedCutoutControl } from "./vp06/mip-cutout.mjs";
import { pinnedExampleServer, vectorExample } from "./vp06/vector.mjs";
import { observeContexts } from "./vp01/startup.mjs";
import { desktop, fieldCheckout, until } from "./viewport-desktop.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const out = await mkdtemp(join(tmpdir(), "studio-vp06-"));
console.log("VP-06 evidence", out);
process.env.PYTHONDONTWRITEBYTECODE = "1";
process.env.FORGE3D_STUDIO_PYTHON ??= execFileSync("python", ["-c", "import sys; print(sys.executable)"], { encoding: "utf8" }).trim();
const { path } = await createFixture(join(out, "fixture"));
const fixture = JSON.parse(await readFile(path));
const ground = fixture.scene.objects.find(o => o.id === T);
delete ground.kind.overlay;
fixture.assets = fixture.assets.filter(a => a.id === ground.kind.asset);
fixture.viewport.mode = "solid";
await writeFile(path, JSON.stringify(fixture));
const replacement = join(dirname(path), "replacement.studio3d");
await writeFile(replacement, JSON.stringify({ ...fixture, name: "Replacement", selection: [T] }));
const front = [398, 346], buried = [337, 414], sky = [80, 94];
const eye = [9.5, 7, 11], dir = [-9.5, -6.2, -11];
const aim = eye.map((v, i) => v + 10 * dir[i] / Math.hypot(...dir));
const report = { base: git(root, "rev-parse", "HEAD"), runtime: (await verifyProvenance()).commit,
  field: git(fieldCheckout(root), "rev-parse", "HEAD"), clicks: [] };
const D = "forge3dViewportDiagnostics()";
const S = D + ".terrainViewport.diagnosticSubmission";
const raf = "new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))";
const json = JSON.stringify;

async function openBryce(cdp, file) {
  await cdp.evaluate(`localStorage.setItem("studio.viewport.mapGrid","0");
    __TAURI_INTERNALS__.invoke("open_project", {path:${json(file)}})`);
  await cdp.evaluate("window.leaving = true");
  await cdp.send("Page.reload", { ignoreCache: true });
  await until(cdp, "!window.leaving && !!window.forge3dViewportDiagnostics");
  await cdp.evaluate(`document.querySelector('.recovery button[aria-label="Dismiss"]')?.click();
    Object.assign(document.querySelector(".viewport").style,{boxSizing:"content-box",flex:"none",width:"794px",height:"727px"});
    ${D}.setOrbitPose(${json(eye)}, ${json(aim)})`);
}

async function studio(cdp) {
  await openBryce(cdp, path);
  async function settle(mode, ids) {
    await until(cdp, `(${S}?.visibleIds ?? []).filter(id=>id===${json(C)} || id===${json(T)}).sort().join() === ${json([...ids].sort().join())}
      && ${D}.frame.settings.mode === ${json(mode)} && document.querySelector("[data-viewport-backend]").textContent.includes("WebGPU available")`);
    await cdp.evaluate(raf);
  }
  await settle("solid", [C,T]);
  await until(cdp, `${S}.width === 794 && ${S}.height === 727 && devicePixelRatio === 1`);
  assert.equal(await cdp.evaluate(D + ".runtime === null"), true);
  const gl = await cdp.evaluate('__vp01Contexts.filter(c => c.requested.includes("webgl"))');
  assert.ok(gl.length && gl.every(c => c.result === null));
  report.webgl = gl;
  const project = async () => (await cdp.evaluate('__TAURI_INTERNALS__.invoke("project_state")')).project;
  const bare = await project();
  assert.deepEqual(bare.cartography.map(layer => layer.type), ["relief"]);
  report.background = {};

  await cdp.evaluate(`{
    const probe = window.clickProbe = { picks: [], calls: [] };
    const host = ${D}.terrainViewport, pick = host.pick.bind(host);
    host.pick = async (frame, pixel) => {
      const submission = host.diagnosticSubmission, hold = probe.hold;
      probe.hold = false;
      const pending = pick(frame, pixel);
      if (probe.publishDuringPick) {
        probe.publishDuringPick = false;
        probe.crossing = { asyncRead: !!pending?.then, started: performance.now(), revision: submission.sequence };
        const settled = Promise.resolve(pending).then(() => { probe.crossing.settled = performance.now(); });
        probe.releaseReply();
        // Wait until React actually publishes the acknowledgement. This also
        // exercises the ordering on adapters that finish a small read early.
        while (document.querySelector('[data-object-id="${T}"]').getAttribute("aria-selected") !== "true") {
          await new Promise(requestAnimationFrame);
        }
        probe.crossing.published = performance.now();
        await ${raf};
        await settled;
      }
      const result = await pending;
      probe.picks.push({pixel, hit:result?.hit, submission});
      if (hold) {
        return new Promise(resolve => { probe.release = () => resolve(result); });
      }
      return result;
    };
    const original = window.fetch;
    window.fetch = function(resource, init) {
      const url = new URL(resource instanceof Request ? resource.url : resource, location.href);
      if (url.hostname === "ipc.localhost") {
        const cmd = decodeURIComponent(url.pathname.slice(1));
        if (cmd === "set_selection") {
          probe.calls.push(JSON.parse(init.body).ids);
          if (probe.holdRequest) {
            probe.holdRequest = false;
            return new Promise(done => { probe.releaseRequest = done; }).then(() => original.apply(this, arguments))
              .finally(() => { probe.firstReturned = true; });
          }
          if (probe.holdReply) {
            probe.holdReply = false;
            return original.apply(this, arguments).then(async reply => {
              await new Promise(done => { probe.releaseReply = done; });
              return reply;
            });
          }
        }
        if (cmd === "plugin:dialog|open") return Promise.resolve(new Response(JSON.stringify(probe.openPath),
          {headers:{"Content-Type":"application/json","Tauri-Response":"ok"}}));
      }
      return original.apply(this, arguments);
    };
  }`);
  async function openFile(file) {
    const generation = await cdp.evaluate(D + ".frame.projectGeneration");
    await cdp.evaluate(`window.confirm = () => true; clickProbe.openPath = ${json(file)};
      [...document.querySelectorAll(".menu__button")].find(b=>b.textContent==="File").click()`);
    await cdp.evaluate(`[...document.querySelectorAll('[role="menuitem"]')].find(b=>b.textContent.includes("Open…")).click()`);
    await until(cdp, D + ".frame.projectGeneration > " + generation);
  }
  const toggle = async id => cdp.evaluate(`document.querySelector('[data-object-id="${id}"] button.tree-action').click()`);
  async function click(label, pixel, expected, selection, { modifiers = 0, travel = 0, ignored = false, stale, duringPick, expectedRows = selection, expectedCalls } = {}) {
    await cdp.evaluate(raf);
    const before = await cdp.evaluate(`({picks:clickProbe.picks.length,calls:clickProbe.calls.length,
      mode:${D}.frame.settings.mode, dpr:devicePixelRatio,
      backend:document.querySelector("[data-viewport-backend]").textContent})`);
    const [x,y] = await cdp.evaluate(`(() => {const c=document.querySelector(".viewport-canvas--terrain");
      const r=(c.hidden ? document.querySelector(".viewport") : c).getBoundingClientRect();
      const size = ${D}.frame.dimensions;
      return [r.x+(${pixel[0]}+.5)*r.width/size.width,r.y+(${pixel[1]}+.5)*r.height/size.height]})()`);
    if (stale || duringPick) await cdp.evaluate("clickProbe.release = null; clickProbe.hold = true");
    const mouse = (type, x, buttons) => cdp.send("Input.dispatchMouseEvent", { type, x, y, buttons, modifiers,
      ...(type === "mouseMoved" ? {} : { button:"left", clickCount:1 }) });
    await mouse("mouseMoved", x-travel, 0);
    await mouse("mousePressed", x-travel, 1);
    if (travel) await mouse("mouseMoved", x, 1);
    await mouse("mouseReleased", x, 0);
    if (duringPick) {
      await duringPick();
      await until(cdp, "!!clickProbe.release");
      await cdp.evaluate("clickProbe.release()");
    }
    if (!ignored) await until(cdp, "clickProbe.picks.length === " + (before.picks + 1));
    if (stale === "open") {
      await openFile(replacement);
      const opened = await project();
      assert.equal(opened.id, fixture.id);
      assert.deepEqual(opened.selection, [T]);
      await settle("solid", [C,T]);
    } else if (stale) await stale();
    if (stale) await cdp.evaluate("clickProbe.release()");
    await cdp.evaluate(raf);
    const rows = await cdp.evaluate(`[...document.querySelectorAll('[role="treeitem"][aria-selected="true"]')].map(el=>el.dataset.objectId)`);
    const selected = (await project()).selection;
    const { picks, calls } = await cdp.evaluate(`({picks:clickProbe.picks.slice(${before.picks}),calls:clickProbe.calls.slice(${before.calls})})`);
    const actual = picks[0]?.hit ?? null;
    const s = picks[0]?.submission;
    let projected;
    if (actual) {
      const p = s.placement, pos = actual.worldPosition.map((v,i) => (v-p.translation[i])/p.scale);
      projected = new Camera(s.camera).worldToScreen(pos, s);
      assert.ok(Math.hypot(projected.x-pixel[0]-.5, projected.y-pixel[1]-.5) < .001, json({ label, pixel, projected }));
      assert.equal(actual.frameRevision, s.sequence);
      assert.equal(actual.kind, expected === C ? "cube" : "terrain");
      assert.ok(Math.abs(actual.distance - Math.hypot(...pos.map((v,i) => v - s.camera.position[i])) * p.scale) < 1e-7);
      if (expected === T) {
        assert.equal(actual.elevation, await cdp.evaluate(`${D}.queryTerrain(${actual.worldPosition[0]},${actual.worldPosition[2]}).elevation`));
      } else assert.ok(!("elevation" in actual));
    }
    const disposition = duringPick ? "ordered with tree click" : stale ? "discarded" : ignored ? "ignored" : calls.length ? "applied" : "preserved";
    const row = { label, disposition, frameRevision:s?.sequence, mode:before.mode, backend:before.backend, dpr:before.dpr, pixel, expected, actual, projected, selected, rows, calls };
    report.clicks.push(row);
    assert.equal(actual?.id ?? null, expected, json(row));
    assert.deepEqual(selected, selection, json(row));
    assert.deepEqual(rows.sort(), [...expectedRows].sort(), json(row));
    assert.deepEqual(calls, expectedCalls ?? (ignored || stale || modifiers && !actual ? [] : [selection]), json(row));
    if (ignored) assert.equal(picks.length, 0);
    else assert.deepEqual(picks[0].pixel, pixel);
    console.log(before.mode, label, pixel, selected);
  }

  for (const mode of ["solid","material"]) {
    if (mode === "material") await cdp.evaluate(`document.querySelector('button[title^="Material preview"]').click()`);
    await settle(mode, [C,T]);
    await click("both", front, C, [C]);
    await click("both", buried, T, [T]);
    await toggle(C);
    await settle(mode, [T]);
    await click("cube hidden", front, T, [T]);
    await toggle(C);
    await toggle(T);
    await settle(mode, [C]);
    await click("terrain hidden", buried, C, [C]);
    await toggle(T);
    await settle(mode, [C,T]);
    const alpha = await cdp.evaluate(`(async () => {const r = ${D}.terrainViewport.diagnosticRuntime;
      return (await r.readRgba())[(${sky[1]}*r.width+${sky[0]})*4+3]})()`);
    assert.equal(alpha, 0);
    report.background[mode] = { pixel:sky, alpha };
    await click("background", sky, null, []);
  }
  await cdp.evaluate("clickProbe.holdReply = true");
  await click("Shift cube, reply held", front, C, [C], {modifiers:8, expectedRows:[]});
  await until(cdp, "!!clickProbe.releaseReply");
  await click("Shift terrain before cube reply", buried, T, [C,T], {modifiers:8});
  await cdp.evaluate("clickProbe.releaseReply()");
  await cdp.evaluate(raf);
  assert.deepEqual((await project()).selection, [C,T]);
  assert.deepEqual(await cdp.evaluate(`[...document.querySelectorAll('[role="treeitem"][aria-selected="true"]')].map(el=>el.dataset.objectId).sort()`),
    [C,T].sort());
  await click("clear before reordered requests", sky, null, []);
  await cdp.evaluate("clickProbe.holdRequest = true");
  await click("Shift cube, request held", front, C, [], {modifiers:8, expectedCalls:[[C]]});
  await click("Shift terrain before cube request", buried, T, [C,T], {modifiers:8});
  await cdp.evaluate("clickProbe.releaseRequest()");
  await until(cdp, "clickProbe.firstReturned");
  await cdp.evaluate(raf);
  assert.deepEqual((await project()).selection, [C,T]);
  assert.equal(await cdp.evaluate('document.querySelectorAll(\'[role=treeitem][aria-selected="true"]\').length'), 2);
  await cdp.evaluate('document.querySelector(\'button[title^="Add object"]\').click()');
  await cdp.evaluate('[...document.querySelectorAll(".add-menu__dropdown [role=menuitem]")].find(b=>b.textContent==="Cube").click()');
  await until(cdp,`${D}.frame.objects.filter(o=>o.kind.type==="mesh").length === 2`);
  const added = (await project()).scene.objects.find(o => o.kind.type === "mesh" && o.id !== C).id;
  await until(cdp,`document.querySelector('[data-object-id="${added}"]').getAttribute("aria-selected")==="true"`);
  await cdp.evaluate(`clickProbe.releaseReply = null; clickProbe.holdReply = true;
    document.querySelector('[data-object-id="${added}"] .tree-name').click()`);
  await until(cdp,"!!clickProbe.releaseReply");
  await cdp.evaluate('document.querySelector(\'button[title^="Undo "]\').click()');
  await settle("material",[C,T]);
  assert.ok(!(await project()).scene.objects.some(o=>o.id === added));
  await click("Shift terrain after Undo, cube reply held", buried, T, [T], {modifiers:8});
  await cdp.evaluate("clickProbe.releaseReply()");
  await cdp.evaluate(raf);
  assert.deepEqual((await project()).selection, [T]);
  await click("plain", front, C, [C]);
  await click("Shift adds", buried, T, [C,T], {modifiers:8});
  await click("Ctrl removes", front, C, [T], {modifiers:2});
  await click("Meta adds", front, C, [T,C], {modifiers:4});
  await click("additive miss", sky, null, [T,C], {modifiers:8});
  await click("4 CSS px", buried, T, [T], {travel:4});
  await click("5 CSS px", front, null, [T], {travel:5, ignored:true});
  await cdp.send("Emulation.setDeviceMetricsOverride", {width:1440,height:833,deviceScaleFactor:1.25,mobile:false});
  await until(cdp, `${S}.width === 992 && ${S}.height === 908`);
  await click("fractional DPR", [498,432], C, [C]);
  await cdp.send("Emulation.setDeviceMetricsOverride", {width:1440,height:833,deviceScaleFactor:1,mobile:false});
  await until(cdp, `${S}.width === 794 && ${S}.height === 727`);
  await click("delayed hit across Open", front, C, [T], {stale:"open"});
  await click("delayed miss across Open", sky, null, [T], {stale:"open"});

  await click("camera changed", front, C, [T], { stale:async () => {
    await cdp.evaluate(`${D}.setOrbitPose([10,7,11], ${json(aim)})`);
    await until(cdp, D + ".frame.camera.eye[0] === 10");
  } });
  await cdp.evaluate(`${D}.setOrbitPose(${json(eye)}, ${json(aim)})`);
  await click("dimensions changed", sky, null, [T], { stale:async () => {
    await cdp.evaluate('document.querySelector(".viewport").style.width = "770px"');
    await until(cdp, S + ".width === 770");
  } });
  await cdp.evaluate('document.querySelector(".viewport").style.width = "794px"');
  await until(cdp, S + ".width === 794");
  await click("visibility changed", front, C, [T], { stale:async () => {
    await toggle(C);
    await settle("solid", [T]);
  } });
  await toggle(C);
  await settle("solid", [C,T]);
  await cdp.evaluate(`document.querySelector('[data-object-id="${C}"] .tree-name').click();
    document.querySelector('button[title^="Object:"]').click()`);
  await click("geometry changed", sky, null, [C], { stale:async () => {
    await cdp.evaluate(`{const label = [...document.querySelectorAll(".group-label")].find(el => el.textContent === "Scale");
      const input = label.previousElementSibling.querySelector("input"); input.focus(); input.select()}`);
    await cdp.send("Input.insertText", {text:"0"});
    await cdp.evaluate("document.activeElement.blur()");
    await until(cdp, `${D}.frame.objects.find(o=>o.id==="${C}").scale[0] === 0`);
  } });
  // Open a real layer, select it in Cartography, remove it there, then repeat
  // the cube click. Both projects use the original Bryce object UUIDs.
  const layered = structuredClone(bare);
  const assetPath = join(root, "assets/gpkg/luxembourg_rail.gpkg");
  const asset = { id:"b90229ad-b95a-4f7e-a569-c86b4de144b2", kind:"vector", name:"Rail", path:assetPath,
    byteSize:(await stat(assetPath)).size };
  layered.assets.push(asset);
  layered.cartography.push({ type:"vector", name:"Rail", visible:true, asset:asset.id,
    id:"3e2029da-6c31-4a24-ad4f-7dafadd2e8c5", colour:[1,0,0,1], widthPx:2 });
  const layeredFile = join(dirname(path), "layered.studio3d");
  await writeFile(layeredFile, json(layered));
  await openFile(layeredFile);
  const button = async (selector, label) => cdp.evaluate(`[...document.querySelectorAll(${json(selector)})]
    .find(b=>b.textContent.trim()===${json(label)}).click()`);
  await button('[role="tab"]', "Cartography");
  await button(".layerrow__name", "Rail");
  assert.deepEqual((await project()).selection, bare.selection);
  await button("button", "Remove this layer");
  await until(cdp, '![...document.querySelectorAll(".layerrow__name")].some(b=>b.textContent==="Rail")');
  await button('[role="tab"]', "Scene");
  await settle("solid", [C,T]);
  assert.deepEqual((await project()).cartography.map(layer => layer.type), ["relief"]);
  await click("vector layer removed", front, C, [C]);
  await cdp.evaluate(`document.querySelector('button[title^="Rendered mode"]').click()`);
  await until(cdp, D + '.frame.settings.mode === "rendered"');
  await click("Rendered mode", sky, null, [C], {ignored:true});

  function colours(sample) {
    return cdp.evaluate(`(async () => {
      const rt = ${D}.terrainViewport.diagnosticRuntime, rgba = await rt.readRgba();
      return ${json(sample)}.map(([x,y]) => Array.from(rgba.subarray(4*(y*rt.width+x), 4*(y*rt.width+x)+4)).join());
    })()`);
  }
  const silhouette = structuredClone(fixture);
  silhouette.selection = [];
  for (const object of silhouette.scene.objects) object.visible = object.id === C;
  silhouette.scene.objects.find(o => o.id === C).transform.translation = { x:0, y:0, z:0 };
  const silhouetteFile = join(dirname(path), "cube-silhouette.studio3d");
  await writeFile(silhouetteFile, json(silhouette));
  await openFile(silhouetteFile);
  report.cubeSilhouette = [];
  for (const mode of ["solid", "material"]) {
    if (mode === "material") await cdp.evaluate(`document.querySelector('button[title^="Material preview"]').click()`);
    await settle(mode, [C]);
    for (const [z, x, covered] of [[9.478847292072615, 500, false], [9.478961982570125, 293, true]]) {
      await click("clear silhouette selection before edge samples", sky, null, []);
      const pixel = [x, 363];
      await cdp.evaluate(`${D}.setOrbitPose([0,0,${z}],[0,0,0])`);
      await until(cdp, `Math.abs(${S}?.camera.position[2] - ${z}) < 1e-6`);
      const [shown] = await colours([pixel]);
      await toggle(C);
      await settle(mode, []);
      const [hidden] = await colours([pixel]);
      await toggle(C);
      await settle(mode, [C]);
      const [restored] = await colours([pixel]);
      assert.equal(hidden, "0,0,0,0");
      assert.equal(restored, shown);
      assert.equal(shown !== hidden, covered);
      await click(covered ? "clear before covered cube edge" : "select before uncovered cube edge",
        covered ? sky : [397,363], covered ? null : C, covered ? [] : [C]);
      await click(covered ? "covered cube silhouette" : "uncovered cube silhouette",
        pixel, covered ? C : null, covered ? [C] : []);
      report.cubeSilhouette.push({ mode, z, pixel, shown, hidden, restored });
    }

    // The uppermost covered sample and its neighbour show the same front face.
    // Reprojection alone also accepts a point a full unit behind that face.
    await cdp.evaluate(`${D}.setOrbitPose([0,1.0001,10],[0,1,0])`);
    await until(cdp, `Math.abs(${S}?.camera.position[1] - 1.0001) < 1e-7`);
    await click("clear silhouette selection before grazing samples", sky, null, []);
    const pixels = [[397,363], [397,364], [397,362]];
    const shown = await colours(pixels);
    assert.notEqual(shown[0], "0,0,0,0");
    assert.equal(shown[0], shown[1]);
    assert.equal(shown[2], "0,0,0,0");
    for (const [i, pixel] of pixels.entries()) {
      const covered = i < 2;
      await click("grazing cube face", pixel, covered ? C : null, covered ? [C] : []);
      if (covered) {
        const { actual } = report.clicks.at(-1);
        assert.ok(Math.abs(actual.worldPosition[2] - 1) < .0004, json({ mode, pixel, actual }));
      }
    }
    assert.deepEqual(await colours(pixels), shown, "Picking must restore the displayed cube");
  }

  async function crossSelectionReply(terrainPixel, cubePixel, modifiers) {
    await cdp.evaluate("clickProbe.releaseReply = null; clickProbe.holdReply = true");
    await click("terrain before depth read, reply held", terrainPixel, T, [T], {expectedRows:[]});
    await until(cdp, "!!clickProbe.releaseReply");
    await cdp.evaluate("clickProbe.publishDuringPick = true");
    await click(modifiers ? "Shift cube across selection acknowledgement" : "plain cube across selection acknowledgement",
      cubePixel, C, modifiers ? [T,C] : [C], {modifiers});
    const trace = await cdp.evaluate("clickProbe.crossing");
    assert.ok(trace.asyncRead, "exercise a cold GPU depth read");
    assert.equal(await cdp.evaluate(S + ".sequence"), trace.revision);
    (report.selectionDuringRead ??= []).push(trace);
  }

  // Render the same flattened box and constant-height DEM together and in
  // isolation. Their actual colours independently identify the depth winner.
  const flat = structuredClone(fixture);
  flat.viewport.mode = "material";
  flat.selection = [];
  const box = flat.scene.objects.find(o => o.id === C);
  box.transform.scale.y = 0;
  box.transform.translation = {x:0, y:-.002, z:0};
  const source = resolve(dirname(path), flat.assets[0].path);
  flat.assets[0].path = join(dirname(path), "flat.tif");
  execFileSync(process.env.FORGE3D_STUDIO_PYTHON, ["-c", [
    "import sys, numpy as np, rasterio",
    "with rasterio.open(sys.argv[1]) as src:",
    " profile = dict(src.profile, dtype='float32', count=1, nodata=None)",
    " with rasterio.open(sys.argv[2], 'w', **profile) as dst:",
    "  dst.write(np.full(src.shape, 2000, dtype='float32'), 1)",
  ].join("\n"), source, flat.assets[0].path]);
  const flatPath = join(dirname(path), "flat.studio3d");
  await writeFile(flatPath, json(flat));
  await openFile(flatPath);
  await cdp.evaluate(`${D}.setOrbitPose([0,145,20], [0,0,0])`);
  await settle("material", [C,T]);
  const pixels = Array.from({length:81}, (_, i) => [393 + i % 9, 359 + Math.floor(i / 9)]);
  const both = await colours(pixels);
  await toggle(C);
  await settle("material", [T]);
  const groundOnly = await colours(pixels);
  await toggle(C);
  await toggle(T);
  await settle("material", [C]);
  const cubeOnly = await colours(pixels);
  await toggle(T);
  await settle("material", [T,C]);
  const owners = both.map((colour, i) => {
    assert.notEqual(cubeOnly[i], groundOnly[i]);
    assert.ok(colour === cubeOnly[i] || colour === groundOnly[i]);
    return colour === cubeOnly[i] ? C : T;
  });
  await crossSelectionReply([397,379], [397,363], 0);
  const sampled = await cdp.evaluate(`(async () => {
    const v=${D}, ids=[];
    for (const pixel of ${json(pixels)}) ids.push((await v.terrainViewport.pick(v.frame,pixel))?.hit?.id);
    return ids;
  })()`);
  assert.deepEqual(sampled, owners);
  report.depthPatch = { pixels, both, groundOnly, cubeOnly, owners, sampled };
  for (const pixel of [[397,363],[397,367]]) {
    const owner = owners[pixels.findIndex(([x,y]) => x === pixel[0] && y === pixel[1])];
    await click("flat DEM depth overlap", pixel, owner, [owner]);
  }
  const highPath = join(dirname(path),"flat-solid.studio3d");
  await writeFile(highPath,json({ ...flat, selection:[], viewport:{...flat.viewport,mode:"solid"} }));
  await openFile(highPath);
  await cdp.evaluate(`${D}.setOrbitPose([0,145,20],[0,0,0])`);
  await settle("solid",[C,T]);
  await cdp.send("Emulation.setDeviceMetricsOverride",{width:2480,height:1260,deviceScaleFactor:2,mobile:false});
  await cdp.evaluate('Object.assign(document.querySelector(".viewport").style,{width:"1920px",height:"1080px"})');
  await until(cdp,`${S}?.width === 3840 && ${S}.height === 2160`);
  await settle("solid",[C,T]);
  const center = [[1920,1080]];
  const [combined] = await colours(center);
  await toggle(C);
  await settle("solid",[T]);
  const [terrainColour] = await colours(center);
  await toggle(C);
  await toggle(T);
  await settle("solid",[C]);
  const [cubeColour] = await colours(center);
  assert.notEqual(cubeColour, terrainColour);
  assert.ok(combined === cubeColour || combined === terrainColour);
  const owner = combined === cubeColour ? C : T;
  await toggle(T);
  await settle("solid",[C,T]);
  assert.equal(owner, C);
  await crossSelectionReply([1920,1125], center[0], 8);
  await toggle(C);
  await settle("solid",[T]);
  await toggle(C);
  await settle("solid",[T,C]);
  await click("4K depth overlap, cold read", center[0], owner, [owner]);
  assert.deepEqual(await colours(center), [combined], "A pick must restore the submitted materials and lighting");
  report.fourK = { combined, terrainColour, cubeColour, owner,
    memory: await cdp.evaluate(D + ".terrainViewport.diagnosticRuntime.getMemoryReport()") };
  assert.ok(report.fourK.memory.peakBytes <= report.fourK.memory.budgetBytes);

  for (const shift of [false,true]) {
    await openFile(highPath);
    await cdp.evaluate(`${D}.setOrbitPose([0,145,20],[0,0,0])`);
    await settle("solid",[C,T]);
    const selected = shift ? [C,T] : [T];
    await click(shift ? "Shift tree click during cube pick" : "plain tree click during cube pick",
      center[0], C, selected, { expectedCalls:shift ? [[T],[C,T]] : [[T]], duringPick:async () => {
        const [x,y] = await cdp.evaluate(`(() => {const row=document.querySelector('[data-object-id="${T}"] .tree-name');
          row.scrollIntoView({block:"nearest"}); const r=row.getBoundingClientRect(); return [r.x+r.width/2,r.y+r.height/2]})()`);
        for (const [type,buttons] of [["mousePressed",1],["mouseReleased",0]]) {
          await cdp.send("Input.dispatchMouseEvent", {type, x, y, button:"left", buttons, clickCount:1, modifiers:shift ? 8 : 0});
        }
        await until(cdp,`document.querySelector('[data-object-id="${T}"]').getAttribute("aria-selected")==="true"`);
        assert.deepEqual((await project()).selection,[T]);
      } });
  }
  await terrainFoldControl(cdp, { fixture, path, openFile, settle, toggle, colours, click, report });
}
function binaryGltf(document, binary) {
  const jsonBytes = Buffer.from(json(document)), padded = Math.ceil(jsonBytes.length / 4) * 4;
  const binLength = Math.ceil(binary.length / 4) * 4;
  const glb = Buffer.alloc(28 + padded + binLength);
  glb.write("glTF"); glb.writeUInt32LE(2,4); glb.writeUInt32LE(glb.length,8);
  glb.writeUInt32LE(padded,12); glb.write("JSON",16); glb.fill(32,20,20+padded); jsonBytes.copy(glb,20);
  glb.writeUInt32LE(binLength,20+padded); glb.write("BIN\0",24+padded); binary.copy(glb,28+padded);
  return glb;
}

async function editorControl(cdp) {
  // Exercise the mixed renderer explicitly. The transparent cartographic layer
  // keeps the meshes in the editor while WebGPU owns the relief depth.
  const graticule = { type:"graticule", id:"1db12067-bdc6-4897-8047-f75986e6f080",
    name:"Depth control", visible:true, intervalDeg:1, colour:[0,0,0,0], widthPx:1, labels:false };
  const file = join(dirname(path), "hybrid.studio3d");
  const scene = structuredClone(fixture);
  const sphere = structuredClone(scene.scene.objects.find(o => o.id === C));
  sphere.id = "b8c85bb5-dfc1-431a-85b5-d88b34246b78";
  sphere.name = "Offscreen sphere";
  sphere.kind.source.primitive = {type:"sphere",radius:1};
  sphere.transform.translation.x = 100;
  scene.scene.objects.push(sphere);
  (scene.cartography ??= []).push(graticule);
  await writeFile(file, json(scene));
  await openBryce(cdp, file);
  await until(cdp, `${S}?.visibleIds.join() === "${T}" && ${S}.width === 794 && ${S}.height === 727 && !!${D}.runtime`);
  await cdp.evaluate(raf);
  const observeSelection = () => cdp.evaluate(`{
    const fetch = window.fetch;
    window.selectionCalls = [];
    const host = ${D}.terrainViewport, pick = host.pick.bind(host);
    host.pick = (...args) => { window.pickSubmission = host.diagnosticSubmission; return pick(...args); };
    window.fetch = function(resource, init) {
      const url = new URL(resource instanceof Request ? resource.url : resource, location.href);
      if (url.hostname === "ipc.localhost" && url.pathname === "/set_selection") selectionCalls.push(JSON.parse(init.body).ids);
      return fetch.apply(this,arguments);
    };
  }`);
  await observeSelection();
  const coords = pixel => cdp.evaluate(`(() => {const c=${D}.runtime.renderer.domElement,r=c.getBoundingClientRect();
    return [r.x+(${pixel[0]}+.5)*r.width/c.width,r.y+(${pixel[1]}+.5)*r.height/c.height]})()`);
  async function record(label, pixel, expected, selected, calls, submittedAtClick, backend) {
    const result = await cdp.evaluate(`(async () => {const d=${D};
      return {pick:d.lastPick, mode:d.frame.settings.mode, dpr:devicePixelRatio, selected:(await __TAURI_INTERNALS__.invoke("project_state")).project.selection,
        rows:[...document.querySelectorAll('[role=treeitem][aria-selected=true]')].map(el=>el.dataset.objectId),
        calls:selectionCalls.splice(0), submission:window.pickSubmission};
    })()`);
    assert.deepEqual(result.selected, selected);
    assert.deepEqual(result.rows, selected);
    assert.deepEqual(result.calls, calls);
    const actual = calls.length ? result.pick?.hit : null;
    assert.equal(actual?.id ?? null, expected);
    let projected;
    if (actual) {
      assert.deepEqual(result.pick.pixel, pixel);
      const s = submittedAtClick ?? result.submission;
      if (s) {
        const pos = actual.worldPosition.map((v,i) => (v-s.placement.translation[i])/s.placement.scale);
        projected = new Camera(s.camera).worldToScreen(pos, s);
      } else {
        projected = await cdp.evaluate(`(() => {
          const {camera,renderer}=${D}.runtime, p=camera.position.clone().fromArray(${json(actual.worldPosition)}).project(camera);
          return {x:(p.x+1)*renderer.domElement.width/2, y:(1-p.y)*renderer.domElement.height/2};
        })()`);
      }
      assert.ok(Math.hypot(projected.x-pixel[0]-.5, projected.y-pixel[1]-.5) < .001);
    }
    report.clicks.push({label, disposition:calls.length ? "applied" : "ignored", frameRevision:actual?.frameRevision,
      mode:result.mode, backend:backend ?? (expected === C || !calls.length ? "three.js (WebGPU terrain)" : "forge3d-web (editor enabled)"), dpr:result.dpr, pixel,
      expected, actual, projected, selected:result.selected, rows:result.rows, calls:result.calls});
  }
  for (const [label, pixel, expected] of [["editor cube ahead of DEM",front,C],["DEM ahead of editor cube",buried,T]]) {
    await cdp.click(await coords(pixel));
    await until(cdp, `document.querySelector('[data-object-id="${expected}"]').getAttribute("aria-selected") === "true"`);
    await cdp.evaluate(raf);
    await record(label,pixel,expected,[expected],[[expected]]);
  }
  for (const delta of [1,-1,2,-2,4,-4,5]) {
    const [x,y] = await coords(buried);
    const mouse = (type, at, buttons) => cdp.send("Input.dispatchMouseEvent", {type, x:at, y, buttons,
      ...(type === "mouseMoved" ? {} : {button:"left",clickCount:1})});
    await mouse("mouseMoved",x-delta,0);
    await mouse("mousePressed",x-delta,1);
    await Promise.all([mouse("mouseMoved",x,1),mouse("mouseReleased",x,0)]);
    if (delta !== 5) await until(cdp,"selectionCalls.length === 1");
    await cdp.evaluate(raf);
    await record(`editor travel ${delta} CSS px`,buried,delta === 5 ? null : T,[T],delta === 5 ? [] : [[T]]);
  }
  for (const release of [0,3]) {
    const [x,y] = await coords(sky);
    const eyeX = await cdp.evaluate(`${D}.runtime.camera.position.x`);
    await cdp.send("Input.dispatchMouseEvent",{type:"mousePressed",x,y,button:"left",buttons:1,clickCount:1});
    await cdp.send("Input.dispatchMouseEvent",{type:"mouseMoved",x:x+64,y,buttons:1});
    await until(cdp,`Math.abs(${D}.runtime.camera.position.x - (${eyeX})) > .1`);
    await cdp.send("Input.dispatchMouseEvent",{type:"mouseMoved",x:x+release,y,buttons:1});
    await cdp.send("Input.dispatchMouseEvent",{type:"mouseReleased",x:x+release,y,button:"left",buttons:0,clickCount:1});
    await cdp.evaluate(raf);
    await record(`returning orbit ending ${release} CSS px from press`,[sky[0]+release,sky[1]],null,[T],[]);
  }
  await cdp.evaluate(`${D}.setOrbitPose(${json(eye)}, ${json(aim)})`);
  const [dragX,dragY] = await coords([500,350]);
  await cdp.send("Input.dispatchMouseEvent", {type:"mousePressed",x:dragX,y:dragY,button:"left",buttons:1,clickCount:1});
  await cdp.send("Input.dispatchMouseEvent", {type:"mouseMoved",x:dragX+38,y:dragY,buttons:1});
  await cdp.send("Input.dispatchMouseEvent", {type:"mouseReleased",x:dragX+38,y:dragY,button:"left",buttons:0,clickCount:1});
  await until(cdp, `Math.abs(${D}.frame.camera.eye[0]-${eye[0]}) > 1`);
  await cdp.evaluate(`new Promise(done => {
    let last, stable = 0;
    function tick() {
      const revision = ${S}.sequence;
      stable = revision === last ? stable + 1 : 0;
      last = revision;
      if (stable >= 12) done(); else requestAnimationFrame(tick);
    }
    tick();
  })`);
  for (const [label, pixel, expected] of [["background after orbit",sky,null],["terrain after orbit",front,T]]) {
    const submitted = await cdp.evaluate(S);
    const selection = expected ? [expected] : [];
    await cdp.click(await coords(pixel));
    await until(cdp, "selectionCalls.length === 1");
    await cdp.evaluate(raf);
    await record(label,pixel,expected,selection,[selection],submitted);
  }
  await cdp.evaluate(`${D}.setOrbitPose(${json(eye)}, ${json(aim)})`);
  await cdp.evaluate(`document.querySelector('[data-object-id="${C}"] .tree-name').click();
    document.querySelector('button[title="Move (G)"]').click()`);
  await until(cdp, `${D}.runtime.gizmo.object?.userData.studioId === "${C}"`);
  await cdp.evaluate(raf);
  const pixel = await cdp.evaluate(`(() => {const r=${D}.runtime, p=r.gizmo.object.position.clone().project(r.camera),
    c=r.renderer.domElement; return [Math.floor((1+p.x)*c.width/2),Math.floor((1-p.y)*c.height/2)]})()`);
  const [x,y] = await coords(pixel);
  await cdp.evaluate("selectionCalls.length = 0");
  await cdp.send("Input.dispatchMouseEvent", {type:"mouseMoved",x,y});
  await cdp.send("Input.dispatchMouseEvent", {type:"mousePressed",x,y,button:"left",buttons:1,clickCount:1});
  assert.ok(await cdp.evaluate(D + ".runtime.gizmo.dragging"));
  await cdp.send("Input.dispatchMouseEvent", {type:"mouseMoved",x:x+2,y,buttons:1});
  await cdp.send("Input.dispatchMouseEvent", {type:"mouseReleased",x:x+2,y,button:"left",buttons:0,clickCount:1});
  await cdp.evaluate(raf);
  await record("2 CSS px gizmo drag",[pixel[0]+2,pixel[1]],null,[C],[]);

  const wireScene = structuredClone(fixture), mid = [397,363];
  const helper = wireScene.scene.objects.find(o => o.kind.type === "camera");
  helper.transform.translation = {x:1.25,y:0,z:4};
  helper.transform.rotationDeg = {x:0,y:0,z:0};
  const cube = wireScene.scene.objects.find(o => o.id === C);
  cube.transform.translation = {x:0,y:0,z:0};
  cube.transform.rotationDeg = {x:0,y:0,z:0};
  for (const o of wireScene.scene.objects) o.visible = o === helper || o === cube;
  const wireFile = join(dirname(path), "camera-wire.studio3d");
  await writeFile(wireFile, json(wireScene));
  await openBryce(cdp, wireFile);
  await cdp.evaluate(`${D}.setOrbitPose([0,0,10],[0,0,0])`);
  await until(cdp, `${S}?.visibleIds.join() === "${C}" && ${S}.width === 794 && ${D}.frame.camera.eye[2] === 10`);
  await observeSelection();
  const [mx,my] = await coords(mid);
  const region = {x:Math.floor(mx), y:Math.floor(my), width:1, height:1};
  const shown = await cdp.screenshot(region);
  async function toggleWire(visible) {
    await cdp.evaluate(`document.querySelector('[data-object-id="${helper.id}"] button.tree-action').click()`);
    await until(cdp, `${D}.frame.objects.find(o=>o.id==="${helper.id}").visible === ${visible}`);
    await cdp.evaluate(raf);
  }
  await toggleWire(false);
  assert.deepEqual(await cdp.screenshot(region), shown);
  await toggleWire(true);
  await cdp.click([mx,my]);
  await until(cdp, "selectionCalls.length === 1");
  await cdp.evaluate(raf);
  await record("cube under off-pixel camera wire",mid,C,[C],[[C]],undefined,"forge3d-web (editor enabled)");

  await cdp.evaluate('localStorage.setItem("studio.viewport.renderer","three")');
  await openBryce(cdp, path);
  await until(cdp, `${D}.runtime?.objects.get("${T}")?.children.some(c=>c.userData.forgeTerrain) &&
    document.querySelector("[data-viewport-backend]").textContent.includes("three.js")`);
  await cdp.evaluate(raf);
  await observeSelection();
  await cdp.click(await coords(buried));
  await until(cdp, "selectionCalls.length === 1");
  await cdp.evaluate(raf);
  await record("raw DEM on three.js terrain",buried,T,[T],[[T]],undefined,"three.js");
  const gpuElevation = report.clicks.find(row => row.label === "both" && row.expected === T).actual.elevation;
  assert.ok(Math.abs(report.clicks.at(-1).actual.elevation - gpuElevation) < .001);
  await touchGestures(cdp, { coords, record, sky,
    resetPose: () => cdp.evaluate(`${D}.setOrbitPose(${json(eye)}, ${json(aim)})`) });

  const flat = JSON.parse(await readFile(join(dirname(path), "flat.studio3d")));
  flat.scene.objects.find(o=>o.id===C).transform.translation.y = .8;
  flat.scene.objects.push(sphere);
  // Keep the same editor material in the combined and isolated colour reads,
  // including when hiding the terrain makes its cartography inactive.
  const textureId = "e9cc16ca-ab84-461f-9b49-e8da5c61fb5f";
  const whitePath = join(dirname(path), "white.png");
  const white = await encodePng(1, 1, new Uint8Array([255,255,255,255]));
  await writeFile(whitePath, Buffer.from(await white.arrayBuffer()));
  flat.assets.push({ id:textureId, kind:"orthophoto", name:"White", path:whitePath, byteSize:white.size });
  flat.scene.objects.find(o=>o.id===C).kind.material.texture = textureId;
  for (const o of flat.scene.objects) if (o.kind.type === "camera" || o.kind.type === "light") o.visible = false;
  const flatFile = join(dirname(path), "editor-flat.studio3d");
  await writeFile(flatFile, json(flat));
  for (const pref of ["auto","three"]) {
    await cdp.evaluate(`localStorage.setItem("studio.viewport.renderer",${json(pref)})`);
    await openBryce(cdp, flatFile);
    await cdp.evaluate(`${D}.setOrbitPose([0,12,4],[0,0,0])`);
    await until(cdp,`${D}.runtime?.objects.get("${T}")?.children.some(c=>c.userData.forgeTerrain) &&
      document.querySelector("[data-viewport-backend]").textContent.includes("${pref==="auto"?"WebGPU available":"three.js"}")`);
    await cdp.evaluate(raf);
    await observeSelection();
    await cdp.click(await coords(mid));
    await until(cdp,"selectionCalls.length === 1");
    await cdp.evaluate(raf);
    await record("frontmost flattened editor cube",mid,C,[C],[[C]],undefined,pref==="auto"?"three.js (WebGPU terrain)":"three.js");
    assert.ok(Math.abs(report.clicks.at(-1).actual.worldPosition[1] - .8) < 1e-6);
  }

  const thick = flat.scene.objects.find(o => o.id === C);
  thick.transform.translation.y = -1.002;
  thick.transform.scale.y = 1;
  const nearFile = join(dirname(path), "editor-depth.studio3d");
  await writeFile(nearFile, json(flat));
  for (const pref of ["auto", "three"]) {
    await cdp.evaluate(`localStorage.setItem("studio.viewport.renderer",${json(pref)})`);
    await openBryce(cdp, nearFile);
    await cdp.evaluate(`${D}.setOrbitPose([0,145,20],[0,0,0])`);
    const stable = async (cube, terrain) => {
      await until(cdp, `${D}.runtime && ${D}.frame.objects.find(o=>o.id==="${C}").visible === ${cube} &&
        ${D}.frame.objects.find(o=>o.id==="${T}").visible === ${terrain} &&
        (!${terrain} || ${D}.runtime.objects.get("${T}")?.children.some(c=>c.userData.forgeTerrain)) &&
        document.querySelector("[data-viewport-backend]").textContent.includes("${pref==="auto"?"WebGPU available":"three.js"}")`);
      await cdp.evaluate(raf);
    };
    const toggle = id => cdp.evaluate(`document.querySelector('[data-object-id="${id}"] button.tree-action').click()`);
    const [left, top] = [390,356], width = 18, height = 17;
    const capture = async () => {
      const [x,y] = await coords([left,top]);
      return decodePng(await cdp.screenshot({x:Math.floor(x),y:Math.floor(y),width,height})).data;
    };
    await stable(true,true);
    const both = await capture();
    await toggle(C);
    await stable(false,true);
    const terrainOnly = await capture();
    await toggle(C);
    await stable(true,true);
    await toggle(T);
    await stable(true,false);
    const cubeOnly = await capture();
    await toggle(T);
    await stable(true,true);
    await observeSelection();
    const samples = pref === "auto" ? [[400,365,C],[397,365,C],[400,368,C],[400,370,T]]
      : [[400,366,C],[397,366,C],[394,366,C],[400,363,T]];
    for (const [x,y,id] of samples) {
      const at = 4 * ((y-top)*width + x-left);
      const rgba = image => Array.from(image.subarray(at, at+4));
      const colours = { both:rgba(both), cube:rgba(cubeOnly), terrain:rgba(terrainOnly) };
      assert.notDeepEqual(colours.cube,colours.terrain);
      assert.deepEqual(colours.both,id === C ? colours.cube : colours.terrain);
      await cdp.click(await coords([x,y]));
      await until(cdp, "selectionCalls.length === 1");
      await cdp.evaluate(raf);
      await record("editor cube and DEM depth overlap",[x,y],id,[id],[[id]],undefined,
        pref === "auto" ? "three.js (WebGPU terrain)" : "three.js");
      report.clicks.at(-1).colours = colours;
    }
  }

  const masked = JSON.parse(await readFile(join(dirname(path), "flat.studio3d")));
  masked.selection = [];
  for (const object of masked.scene.objects) object.visible = object.id === T;
  const panel = structuredClone(masked.scene.objects.find(o => o.id === C));
  const maskAsset = "79e847f4-b231-425e-9c11-400000000001";
  panel.id = "79e847f4-b231-425e-9c11-400000000002";
  panel.name = "Cutout";
  panel.visible = true;
  panel.kind.source = { type:"gltf", asset:maskAsset, node:null };
  panel.transform.translation = { x:0, y:.8, z:0 };
  panel.transform.scale = { x:1, y:1, z:1 };
  masked.scene.objects.push(panel);

  // The left half discards every fragment. A recessed opaque strip tests a
  // second intersection with the very same mesh through the front triangle.
  const xyz = [], rgba = [];
  for (const [left,right,y,alpha] of [[-1,0,0,0],[0,1,0,1],[-1,-.72,-.4,1]]) {
    for (const [x,z] of [[left,-1],[left,1],[right,-1],[right,-1],[left,1],[right,1]]) {
      xyz.push(x,y,z); rgba.push(1,1,1,alpha);
    }
  }
  const positions = Buffer.from(new Float32Array(xyz).buffer), colours = Buffer.from(new Float32Array(rgba).buffer);
  const binary = Buffer.concat([positions,colours]), count = xyz.length / 3;
  const maskGlb = binaryGltf({asset:{version:"2.0"},scene:0,scenes:[{nodes:[0]}],nodes:[{mesh:0}],
    extensionsUsed:["KHR_materials_unlit"], meshes:[{primitives:[{attributes:{POSITION:0,COLOR_0:1},material:0}]}],
    materials:[{alphaMode:"MASK",alphaCutoff:.5,doubleSided:true,pbrMetallicRoughness:{baseColorFactor:[1,0,1,1]},
      extensions:{KHR_materials_unlit:{}}}],buffers:[{byteLength:binary.length}],
    bufferViews:[{buffer:0,byteLength:positions.length},{buffer:0,byteOffset:positions.length,byteLength:colours.length}],
    accessors:[{bufferView:0,componentType:5126,count,type:"VEC3",min:[-1,-.4,-1],max:[1,0,1]},
      {bufferView:1,componentType:5126,count,type:"VEC4"}]},binary);
  const singleFaceCases = [
    {label:"terrain through cutout", pixel:[337,348], id:T, y:0},
    {label:"opaque glTF half", pixel:[456,348], id:panel.id, y:.8},
    {label:"recessed face through cutout", pixel:[308,363], id:panel.id, y:.4},
  ];
  const overlappingCases = [
    {label:"terrain between masked copies", pixel:[365,330], id:T, y:0},
    {label:"opaque front copy", pixel:[457,330], id:panel.id, y:.8},
    {label:"terrain through both cutouts", pixel:[291,330], id:T, y:0},
  ];

  const thinCases = [
    {label:"fully transparent", pixel:[327,325], id:T, y:0, alone:null},
    {label:"opaque control", pixel:[466,325], id:panel.id, y:.8, alone:panel.id},
    {label:"transparent front, opaque rear", pixel:[323,424], id:T, y:0, alone:panel.id, rearY:-.8},
    {label:"partial opacity", pixel:[470,424], id:panel.id, y:.8, alone:panel.id},
  ];
  const posedCases = [
    {label:"vacated opaque primitive", pixel:[466,325], id:T, y:0, alone:null},
    {label:"displaced opaque primitive", pixel:[615,325], id:panel.id, y:.8, alone:panel.id},
    {label:"vacated partial opacity", pixel:[470,424], id:T, y:0, alone:null},
    {label:"displaced partial opacity", pixel:[628,424], id:panel.id, y:.8, alone:panel.id},
  ];
  const overTerrainAndBackground = entries => entries.map(([label,pixel,id]) => ({
    label,pixel,id,y:id === T ? 0 : .8,alone:id === T ? null : id,
  }));
  const rasterCases = overTerrainAndBackground([
    ["flattened imported triangle",[466,325],panel.id],["combined triangle morphs",[615,325],panel.id],
    ["vacated triangle position",[498,325],T],["centred stroke",[442,318],panel.id],
    ["sample-covered strokes",[464,318],panel.id],["uncovered next to stroke",[467,318],T],
    ["centred point",[442,353],panel.id],["sample-covered points",[464,353],panel.id],
    ["uncovered next to point",[467,353],T],
    ["opaque triangle between samples",[458,318],T],["masked triangle between samples",[483,318],T],
    ["opaque triangle strips across samples",[458,353],panel.id],["masked triangle strips across samples",[483,353],panel.id],
    ["opaque face with zero stored alpha",[534,379],panel.id],
    ["large-coordinate line",[498,242],panel.id],["large-coordinate point",[499,258],panel.id],
    ["CPU-projected line position",[539,242],T],["CPU-projected point position",[540,258],T],
  ]);
  // Across this pixel the strips slope from Y=-.075 to just below ground.
  // Their planes reach about +.005 on the centre ray used for diagnostics.
  rasterCases.push({label:"terrain occluding sloped strips",pixel:[508,353],id:T,y:0,alone:panel.id,rearY:[-.08,.01]});
  const skinCases = overTerrainAndBackground([["visible face after Inspector move",[466,325],panel.id]]);
  const surveyCases = overTerrainAndBackground([
    ["outside submitted triangle",[478,325],T],["inside submitted triangle",[360,325],panel.id],
  ]);
  const bakedColours = new Map();
  for (const [representation,pose] of [
    ["cutout"],["nodes"],["instances"],["points"],["lines"],
    ["points","baked"],["lines","baked"],["points","morph"],["lines","morph"],["raster"],["skinned"],["survey"],
  ]) {
    const name = pose ? pose + "-" + representation : representation;
    const thin = representation === "points" || representation === "lines";
    const raster = representation === "raster";
    const skinned = representation === "skinned", survey = representation === "survey";
    const checkBackground = thin || raster || skinned || survey;
    const stacked = representation === "nodes" || representation === "instances";
    let glb = maskGlb;
    if (stacked || thin) {
      const {document, binary} = thin ? thinCutouts(representation === "points",pose) : overlappingCutouts(representation === "instances");
      glb = binaryGltf(document, binary);
    }
    if (raster || skinned || survey) {
      const {document,binary} = raster ? triangleStrokeFixture() : transformedTriangleFixture(skinned);
      glb = binaryGltf(document,binary);
    }
    panel.transform.translation.y = representation === "cutout" || raster || survey ? .8 : 0;
    panel.transform.translation.x = survey ? .4 : 0;
    const assetPath = join(dirname(path),name + ".glb");
    const projectPath = join(dirname(path),name + ".studio3d");
    await writeFile(assetPath,glb);
    const asset = {id:maskAsset,kind:"glb",name:name + ".glb",path:assetPath,byteSize:glb.length};
    await writeFile(projectPath,json({...masked,assets:[...masked.assets,asset]}));
    const cases = {raster:rasterCases,skinned:skinCases,survey:surveyCases}[representation]
      ?? (pose ? posedCases : thin ? thinCases : stacked ? overlappingCases : singleFaceCases);
    for (const pref of ["auto","three"]) {
      await cdp.evaluate(`localStorage.setItem("studio.viewport.renderer",${json(pref)})`);
      await openBryce(cdp,projectPath);
      await cdp.evaluate(`${D}.setOrbitPose([0,8,4],[0,0,0])`);
      const ready = `(() => {
        const runtime = ${D}.runtime;
        let count = 0;
        runtime?.objects.get("${panel.id}")?.traverse(o => {
          if (${raster} && (o.isMesh || o.isLine || o.isPoints)) count++;
          else if ((${skinned} && o.isSkinnedMesh) || (${survey} && o.isMesh && o.geometry.attributes.position.getX(1) === 10_000_000)) count++;
          else if (${thin} && (o.isLine || o.isPoints) && (!${pose === "morph"} || o.morphTargetInfluences?.join() === "0.5,0.25")) count++;
          else if (o.isMesh && o.material.alphaTest === .5 && Boolean(o.isInstancedMesh) === ${representation === "instances"}
            && (!${stacked} || o.material.map?.image)) count += o.isInstancedMesh ? o.count : 1;
        });
        return count === ${raster ? 9 : thin ? 4 : stacked ? 2 : 1} && runtime?.objects.get("${T}")?.children.some(c=>c.userData.forgeTerrain);
      })()`;
      await until(cdp,ready);
      if (skinned) {
        await cdp.evaluate(raf);
        await cdp.evaluate(`document.querySelector('[data-object-id="${panel.id}"]').click()`);
        await until(cdp,`document.querySelector('[data-object-id="${panel.id}"]').getAttribute("aria-selected") === "true"`);
        await cdp.evaluate(`document.querySelector('button[title^="Object:"]')?.click()`);
        const input = `[...document.querySelectorAll(".group-label")].find(el => el.textContent.trim() === "Translation")
          ?.previousElementSibling?.querySelector("input")`;
        if (!await cdp.evaluate(`Boolean(${input})`)) {
          await cdp.evaluate(`[...document.querySelectorAll("button")].find(b => b.textContent.trim() === "Transform")?.click()`);
        }
        await until(cdp,`Boolean(${input})`);
        await cdp.evaluate(`{ const field = ${input}; field.focus(); field.select(); }`);
        await cdp.send("Input.insertText",{text:"1.4"});
        await cdp.evaluate("document.activeElement.blur()");
        await until(cdp,`Math.abs(${D}.runtime.objects.get("${panel.id}").position.x - 1.4) < 1e-6`);
        await cdp.evaluate(`document.querySelector('[data-object-id="${panel.id}"]')
          .dispatchEvent(new MouseEvent("click", { bubbles:true, ctrlKey:true }))`);
        await until(cdp,`!document.querySelector('[role=treeitem][aria-selected=true]')`);
      }
      const visible = async (id,on) => {
        await cdp.evaluate(`document.querySelector('[data-object-id="${id}"] button.tree-action').click()`);
        await until(cdp,`${D}.frame.objects.find(o=>o.id==="${id}").visible === ${on}`);
        await cdp.evaluate(raf);
      };
      const capture = async () => {
        const pixels = [];
        for (const {pixel} of cases) {
          const [x,y] = await coords(pixel);
          pixels.push([...decodePng(await cdp.screenshot({x:Math.floor(x),y:Math.floor(y),width:1,height:1})).data]);
        }
        return pixels;
      };
      await cdp.evaluate(raf);
      const both = await capture();
      await visible(panel.id,false);
      const ground = await capture();
      await visible(T,false);
      const background = checkBackground ? await capture() : undefined;
      await visible(panel.id,true);
      const mesh = await capture();
      if (raster) {
        for (const [control,pair] of [[3,4],[6,7],[0,11],[0,12]]) {
          assert.deepEqual(both[pair],both[control],"all samples match the centred opaque control");
          assert.deepEqual(both[pair],mesh[pair],"fully covered pixel with and without terrain");
        }
        assert.deepEqual(mesh.at(-1),mesh[0],"the sloped strips cover the solid control colour with terrain hidden");
      }
      if (pose) {
        const key = representation + "-" + pref, colours = {both,ground,background,mesh};
        if (pose === "baked") bakedColours.set(key,colours);
        else assert.deepEqual(colours,bakedColours.get(key),key + " morph and baked framebuffer samples");
      }
      await visible(T,true);
      await until(cdp,ready);
      if (pref === "auto") await until(cdp,`${S}?.visibleIds.includes("${T}")`);
      await cdp.evaluate(raf);
      assert.deepEqual(await capture(),both);
      await observeSelection();
      const checkHit = async (label,pixel,id,y,backend) => {
        await cdp.click(await coords(pixel));
        await until(cdp,"selectionCalls.length === 1");
        await cdp.evaluate(raf);
        const ids = id ? [id] : [];
        await record(representation === "cutout" ? label : name + ": " + label,pixel,id,ids,[ids],undefined,backend);
        const row = report.clicks.at(-1);
        if (Array.isArray(y)) assert.ok(row.actual.worldPosition[1] >= y[0] && row.actual.worldPosition[1] <= y[1],label + " hit height");
        else if (id) assert.ok(Math.abs(row.actual.worldPosition[1] - y) < (checkBackground && id === panel.id ? .01 : 1e-6), label + " hit height");
        if (id === T) assert.equal(row.actual.elevation,2000);
        return row;
      };
      for (const [i,{label,pixel,id,y}] of cases.entries()) {
        if (checkBackground) {
          assert.equal(JSON.stringify(both[i]) === JSON.stringify(ground[i]),id === T,label + " over terrain");
          assert.equal(JSON.stringify(mesh[i]) === JSON.stringify(background[i]),cases[i].alone === null,label + " over background");
        } else {
          assert.notDeepEqual(ground[i],mesh[i]);
          assert.deepEqual(both[i],id === T ? ground[i] : mesh[i]);
        }
        const backend = pref === "auto" ? (id === T ? "forge3d-web (editor enabled)" : "three.js (WebGPU terrain)") : "three.js";
        const row = await checkHit(label,pixel,id,y,backend);
        row.colours = {both:both[i],ground:ground[i],mesh:mesh[i],background:background?.[i]};
      }
      await visible(T,false);
      if (checkBackground) {
        if (survey) await checkHit("clear transform gizmo",[60,80],null,undefined,"three.js");
        for (const {label,pixel,alone,rearY,y} of cases) {
          await checkHit(label + " with terrain hidden",pixel,alone,rearY ?? y,"three.js");
        }
      } else if (stacked) {
        assert.deepEqual(mesh[0],mesh[1], "the exposed rear and opaque front share the same colour");
        await checkHit("exposed rear copy",cases[0].pixel,panel.id,-.8,"three.js");
      } else {
        await checkHit("background through cutout",cases[0].pixel,null,undefined,"three.js");
      }
    }
  }

  // A glTF POINTS primitive with one float32 position at its local origin.
  const dotId="eb2bdb3b-49ff-4ad3-90a4-e2f7bc933762", assetId="24753778-3dc4-42d3-865e-3155fc29bb4f";
  const gltf = { asset:{version:"2.0"},scene:0,scenes:[{nodes:[0]}],nodes:[{mesh:0}],
    meshes:[{primitives:[{mode:0,attributes:{POSITION:0}}]}],buffers:[{byteLength:12}],
    bufferViews:[{buffer:0,byteOffset:0,byteLength:12,target:34962}],
    accessors:[{bufferView:0,componentType:5126,count:1,type:"VEC3",min:[0,0,0],max:[0,0,0]}] };
  const glb = binaryGltf(gltf,Buffer.alloc(12));
  const glbFile=join(dirname(path),"one-point.glb");
  await writeFile(glbFile,glb);
  const pointScene=structuredClone(wireScene), dot=structuredClone(cube);
  pointScene.scene.objects.find(o=>o.id===helper.id).visible=false;
  dot.id=dotId; dot.kind.source={type:"gltf",asset:assetId,node:null}; dot.transform.translation={x:.65,y:0,z:4};
  pointScene.scene.objects.push(dot);
  pointScene.assets.push({id:assetId,kind:"glb",name:"one-point.glb",path:glbFile,byteSize:glb.length});
  const pointFile=join(dirname(path),"point.studio3d");
  await writeFile(pointFile,json(pointScene));
  await cdp.evaluate('localStorage.setItem("studio.viewport.renderer","three")');
  await openBryce(cdp,pointFile);
  await cdp.evaluate(`${D}.setOrbitPose([0,0,10],[0,0,0])`);
  await until(cdp,`!!${D}.runtime?.objects.get("${dotId}")?.getObjectByProperty("isPoints",true)`);
  await cdp.evaluate(raf);
  await observeSelection();
  for (const [label, pixel, id] of [["cube beside glTF point",mid,C],["glTF point on its pixel",[492,363],dotId]]) {
    await cdp.click(await coords(pixel));
    await until(cdp,"selectionCalls.length === 1");
    await cdp.evaluate(raf);
    await record(label,pixel,id,[id],[[id]],undefined,"three.js");
  }
  await mipmappedCutoutControl(cdp, { root, dir:dirname(path), openBryce, observeSelection, coords, record });
  report.terrainHierarchy = await terrainHierarchy(cdp, fixture, join(dirname(path), "parented-terrain.studio3d"), openBryce);
}

try {
  await desktop({ root, field:fieldCheckout(root), out, values:{}, report, role:"candidate", metrics:{width:1440,height:833},
    candidatePlugins:[pinnedExampleServer(root)], observeCandidate: cdp => cdp.send("Page.addScriptToEvaluateOnNewDocument",
      {source:`(${observeContexts})(false, "document")`}) }, async cdp => {
    await studio(cdp);
    await terrainEdgeControl(cdp, path, join(dirname(path), "flat-solid.studio3d"), report);
    report.vector = await vectorExample(cdp);
  });
  await desktop({root,field:fieldCheckout(root),out,values:{},report,role:"editor",metrics:{width:1440,height:833}}, editorControl);
  report.passed = true;
} finally {
  await writeFile(join(out, "results.json"), json(report, null, 2) + "\n");
  const rows = [["mode","backend","case","DPR","pixel","expected UUID","actual UUID","kind","world position",
    "distance","raw DEM elevation (m)","frame revision","projected pixel centre","disposition","selected IDs","selected tree rows","selection calls"]];
  for (const r of report.clicks) {
    const h = r.actual;
    rows.push([r.mode,r.backend,r.label,r.dpr,r.pixel,r.expected ?? "null",h?.id ?? "null",h?.kind,h?.worldPosition,
      h?.distance,h?.elevation,r.frameRevision,r.projected && [r.projected.x,r.projected.y],r.disposition,r.selected,r.rows,r.calls]);
  }
  const csv = rows.map(row => row.map(value => {
    const field = Array.isArray(value) ? json(value) : String(value ?? "");
    return '"' + field.replaceAll('"', '""') + '"';
  }).join(",")).join("\n");
  await writeFile(join(out, "clicks.csv"), csv + "\n");
}
