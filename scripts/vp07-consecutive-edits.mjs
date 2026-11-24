import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { CUBE_ID } from "./vp01/fixture.mjs";

export async function consecutiveEdits({setup, open, menu, ready, drag, hold, key, center, image,
  count, read, wait, evaluate, hasCapture, commandCounts, named, originalBryce, grip, frameCube, raf}) {
  const report = {};
  const cube = project => project.scene.objects.find(o => o.id === CUBE_ID);
  const pose = state => cube(state.project).transform;
  const observed = start => evaluate(`probe.calls.slice(${start}).map(c=>c.cmd)`);
  const resume = () => evaluate("probe.resumeRequest()");
  const paused = () => wait("!!probe.resumeRequest");
  const state = '__TAURI_INTERNALS__.invoke("project_state")';
  async function focusGrip() {
    await wait(grip+".getClientRects().length > 0");
    await evaluate(grip+".focus()");
    assert.ok(await evaluate("document.activeElement === "+grip));
  }

  for (const gesture of ["drag", "keys", "save-as"]) {
    const file = await setup("immediate-save-"+gesture, originalBryce);
    const destination = gesture === "save-as" ? file.replace(".studio3d","-saved.studio3d") : file;
    const start = await count(), before = await read();
    const keys = gesture === "keys";
    await hold("/apply_command",keys);
    if (keys) {
      await focusGrip();
      await key("ArrowRight","ArrowRight");
      await paused();
      await key("ArrowRight","ArrowRight");
    } else {
      await (await drag())();
      await paused();
    }
    await evaluate(raf);
    const preview = await center();
    assert.ok(preview[0] > 0.19);
    await evaluate("probe.path="+JSON.stringify(destination));
    await key("s","KeyS",gesture === "save-as" ? 10 : 2);
    await evaluate(raf);
    assert.ok(!(await observed(start)).includes("save_project"));
    await resume();
    await wait(`(async()=>{const s=await ${state};return !s.dirty && s.historyLen===${before.historyLen+(keys?2:1)}})()`);
    const saved = await read();
    const commands = await observed(start);
    assert.deepEqual(commands, [...Array(keys?2:1).fill("apply_command"),"save_project"]);
    assert.ok(Math.abs(pose(saved).translation.x-preview[0]) < 1e-6);
    assert.deepEqual(cube(JSON.parse(await readFile(destination,"utf8"))).transform,pose(saved));
    await menu("Close project");
    await wait(`(async()=>(await ${state})===null)()`);
    await open(destination);
    await ready("solid");
    const reopened = await read();
    assert.deepEqual(reopened.project.selection,[CUBE_ID]);
    assert.deepEqual(pose(reopened),pose(saved));
    report[gesture+"Saved"]={commands,historyDelta:saved.historyLen-before.historyLen,preview,
      before:pose(before),saved:pose(saved),reopened:pose(reopened),selected:reopened.project.selection};
  }

  // The save itself can be waiting for acknowledgement when the next edit
  // arrives. The file keeps the earlier pose and the later edit stays dirty.
  const file = await setup("edit-after-save",originalBryce);
  await focusGrip();
  await hold("/save_project",true);
  await key("s","KeyS",2);
  await paused();
  await key("ArrowRight","ArrowRight");
  await resume();
  await wait(frameCube+".translation[0]===0.1");
  assert.ok((await read()).dirty);
  assert.equal(cube(JSON.parse(await readFile(file,"utf8"))).transform.translation.x,0);
  report.editAfterSave = {diskX:0,dirtyX:0.1};

  const closing = await setup("save-then-close",originalBryce);
  const closingCount = await count();
  await hold("/apply_command");
  await (await drag())();
  await paused();
  await key("s","KeyS",2);
  await menu("Close project");
  await evaluate(raf);
  assert.deepEqual(await observed(closingCount),[]);
  await resume();
  await wait(`(async()=>(await ${state})===null)()`);
  assert.deepEqual(await observed(closingCount),["apply_command","save_project","close_project"]);
  await open(closing);
  await ready("solid");
  assert.equal(pose(await read()).translation.x,0.81615096);
  report.saveThenClose = {reopened:pose(await read())};

  for (const timing of ["after release", "during capture", "cancel second", "zero second"]) {
    await setup("successive-drags",originalBryce);
    const start = await count();
    await hold("/apply_command",true);
    await (await drag())();
    await paused();
    const first = await read();
    assert.equal(pose(first).translation.x,0.81615096);
    const second = await drag(undefined,timing === "zero second" ? 0 : 44);
    const held = await center();
    assert.deepEqual(pose(await read()),pose(first));
    if (timing !== "zero second") assert.ok(held[0] > pose(first).translation.x+0.5);
    if (timing === "during capture") {
      await resume();
      await wait(frameCube+".translation[0]===0.81615096");
      await evaluate(raf);
      assert.ok(await hasCapture());
      assert.deepEqual(await center(),held);
    }
    if (timing === "cancel second") await key("Escape","Escape");
    await second();
    if (timing !== "during capture") await resume();
    const moved = timing === "after release" || timing === "during capture";
    await wait(frameCube+".translation[0]"+(moved ? ">1" : "===0.81615096"));
    const last = await read();
    assert.deepEqual(await commandCounts(start),{setTransform:moved?2:1,selection:0});
    assert.equal(last.historyLen,first.historyLen+Number(moved));
    if (moved) {
      assert.ok(Math.abs(pose(last).translation.x-held[0]) < 1e-6);
      await named("Undo ");
      await wait(frameCube+".translation[0]===0.81615096");
      assert.deepEqual(pose(await read()),pose(first));
    } else assert.deepEqual(pose(last),pose(first));
    report[timing]={first:pose(first).translation,held,last:pose(last).translation,history:last.historyLen};
  }

  await setup("rotated-local-1000",originalBryce,p=>{
    const parent = p.scene.objects.find(o=>o.kind.type==="camera");
    const offset = 1000*Math.SQRT1_2;
    parent.transform = {translation:{x:-offset,y:.85-offset,z:0},rotationDeg:{x:0,y:0,z:45},scale:{x:1,y:1,z:1}};
    cube(p).parent = parent.id;
    cube(p).transform.translation = {x:1000,y:0,z:0};
  });
  const before = await read(), origin = await center(), initialFrame = await image(), start = await count();
  const steps = [];
  const release = await drag(undefined,44,async()=>{
    const p = await center();
    const dx = p[0]-origin[0];
    assert.ok(p[0] > (steps.at(-1)?.[0] ?? origin[0]));
    assert.ok(Math.hypot(p[1]-origin[1],p[2]-origin[2]) <= 1e-5*dx+1e-7);
    steps.push(p);
  });
  assert.deepEqual(pose(await read()),pose(before));
  const heldFrame = await image();
  assert.notEqual(heldFrame,initialFrame);
  await release();
  await wait(frameCube+".translation[0]>1000.5");
  await evaluate(raf);
  assert.equal(await image(),heldFrame);
  const first = await read();
  function verifyAxis(from,to,wanted) {
    for (const convert of [v=>v, Math.fround]) {
      const x = convert(to.x)-convert(from.x), y = convert(to.y)-convert(from.y);
      const dx = (x-y)*Math.SQRT1_2, dy = (x+y)*Math.SQRT1_2;
      assert.ok(Math.abs(dx-wanted)<0.001);
      assert.ok(Math.abs(dy)<=1e-5*Math.min(Math.abs(dx),wanted));
      assert.equal(to.z,from.z);
    }
  }
  verifyAxis(pose(before).translation,pose(first).translation,.81615);
  await focusGrip();
  await key("ArrowRight","ArrowRight");
  await wait(frameCube+".translation[0]>"+pose(first).translation.x);
  const last = await read();
  verifyAxis(pose(first).translation,pose(last).translation,.1);
  assert.deepEqual(await commandCounts(start),{setTransform:2,selection:0});
  report.rotated={origin,steps,drag:pose(first).translation,nudge:pose(last).translation,historyDelta:last.historyLen-before.historyLen};
  return report;
}
