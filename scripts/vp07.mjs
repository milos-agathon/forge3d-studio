import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Group, PerspectiveCamera, Scene, Vector3 } from "three";
import { TransformControls } from "three/addons/controls/TransformControls.js";
import "./prepare-viewport-runtime.mjs";
import { createFixture, CUBE_ID, TERRAIN_ID, FIELD_REVISION, verifyProvenance } from "./vp01/fixture.mjs";
import { observeContexts } from "./vp01/startup.mjs";
import { desktop, fieldCheckout, until } from "./viewport-desktop.mjs";
import { reviewCases } from "./vp07-review.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const out = await mkdtemp(join(tmpdir(), "studio-vp07-"));
console.log("VP-07 evidence", out);
process.env.PYTHONDONTWRITEBYTECODE = "1";
process.env.FORGE3D_STUDIO_PYTHON ??= execFileSync("python", ["-c", "import sys; print(sys.executable)"], { encoding: "utf8" }).trim();
const { path } = await createFixture(join(out, "fixture"));
const originalBryce = JSON.parse(await readFile(path));
const fixture = structuredClone(originalBryce);
const ground = fixture.scene.objects.find(o => o.id === TERRAIN_ID);
delete ground.kind.overlay;
fixture.assets = fixture.assets.filter(a => a.id === ground.kind.asset);
const git = (...args) => execFileSync("git", args, {cwd:root,encoding:"utf8"}).trimEnd();
const matchesIndex = !git("diff","--name-only") && !git("ls-files","--others","--exclude-standard");
const report = { base: git("rev-parse","HEAD"), testedTree: matchesIndex ? git("write-tree") : undefined,
  runtime: (await verifyProvenance()).commit, reference: FIELD_REVISION, modes: {} };

const D = "forge3dViewportDiagnostics()", S = D + ".terrainViewport.diagnosticSubmission";
const grip = 'document.querySelector(".world-x-grip")';
const state = '__TAURI_INTERNALS__.invoke("project_state")';
const raf = "new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))";
const eye = [9.5, 7, 11], dir = [-9.5, -6.2, -11];
const aim = eye.map((v, i) => v + 10 * dir[i] / Math.hypot(...dir));
const cube = snapshot => snapshot.project.scene.objects.find(o => o.id === CUBE_ID);
const json = JSON.stringify;

// Replay the measured CSS coordinates through Field Instrument's actual
// transform control. Its hit tests and world-axis drag plane run without GL.
function fieldDrag(trace, transform) {
  const camera = new PerspectiveCamera(45,794/727,.05,2000);
  camera.position.fromArray(eye);
  camera.lookAt(new Vector3(...aim));
  const scene = new Scene(), object = new Group(), control = new TransformControls(camera);
  scene.add(object, control.getHelper());
  const {x,y,z} = transform.translation;
  object.position.set(x,y,z);
  control.setSize(.85);
  control.setSpace("world");
  control.attach(object);
  scene.updateMatrixWorld(true);
  const pointer = (e,button) => ({x:2*e.x/794-1,y:1-2*e.y/727,button});
  const down = pointer(trace.find(e=>e.type==="pointerdown"),0);
  control.pointerHover(down);
  assert.equal(control.axis,"X","the measured grip must also hit Field's X axis");
  scene.updateMatrixWorld(true);
  control.pointerDown(down);
  for (const e of trace.filter(e=>e.type==="pointermove")) control.pointerMove(pointer(e,-1));
  control.pointerUp(pointer(trace.find(e=>e.type==="pointerup"),0));
  return object.position.x;
}

function instrument() {
  window.probe = { calls: [], trace: [] };
  const fetch = window.fetch;
  window.fetch = function(resource, init) {
    const url = new URL(resource instanceof Request ? resource.url : resource, location.href);
    if (url.hostname === "ipc.localhost") {
      const cmd = decodeURIComponent(url.pathname.slice(1));
      if (cmd === "plugin:dialog|save" || cmd === "plugin:dialog|open") {
        return Promise.resolve(new Response(JSON.stringify(probe.path), {
          headers: { "Content-Type": "application/json", "Tauri-Response": "ok" },
        }));
      }
      if (["apply_command", "undo", "redo", "set_selection", "save_project", "open_project", "close_project"].includes(cmd)) {
        probe.calls.push({ cmd, args: JSON.parse(init.body) });
      }
    }
    return fetch.apply(this, arguments);
  };
  for (const type of ["pointerdown", "pointermove", "pointerup", "pointercancel", "gotpointercapture", "lostpointercapture"]) {
    window.addEventListener(type, e => {
      if (type === "pointerdown") probe.pointer = e.pointerId;
      const r = document.querySelector(".viewport-canvas--terrain")?.getBoundingClientRect();
      if (r) probe.trace.push({ type, id: e.pointerId, device: e.pointerType, buttons: e.buttons,
        captured: document.querySelector(".world-x-grip")?.hasPointerCapture(e.pointerId),
        x: e.clientX - r.left, y: e.clientY - r.top, grip: e.target.matches?.(".world-x-grip") });
    }, true);
  }
  window.confirm = () => true;
}

// The cube mask is the difference from a real terrain-only draw at this pose.
// Its centroid and hash exclude the DOM grip, toolbars and Scene Tree.
async function pixels(terrainOnly) {
  const runtime = forge3dViewportDiagnostics().terrainViewport.diagnosticRuntime;
  const rgba = await runtime.readRgba();
  const values = new Uint32Array(rgba.buffer, rgba.byteOffset, rgba.length / 4);
  if (terrainOnly) { probe.ground = values.slice(); return; }
  let n = 0, sumX = 0;
  for (let i = 0; i < values.length; ++i) {
    if (values[i] === probe.ground[i]) continue;
    n++;
    sumX += i % runtime.width;
  }
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", rgba));
  return { cubePixels: n, meanX: sumX / n, sha256: Array.from(hash, v => v.toString(16).padStart(2, "0")).join("") };
}

async function run(cdp, hybrid = false) {
  const evaluate = expr => cdp.evaluate(expr);
  const wait = expr => until(cdp, expr);
  const menu = async label => {
    await evaluate(`[...document.querySelectorAll(".menu__button")].find(b=>b.textContent==="File").click()`);
    await evaluate(`[...document.querySelectorAll('[role="menuitem"]')].find(b=>b.textContent.includes(${json(label)})).click()`);
  };
  const named = title => evaluate(`document.querySelector('button[title^="${title}"]').click()`);
  async function open(file) {
    const old = (await evaluate(state))?.sessionId;
    await evaluate(`probe.path = ${json(file)}`);
    await menu("Open…");
    await wait(`(async()=>{const s=await ${state};return !!s && s.sessionId!==${old} && !!window.forge3dViewportDiagnostics
      && ${D}.frame.projectId===s.project.id})()`);
    await evaluate(`document.querySelector('.recovery button[aria-label="Dismiss"]')?.click();
      Object.assign(document.querySelector(".viewport").style,{boxSizing:"content-box",flex:"none",width:"794px",height:"727px"});
      ${D}.setOrbitPose(${json(eye)},${json(aim)})`);
  }
  const ready = async (mode, visible = true) => {
    await wait(`${S}?.width===794 && ${S}.height===727 && devicePixelRatio===1 && !${D}.runtime &&
      ${S}.visibleIds.includes("${CUBE_ID}")===${visible} && ${D}.frame.settings.mode==="${mode}" &&
      document.querySelector("[data-viewport-backend]").textContent.includes("WebGPU available")`);
    await evaluate(raf);
  };
  const take = () => evaluate(`(${pixels})(false)`);
  const hasCapture = () => evaluate(`${grip}.hasPointerCapture(probe.pointer)`);
  const mouse = (type, x, y) => cdp.send("Input.dispatchMouseEvent", { type, x, y, button: "left",
    buttons: type === "mouseReleased" ? 0 : 1, ...(type === "mouseMoved" ? {} : { clickCount: 1 }) });
  const touch = (type, x, y) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints: type === "touchCancel" ? [] : [{x, y, id: 1}] });
  const read = () => evaluate(state);
  const commandCounts = async offset => {
    const calls = await evaluate(`probe.calls.slice(${offset})`);
    return { setTransform: calls.filter(c => c.cmd === "apply_command" && c.args.command.type === "setTransform").length,
      selection: calls.filter(c => c.cmd === "set_selection").length };
  };

  await wait('!!document.querySelector(".menu__button")');
  await evaluate(`(${instrument})();localStorage.setItem("studio.viewport.mapGrid","0")`);
  const parityPath = join(dirname(path),"parent-parity.studio3d");
  if (!hybrid) {
    const project=structuredClone(fixture);
    const parent=project.scene.objects.find(o=>o.kind.type==="camera");
    parent.transform={translation:{x:5,y:0,z:0},rotationDeg:{x:0,y:0,z:90},scale:{x:2,y:3,z:1}};
    const child=project.scene.objects.find(o=>o.id===CUBE_ID);
    child.parent=parent.id;
    child.transform.translation={x:0,y:.25,z:0};
    project.viewport.mode="solid";
    await writeFile(parityPath,json(project));
  }
  await open(parityPath);
  await wait(`${S}?.width===794 && ${S}.visibleIds.includes("${CUBE_ID}") && ${S}.visibleIds.includes("${TERRAIN_ID}") &&
    document.querySelector("[data-viewport-backend]").textContent.includes("WebGPU available") && !!${D}.runtime===${hybrid}`);
  await evaluate(raf);
  const submittedCenter=await evaluate(`(()=>{const d=${D},p=${S}.placement;
    return d.terrainViewport.displayedCube(d.frame,"${CUBE_ID}").center.map((v,i)=>p.translation[i]+v*p.scale)})()`);
  const expected=[4.25,0,0];
  assert.ok(submittedCenter.every((v,i)=>Math.abs(v-expected[i])<1e-5));
  report[hybrid ? "hybridParent" : "independentParent"]={submittedCenter,backend:await evaluate(
    'document.querySelector("[data-viewport-backend]").textContent')};
  if (hybrid) {
    const editorCenter=await evaluate(`${D}.runtime.objects.get("${CUBE_ID}").matrixWorld.elements.slice(12,15)`);
    assert.ok(editorCenter.every((v,i)=>Math.abs(v-expected[i])<1e-5));
    report.hybridParent.editorCenter=editorCenter;
    return;
  }
  for (const [label, project, mode] of [["original-solid",originalBryce,"solid"], ["relief-solid",fixture,"solid"],
    ["relief-material",fixture,"material"]]) {
    const source = join(dirname(path), label + ".studio3d");
    const saved = join(dirname(path), label + "-saved.studio3d");
    await writeFile(source, json({...project, viewport: {...project.viewport, mode}}));
    await open(source);
    await ready(mode);
    const lane = report.modes[label] = { gestures: [] };
    lane.backend = await evaluate('document.querySelector("[data-viewport-backend]").textContent');
    const toggle = `document.querySelector('[data-object-id="${CUBE_ID}"] button.tree-action').click()`;
    await evaluate(toggle);
    await ready(mode, false);
    await evaluate(`(${pixels})(true)`);
    await named("Undo ");
    await ready(mode);
    await cdp.click(await evaluate(`(() => {const r=document.querySelector(".viewport-canvas--terrain").getBoundingClientRect();
      return [r.left+398.5,r.top+346.5]})()`));
    await wait(`document.querySelector('[data-object-id="${CUBE_ID}"]').getAttribute("aria-selected")==="true"`);
    const pick = await evaluate(D + ".lastPick");
    assert.deepEqual(pick.pixel,[398,346]);
    assert.equal(pick.hit.id,CUBE_ID);
    await named("Select (V)");
    await wait(`!${grip}.getClientRects().length`);
    await named("Move (G)");
    await named("Object-aligned");
    await wait(`!${grip}.getClientRects().length`);
    await named("World-aligned");
    const original = await read();
    const retain = (suffix, project) => writeFile(join(out, label + "-" + suffix + "-project.json"), json(project,null,2) + "\n");
    await retain("before", original.project);
    lane.id = cube(original).id;
    lane.before = cube(original).transform;
    assert.deepEqual(lane.before.translation, {x:0,y:.85,z:0});
    assert.deepEqual(original.project.selection, [CUBE_ID]);
    const camera = await evaluate(S + ".camera");
    const treeRow = id => `document.querySelector('[data-object-id="${id}"]')`;
    async function gesture(exit) {
      await wait(`!!${grip}.getClientRects().length`);
      const [x,y] = await evaluate(`(()=>{const r=${grip}.getBoundingClientRect();return [r.x+r.width/2,r.y+r.height/2]})()`);
      const row = { exit, before: await take() };
      lane.gestures.push(row);
      const start = await read(), calls = await evaluate("probe.calls.length");
      const cancel = exit === "pointercancel", travel = exit === "zero" ? 0 : 44;
      if (!cancel) await cdp.send("Input.dispatchMouseEvent",{type:"mouseMoved",x,y,buttons:0});
      await evaluate("probe.trace=[]");
      if (cancel) await touch("touchStart",x,y); else await mouse("mousePressed",x,y);
      assert.equal(await hasCapture(), true);
      for (let i = 1; travel && i <= 9; i++) {
        const px = x + travel * i / 9;
        if (cancel) await touch("touchMove",px,y); else await mouse("mouseMoved",px,y);
      }
      await evaluate(raf);
      row.preview = await take();
      assert.ok(row.before.cubePixels > 100);
      if (travel) assert.ok(row.preview.meanX > row.before.meanX + 5, json(row));
      else assert.deepEqual(row.preview,row.before);
      assert.deepEqual(await evaluate(S + ".camera"), camera);
      const held = await read();
      row.held = { transform: cube(held).transform, historyLen: held.historyLen, camera: await evaluate(S + ".camera") };
      assert.deepEqual(cube(held).transform,cube(start).transform);
      assert.deepEqual(held.project.selection,[CUBE_ID]);
      assert.equal(held.historyLen,start.historyLen);
      assert.deepEqual(await commandCounts(calls), {setTransform:0,selection:0});
      if (exit === "escape") {
        await cdp.send("Input.dispatchKeyEvent",{type:"keyDown",key:"Escape",code:"Escape"});
        await cdp.send("Input.dispatchKeyEvent",{type:"keyUp",key:"Escape",code:"Escape"});
      } else if (cancel) await touch("touchCancel");
      else if (exit === "selection replacement") {
        await evaluate(`${treeRow(TERRAIN_ID)}.querySelector(".tree-name").click()`);
        await wait(`${treeRow(TERRAIN_ID)}.getAttribute("aria-selected")==="true"`);
      } else if (exit === "project replacement") {
        await open(saved);
        await ready(mode);
      } else if (exit === "capture loss") {
        await evaluate(`${grip}.releasePointerCapture(probe.pointer)`);
        await mouse("mouseMoved", x+travel,y);
      }
      if (exit !== "release" && exit !== "zero") assert.equal(await hasCapture(),false);
      // A mouse up after cancellation exercises the stale release path. Touch
      // cancellation terminates the OS contact, so replay its late up by ID.
      if (cancel) await evaluate(`${grip}.dispatchEvent(new PointerEvent("pointerup",{pointerId:probe.pointer,bubbles:true}))`);
      else await mouse("mouseReleased", x+travel,y);
      assert.equal(await hasCapture(),false);
      row.trace = await evaluate("probe.trace");
      if (exit === "release") {
        assert.equal((await commandCounts(calls)).setTransform,1,json(row.trace));
        await wait(`${D}.frame.objects.find(o=>o.id==="${CUBE_ID}").translation[0]>0`);
      }
      await evaluate(raf);
      const end = await read(), committed = exit === "release";
      row.counts = await commandCounts(calls);
      row.historyDelta = end.historyLen - start.historyLen;
      assert.deepEqual(row.counts,{setTransform:Number(committed),selection:Number(exit === "selection replacement")});
      assert.equal(row.historyDelta, Number(committed));
      assert.deepEqual(end.project.selection,[exit === "selection replacement" ? TERRAIN_ID : CUBE_ID]);
      assert.deepEqual(await take(), committed ? row.preview : row.before);
      if (!committed) assert.deepEqual(cube(end).transform,cube(start).transform);
      if (travel && !cancel) {
        const downIndex = row.trace.findIndex(e=>e.type==="pointerdown");
        const down = row.trace[downIndex];
        const moves = row.trace.slice(downIndex+1).filter(e => e.type === "pointermove").slice(0,9);
        assert.equal(moves.length,9);
        assert.ok(down.grip && moves.every(e=>e.id===down.id && e.grip));
        assert.ok(Math.abs(moves[8].x-down.x-44)<.01 && moves[8].y===down.y);
      }
      if (exit === "selection replacement") {
        await evaluate(`${treeRow(CUBE_ID)}.querySelector(".tree-name").click()`);
        await wait(`${treeRow(CUBE_ID)}.getAttribute("aria-selected")==="true"`);
      }
      return cube(end).transform;
    }
    lane.after = await gesture("release");
    const after = (await read()).project;
    await retain("after", after);
    const expected = structuredClone(original.project);
    expected.updatedUnixMs = after.updatedUnixMs;
    expected.scene.objects.find(o => o.id === CUBE_ID).transform.translation.x = lane.after.translation.x;
    assert.deepEqual(after, expected);
    lane.fieldX = fieldDrag(lane.gestures[0].trace,lane.before);
    assert.ok(Math.abs(lane.fieldX-lane.after.translation.x)<1e-5);
    assert.ok(lane.after.translation.x > 0);
    assert.deepEqual({...lane.after, translation:{...lane.after.translation,x:0}},lane.before);
    const undoRedoStart = await evaluate("probe.calls.length");
    await named("Undo ");
    await wait(`${D}.frame.objects.find(o=>o.id==="${CUBE_ID}").translation[0]===0`);
    assert.deepEqual(cube(await read()).transform,lane.before);
    await evaluate(raf);
    assert.deepEqual(await take(),lane.gestures[0].before);
    await named("Redo ");
    await wait(`${D}.frame.objects.find(o=>o.id==="${CUBE_ID}").translation[0]===${lane.after.translation.x}`);
    assert.deepEqual(cube(await read()).transform,lane.after);
    assert.deepEqual(await evaluate(`probe.calls.slice(${undoRedoStart}).map(c=>c.cmd)`),["undo","redo"]);
    await evaluate(`probe.path=${json(saved)}`);
    await menu("Save as…");
    await wait(`(async()=>(await ${state})?.dirty===false)()`);
    const disk = JSON.parse(await readFile(saved));
    assert.deepEqual(disk.scene.objects.find(o=>o.id===CUBE_ID).transform,lane.after);
    await menu("Close project");
    await wait(`(async()=>(await ${state})===null && !window.forge3dViewportDiagnostics)()`);
    await open(saved);
    await ready(mode);
    const reopened = await read();
    await retain("reopened", reopened.project);
    lane.reopened = cube(reopened).transform;
    assert.deepEqual(reopened.project.selection,[CUBE_ID]);
    assert.deepEqual(lane.reopened,lane.after);
    assert.deepEqual(await take(),lane.gestures[0].preview);
    await named("Move (G)");
    await named("World-aligned");
    for (const exit of ["escape","pointercancel","capture loss","zero","selection replacement","project replacement"]) await gesture(exit);
    console.log(mode, lane.backend, lane.before.translation, lane.after.translation, lane.reopened.translation);
  }
  report.regressions = await reviewCases({cdp, evaluate, wait, read, mouse, hasCapture, commandCounts, menu, open, ready, named,
    originalBryce, relief:fixture, directory:dirname(path), eye, aim, grip, D, S, raf});
  report.contexts = await evaluate('__vp01Contexts.filter(c=>c.requested.includes("webgl"))');
  assert.ok(report.contexts.length && report.contexts.every(c => c.result === null));
}

try {
  const field = fieldCheckout(root);
  const threePin = async dir => JSON.parse(await readFile(join(dir,"package-lock.json"))).packages["node_modules/three"].integrity;
  assert.equal(await threePin(root),await threePin(field));
  await desktop({root, field, out, values:{}, report, role:"candidate", metrics:{width:1440,height:833},
    observeCandidate: async cdp => {
      const source = `(${observeContexts})(false,"document")`;
      await cdp.send("Page.addScriptToEvaluateOnNewDocument",{source});
      await cdp.evaluate(source);
    }}, run);
  await desktop({root,field,out,values:{},report,role:"editor",metrics:{width:1440,height:833}},cdp=>run(cdp,true));
  report.passed = true;
} finally {
  await writeFile(join(out,"results.json"),JSON.stringify(report,null,2) + "\n");
}
