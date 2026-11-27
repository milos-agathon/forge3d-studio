import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { gzipSync } from "node:zlib";
import { decodePng } from "../node_modules/@forge3d/web/dist/png-decode.js";
import "./prepare-viewport-runtime.mjs";
import { createFixture, CUBE_ID, FIELD_REVISION, TERRAIN_ID, verifyProvenance } from "./vp01/fixture.mjs";
import { observeContexts } from "./vp01/startup.mjs";
import { sha256 } from "./vp03/identity.mjs";
import { desktop, fieldCheckout, until } from "./viewport-desktop.mjs";
import { inspect, readFrame } from "./vp05/page.mjs";
import { checkTransforms, checkHelperTerrain } from "./vp05/transforms.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
process.env.PYTHONDONTWRITEBYTECODE = "1";
process.env.FORGE3D_STUDIO_PYTHON ??= execFileSync("python", ["-c", "import sys; print(sys.executable)"], { encoding: "utf8" }).trim();
const { values } = parseArgs({ options: { field: { type: "string" }, shell: { type: "string" },
  "field-shell": { type: "string" }, out: { type: "string" } } });
const field = fieldCheckout(root, values.field);
const out = values.out ? resolve(values.out) : await mkdtemp(join(tmpdir(), "studio-vp05-"));
if (values.out) await mkdir(out);
console.log("VP-05 evidence", out);
const evidence = join(out, "evidence");
await mkdir(evidence);
const { path } = await createFixture(join(out, "fixture"));
const fixture = JSON.parse(await readFile(path));
const terrain = fixture.scene.objects.find(o => o.id === TERRAIN_ID);
delete terrain.kind.overlay;
fixture.assets = fixture.assets.filter(a => a.id === terrain.kind.asset);
fixture.viewport.mode = "solid";
await writeFile(path, JSON.stringify(fixture));
const report = { base: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
  field: FIELD_REVISION, runtime: (await verifyProvenance()).commit, modes: {} };
report.sourceSha256 = {};
for (const file of ["src/viewport/Viewport3D.tsx", "src/viewport/viewportState.ts", "src/viewport/forge3dWebViewport.ts", "src/viewport/forge3dWebMapping.ts",
  "src/viewport/viewportObjects.ts", "src/viewport/materialHelpers.ts", "src/viewport/materialHelpers.wgsl",
  "scripts/viewport-desktop.mjs", "scripts/vp05.mjs", "scripts/vp05/page.mjs", "scripts/vp05/transforms.mjs"]) {
  report.sourceSha256[file] = sha256(await readFile(join(root, file)));
}
const width = 794, height = 727, n = width * height;
const front = [398, 346];
// Field's orbit starts pointing at (0, .8, 0); leaving fly mode on mount
// places the orbit target ten units along that same viewing ray.
const eye = [9.5, 7, 11], direction = [-9.5, -6.2, -11];
const aim = eye.map((v,i) => v + 10 * direction[i] / Math.hypot(...direction));
const expectedPose = [eye, aim, 45, 0.05, 2000];
const reference = {};
const raf = "new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))";

function maskIou(a, b) {
  let intersection = 0, union = 0;
  for (let i = 0; i < a.length; i++) {
    intersection += a[i] & b[i];
    union += a[i] | b[i];
  }
  return intersection / union;
}

async function editAndDelete(cdp, state, fieldMask) {
  const edit = async (label, value) => {
    const input = `[...document.querySelectorAll("label.field")].find(el => el.textContent.trim() === "${label}")?.querySelector("input")`;
    await until(cdp, `!!(${input})`);
    await cdp.evaluate(`{ const el = ${input}; el.focus(); el.select(); }`);
    await cdp.send("Input.insertText", { text: String(value) });
    await cdp.evaluate("document.activeElement.blur()");
  };
  const read = async () => Buffer.from(await cdp.evaluate(`(${readFrame})(false)`), "base64");
  await cdp.evaluate(`[...document.querySelectorAll(".tree-name")].find(el => el.textContent === "VP-01 cube").click();
    document.querySelector('button[title^="Object:"]').click()`);
  const node = `forge3dViewportDiagnostics().frame.objects.find(o => o.id === "${CUBE_ID}")`;
  const before = await read();
  await edit("B", 0);
  await until(cdp, node + ".kind.material.baseColor[2] === 0");
  await cdp.evaluate(raf);
  const red = await read();
  // Independent attribution: change only the cube's authored blue channel,
  // then compare every pixel. This mask has no silhouette or hue filter.
  const changeMask = Buffer.alloc(n);
  for (let p = 0; p < n; p++) changeMask[p] = Number(before[4*p+2] !== red[4*p+2]);
  const materialEditIou = maskIou(changeMask, fieldMask);
  assert.ok(materialEditIou >= 0.97, "Material-only edit vs. Field cube mask: " + materialEditIou);
  await writeFile(join(evidence, "candidate-material-edit.mask"), changeMask);
  await edit("X", 3.25);
  await until(cdp, node + ".translation[0] === 3.25");
  await cdp.evaluate(raf);
  const moved = await read();
  await cdp.evaluate(`document.querySelector('button[title^="Delete ("]').click()`);
  await until(cdp, `!${node} && ${state}.cubeBatches === 0`);
  const stats = (await cdp.evaluate(state)).stats;
  assert.equal((await cdp.evaluate(state)).cubeBatches, 0);
  return { editedBluePixels: changeMask.reduce((a,b) => a+b, 0), materialEditIou, deleted: stats, moved };
}

async function captureRole(role) {
  const isField = role === "field";
  await desktop({ root, field, out, values, report, role, metrics: { width: 1440, height: 833 },
    observeCandidate: async cdp => {
      report.contexts = [];
      await cdp.send("Runtime.enable");
      await cdp.send("Runtime.addBinding", { name: "__vp01RecordContext" });
      cdp.on("Runtime.bindingCalled", ({name, payload}) => {
        if (name !== "__vp01RecordContext") return;
        const request = JSON.parse(payload);
        if (request.requested.includes("webgl")) report.contexts.push(request);
      });
      const source = `(${observeContexts})(false, "document")`;
      await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source });
      await cdp.evaluate(source);
    } }, async cdp => {
    await cdp.evaluate(`localStorage.setItem("studio.viewport.mapGrid","0"); localStorage.removeItem("studio.viewport.renderer");
      __TAURI_INTERNALS__.invoke("open_project", {path:${JSON.stringify(path)}})`);
    await cdp.evaluate("window.vp05Leaving = true");
    await cdp.send("Page.reload", { ignoreCache: true });
    await until(cdp, "!window.vp05Leaving && document.readyState === 'complete'");
    await cdp.evaluate(`document.querySelector('.recovery button[aria-label="Dismiss"]')?.click()`);
    const state = `(${inspect})(${isField}, "${CUBE_ID}", "${TERRAIN_ID}")`;
    const settle = async (mode, cube, ground) => {
      await until(cdp, `(s => s?.ready && s.mode === "${mode}" && s.cube === ${cube} && s.terrain === ${ground}
        && (${isField} || s.cubeBatches === ${Number(cube)}))(${state})`);
      await cdp.evaluate(raf);
    };
    await settle("solid", true, true);
    if (!isField) await cdp.evaluate(`forge3dViewportDiagnostics().setOrbitPose(${JSON.stringify(eye)},${JSON.stringify(aim)})`);
    const physical = (await cdp.evaluate(state)).physical;
    if (physical[0] !== width || physical[1] !== height) {
      await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1440 + width - physical[0],
        height: 833 + height - physical[1], deviceScaleFactor: 1, mobile: false });
      await until(cdp, `${state}.physical.join() === "794,727"`);
    }
    const toggle = async name => {
      await cdp.evaluate(`[...document.querySelectorAll(".tree-name")].find(el => el.textContent === ${JSON.stringify(name)})
        .closest(".tree-row").querySelector("button.tree-action").click()`);
    };
    for (const mode of ["solid", "material"]) {
      if (mode === "material") {
        await cdp.evaluate(`document.querySelector('button[title^="Material preview"]').click()`);
        await toggle("VP-01 cube");
      }
      const frames = {};
      const lane = (report.modes[mode] ??= {})[role] = { frames: {} };
      const capture = async (name, cube, ground) => {
        await settle(mode, cube, ground);
        const s = await cdp.evaluate(state);
        assert.equal(s.dpr, 1);
        assert.equal(s.preference, "auto");
        assert.equal(s.editor, isField);
        assert.deepEqual(s.physical, [width, height]);
        if (ground) {
          assert.equal(s.resolution, 96);
          if (isField) assert.ok(Object.values(s.layers).every(v => !v), JSON.stringify(s.layers));
        }
        expectedPose.flat().forEach((v, i) => assert.ok(Math.abs(s.camera.flat()[i] - v) < 1e-7, "VP-01 camera " + JSON.stringify(s.camera)));
        if (!isField) {
          assert.equal(s.cubeBatches, Number(cube));
        }
        const rgba = Buffer.from(await cdp.evaluate(`(${readFrame})(${isField})`), "base64");
        assert.equal(rgba.length, n*4);
        const png = await cdp.screenshot(s.viewport);
        const screen = decodePng(png);
        assert.deepEqual([screen.width, screen.height], s.physical);
        const stem = `${role}-${mode}-${name}`;
        if (["both","noCube","noTerrain"].includes(name)) {
          await writeFile(join(evidence, stem + ".png"), png);
          await writeFile(join(evidence, stem + ".rgba.gz"), gzipSync(rgba));
        }
        frames[name] = { rgba, screen: screen.data };
        lane.frames[name] = s;
      };
      await capture("both", true, true);
      const { project } = await cdp.evaluate('__TAURI_INTERNALS__.invoke("project_state")');
      const settings = { visibleLayers: project.cartography.filter(l => l.visible).map(l => l.type),
        mode: project.viewport.mode, hillshade: project.viewport.hillshade, grid: project.viewport.gridVisible,
        shadows: project.render.shadows, terrainShadows: project.render.sunVisibility, hdri: project.render.environment,
        cube: project.scene.objects.find(o => o.id === CUBE_ID), ibl: project.render.iblIntensity };
      assert.deepEqual(settings.visibleLayers, ["relief"]);
      assert.equal(settings.mode, mode);
      assert.equal(settings.hillshade || settings.grid || settings.shadows || settings.terrainShadows, false);
      assert.equal(settings.hdri, null);
      assert.deepEqual(settings.cube.transform.translation, { x: 0, y: 0.85, z: 0 });
      assert.deepEqual(settings.cube.kind.material.baseColor, [1, 0, 1]);
      assert.deepEqual(settings.cube.kind.source.primitive, { type: "cube", size: 2 });
      lane.settings = settings;
      await toggle("VP-01 cube");
      await capture("noCube", false, true);
      await toggle(terrain.name);
      await capture("empty", false, false);
      await toggle("VP-01 cube");
      await capture("noTerrain", true, false);
      await toggle(terrain.name);
      await capture("replay", true, true);
      await toggle("VP-01 cube");
      await capture("terrainControl", false, true);
      if (!isField) for (const key of ["effectiveDraws","visibleInstances","totalInstances"]) {
        assert.equal(lane.frames.both.stats[key] - lane.frames.noCube.stats[key], 1, "Bryce cube " + key);
        assert.equal(lane.frames.noTerrain.stats[key] - lane.frames.empty.stats[key], 1, "isolated cube " + key);
      }
      const masks = {};
      const at = (point, channel) => 4 * (point[1]*width + point[0]) + channel;
      const diff = (a, b, i) => Math.max(...[0,1,2,3].map(k => Math.abs(a[i+k] - b[i+k])));
      for (const name of ["both","noCube","noTerrain","replay"]) {
        const pixels = frames[name].rgba;
        const mask = Buffer.alloc(n);
        let strictMagenta = 0;
        for (let p = 0; p < n; p++) {
          const i = p*4;
          const silhouette = diff(frames.noTerrain.rgba, frames.empty.rgba, i) > 4;
          const changed = diff(pixels, name === "noTerrain" ? frames.empty.rgba : frames.terrainControl.rgba, i) > 0;
          const magentaHue = pixels[i] > pixels[i+1] && pixels[i+2] > pixels[i+1];
          mask[p] = Number(silhouette && changed && (mode === "solid" || magentaHue));
          if (pixels[i] > pixels[i+1]+24 && pixels[i+2] > pixels[i+1]+24 && pixels[i+3] > 200) strictMagenta++;
        }
        if (mode === "material") lane.frames[name].vp01MagentaPixels = strictMagenta;
        lane.frames[name].maskPixels = mask.reduce((a,b) => a+b, 0);
        masks[name] = mask;
        if (name !== "replay") await writeFile(join(evidence, `${role}-${mode}-${name}.mask`), mask);
      }
      assert.deepEqual(masks.replay, masks.both, "recreated terrain/cube mask");
      assert.ok(lane.frames.both.maskPixels > 0 && lane.frames.noTerrain.maskPixels > lane.frames.both.maskPixels);
      assert.equal(lane.frames.noCube.maskPixels, 0);
      if (isField) {
        // Pick a buried point strictly inside a 9x9 patch of the Field cube projection.
        const buried = [];
        for (let y = 4; y < height-4; y++) for (let x = 4; x < width-4; x++) {
          const p = y*width+x;
          if (!masks.noTerrain[p] || masks.both[p]) continue;
          let interior = true;
          for (let dy = -4; dy <= 4 && interior; dy++) for (let dx = -4; dx <= 4; dx++) {
            const q = p + dy*width + dx;
            if (!masks.noTerrain[q] || masks.both[q]) { interior = false; break; }
          }
          if (interior) buried.push([x,y]);
        }
        assert.ok(buried.length);
        reference[mode] = { mask: masks.both, buried: reference.solid?.buried ?? buried[Math.floor(buried.length/2)] };
      } else {
        assert.deepEqual(settings, report.modes[mode].field.settings);
        lane.iou = maskIou(masks.both, reference[mode].mask);
        if (mode === "material") assert.ok(lane.iou >= 0.97, "Material cube-mask IoU " + lane.iou);
      }
      lane.probes = {};
      for (const [label, point] of Object.entries({ front, buried: reference[mode].buried })) {
        const p = at(point, 0);
        assert.equal(masks.both[p/4], Number(label === "front"));
        assert.equal(masks.noTerrain[p/4], 1);
        const records = lane.probes[label] = { point, frontmost: label === "front" ? "cube" : "terrain" };
        for (const source of ["rgba", "screen"]) {
          const rgb = records[source] = {};
          for (const name of ["both","noCube","noTerrain"]) rgb[name] = Array.from(frames[name][source].subarray(p,p+3));
          const distance = (a,b) => Math.max(...a.map((v,i) => Math.abs(v-b[i])));
          const revealed = label === "front" ? "noCube" : "noTerrain";
          const held = label === "front" ? "noTerrain" : "noCube";
          assert.ok(distance(rgb.both, rgb[held]) <= 3 && distance(rgb.both, rgb[revealed]) > 4,
            JSON.stringify({ role, mode, label, source, rgb }));
          for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
            const i = at([point[0]+dx, point[1]+dy], 0);
            assert.ok(diff(frames.both[source], frames[held][source], i) <= 3 &&
              diff(frames.both[source], frames[revealed][source], i) > 4,
              `${role} ${mode} ${label} ${source} patch offset (${dx},${dy})`);
          }
          rgb.patchPixels = 81;
        }
        if (!isField) assert.ok(frames.noCube.rgba[p+3] > 200, "terrain behind probe");
      }
      console.log(role, mode, "cube pixels", lane.frames.both.maskPixels, "exposed", lane.frames.noTerrain.maskPixels,
        ...(isField ? [] : ["IoU", lane.iou]));
      if (!isField && mode === "material") {
        await toggle("VP-01 cube");
        await settle(mode, true, true);
        const { moved, ...edits } = await editAndDelete(cdp, state, reference[mode].mask);
        edits.vacatedPixel = Array.from(moved.subarray(at(front,0), at(front,0)+4));
        assert.deepEqual(edits.vacatedPixel, Array.from(frames.noCube.rgba.subarray(at(front,0), at(front,0)+4)));
        lane.edits = edits;
      }
    }
    if (!isField) {
      report.transforms = await checkTransforms(cdp, { path, fixture, eye, state, settle, toggle, terrainName: terrain.name });
      report.helperTerrain = await checkHelperTerrain(cdp,{path,fixture,settle,toggle});
      assert.ok(report.contexts.length);
      report.successfulWebGL = report.contexts.filter(c => c.result).length;
      assert.equal(report.successfulWebGL, 0);
    }
  });
}
try {
  await captureRole("field");
  await captureRole("candidate");
  await desktop({ root, field, out, values, role: "editor", port: values.port ? Number(values.port) : undefined, report }, async cdp => {
    await cdp.evaluate(`__TAURI_INTERNALS__.invoke("open_project", {path:${JSON.stringify(path)}})`);
    await cdp.send("Page.reload", { ignoreCache: true });
    await until(cdp, `window.forge3dViewportDiagnostics?.().runtime?.objects.has("${CUBE_ID}") &&
      !!forge3dViewportDiagnostics().terrainViewport.diagnosticSubmission?.terrain &&
      forge3dViewportDiagnostics().terrainViewport.diagnosticRuntime.getScatterStats().effectiveDraws === 1`);
    report.editorDraw = await cdp.evaluate(`(async () => {
      const r = forge3dViewportDiagnostics().runtime, mesh = r.objects.get("${CUBE_ID}").children[0];
      const gl = r.renderer.getContext(), after = mesh.onAfterRender;
      return new Promise(resolve => {
        mesh.onAfterRender = function(...args) {
          after.apply(this,args);
          mesh.onAfterRender = after;
          resolve({ colorMask: Array.from(gl.getParameter(gl.COLOR_WRITEMASK)), depthWrite: gl.getParameter(gl.DEPTH_WRITEMASK) });
        };
        r.needsRender = true;
      });
    })()`);
    assert.deepEqual(report.editorDraw, { colorMask: [false,false,false,false], depthWrite: true });
  });
  report.passed = true;
} catch (error) {
  report.error = error.stack;
  throw error;
} finally {
  await writeFile(join(evidence, "results.json"), JSON.stringify(report, null, 2) + "\n");
}
