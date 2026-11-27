import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { consecutiveEdits } from "./vp07-consecutive-edits.mjs";
import { CUBE_ID, TERRAIN_ID } from "./vp01/fixture.mjs";

export async function reviewCases({cdp, evaluate, wait, read, mouse, hasCapture, commandCounts, menu, open, ready, named,
  expectedTravel, originalBryce, relief, directory, eye, aim, grip, D, S, raf}) {
  const report = {};
  const cube = p => p.scene.objects.find(o => o.id === CUBE_ID);
  const translation = async () => cube((await read()).project).transform.translation;
  const visible = `!!${grip}.getClientRects().length`;
  const frameCube = D + '.frame.objects.find(o=>o.id==="' + CUBE_ID + '")';
  const image = () => evaluate(`(async()=>{
    const pixels=await ${D}.terrainViewport.diagnosticRuntime.readRgba();
    return [...new Uint8Array(await crypto.subtle.digest("SHA-256", pixels))].join(".");
  })()`);
  const count = () => evaluate("probe.calls.length");
  async function key(key, code, modifiers = 0) {
    const vk = {Tab:9, Enter:13, Space:32, ArrowLeft:37, ArrowRight:39, KeyZ:90, KeyS:83, Escape:27}[code];
    const text = key === "Enter" ? "\r" : key === " " ? " " : undefined;
    for (const type of ["keyDown","keyUp"]) await cdp.send("Input.dispatchKeyEvent",{
      type, key, code, modifiers, windowsVirtualKeyCode:vk, ...(type === "keyDown" && text ? {text} : {}),
    });
  }
  async function setup(label, source, edit, offset=0) {
    const project = structuredClone(source);
    project.viewport.mode = "solid";
    project.selection = [CUBE_ID];
    edit?.(project);
    const file = join(directory,label + ".studio3d");
    await writeFile(file,JSON.stringify(project));
    await open(file);
    if (offset) {
      const shift = Array.isArray(offset) ? offset : [offset,0,0];
      const shifted = p => JSON.stringify(p.map((v,i) => v + shift[i]));
      await evaluate(`${D}.setOrbitPose(${shifted(eye)},${shifted(aim)})`);
    }
    await ready("solid");
    await named("Move (G)");
    await named("World-aligned");
    return file;
  }
  async function drag(point, delta = 44, afterMove) {
    await wait(visible);
    const [x,y] = point ?? await evaluate(`(()=>{const r=${grip}.getBoundingClientRect(); return [r.x+r.width/2,r.y+r.height/2]})()`);
    await cdp.send("Input.dispatchMouseEvent",{type:"mouseMoved",x,y,buttons:0});
    await mouse("mousePressed",x,y);
    assert.equal(await hasCapture(),true);
    for (let i=1; i<=9; ++i) {
      await mouse("mouseMoved",x+delta*i/9,y);
      if (afterMove) {
        await evaluate(raf);
        await afterMove();
      }
    }
    await evaluate(raf);
    return async () => {
      await mouse("mouseReleased",x+delta,y);
      await evaluate(raf);
      assert.equal(await hasCapture(),false);
    };
  }

  // Hold the real native Undo acknowledgement. Exercise both the editor
  // shortcut and a separate toolbar action that bypasses the keyboard handler.
  await evaluate(`{
    const fetch = window.fetch;
    window.fetch = function(resource, init) {
      const url = new URL(resource instanceof Request ? resource.url : resource,location.href);
      const reply = fetch.apply(this,arguments);
      if (probe.holdUndo && url.hostname === "ipc.localhost" && url.pathname === "/undo") {
        probe.holdUndo = false;
        return reply.then(async response => { await new Promise(done => probe.resumeUndo = done); return response });
      }
      return reply;
    };
  }`);
  for (const origin of ["shortcut","toolbar","native"]) {
    await setup("undo-race",originalBryce);
    await named("Object:");
    const field = `[...document.querySelectorAll("label.field")].find(el=>el.textContent.trim()==="Y")?.querySelector("input")`;
    await wait("!!("+field+")");
    await evaluate(`{const el=${field}; el.focus(); el.select()}`);
    await cdp.send("Input.insertText",{text:"1.85"});
    await evaluate("document.activeElement.blur()");
    await wait(frameCube+".translation[1]===1.85");
    const release = await drag();
    await evaluate("probe.holdUndo=true; probe.resumeUndo=null");
    if (origin === "shortcut") await key("z","KeyZ",2);
    else if (origin === "toolbar") await named("Undo ");
    else await evaluate('void __TAURI_INTERNALS__.invoke("undo")');
    await wait("!!probe.resumeUndo");
    const undone = await read(), start = await count();
    assert.equal(cube(undone.project).transform.translation.y,.85);
    await release();
    const after = await read(), calls = await commandCounts(start);
    assert.deepEqual(after.project,undone.project);
    assert.equal(after.historyLen,undone.historyLen);
    assert.ok(after.canRedo);
    assert.equal(calls.setTransform,origin === "native" ? 1 : 0);
    await evaluate("probe.resumeUndo()");
    if (origin === "native") {
      // The controller outside React intentionally never published Undo.
      await evaluate('__TAURI_INTERNALS__.invoke("redo")');
    } else {
      await wait(frameCube+".translation[1]===0.85");
      await named("Redo ");
    }
    await wait(frameCube+".translation[1]===1.85");
    assert.equal((await translation()).y,1.85);
    report[origin+"Undo"] = {attempts:calls.setTransform,applied:0,undoPose:cube(after.project).transform,
      redoPose:cube((await read()).project).transform};
  }

  await setup("material-with-imagery",originalBryce);
  const releaseLost = await drag(), beforeMode = await translation();
  await named("Material preview");
  await wait('document.querySelector("[data-viewport-backend]").textContent.includes("unavailable")');
  assert.equal(await evaluate(visible),false);
  assert.equal(await hasCapture(),false);
  const lostCount = await count();
  await releaseLost();
  assert.deepEqual(await translation(),beforeMode);
  assert.equal((await commandCounts(lostCount)).setTransform,0);
  report.imageryMaterial = await evaluate('document.querySelector("[data-viewport-backend]").textContent');

  await setup("edge",relief,p => { cube(p).transform.translation.x=6; });
  const point = await evaluate(`(()=>{const r=document.querySelector(".viewport-canvas--terrain").getBoundingClientRect();
    return [r.x+760,r.y+483]})()`);
  assert.equal(await evaluate(`document.elementFromPoint(${point.join(",")}).className`),"world-x-handle");
  const edgeCount = await count();
  await (await drag(point,-44))();
  const edge = await translation();
  assert.ok(edge.x<6);
  assert.deepEqual(await commandCounts(edgeCount),{setTransform:1,selection:0});
  report.shaft = {pixel:[760,483],before:6,after:edge.x};

  const offset = 4_000_000_000;
  await setup("large",relief,p => {
    cube(p).transform.translation.x=offset;
    p.scene.objects.find(o=>o.id===TERRAIN_ID).visible=false;
  },offset);
  const farCount = await count(), farState = await read(), farImage = await image();
  const releaseFar = await drag();
  assert.equal(await image(),farImage);
  await releaseFar();
  assert.equal(await image(),farImage);
  assert.equal((await commandCounts(farCount)).setTransform,0);
  assert.equal((await read()).historyLen,farState.historyLen);
  assert.deepEqual(await translation(),cube(farState.project).transform.translation);
  report.large = {x:offset,applied:0,frameUnchanged:true};

  // Parent rotates its local Y into negative world X and scales it by three.
  // Choose its translation so the child's origin is still at the Bryce pose.
  await setup("parent",relief,p => {
    const parent = p.scene.objects.find(o=>o.kind.type==="camera");
    parent.transform={translation:{x:2.55,y:.85,z:0},rotationDeg:{x:0,y:0,z:90},scale:{x:2,y:3,z:1}};
    cube(p).parent=parent.id;
  });
  await wait(visible);
  const center = () => evaluate(`(()=>{const d=${D}, p=${S}.placement;
    return d.terrainViewport.displayedObject(d.frame,"${CUBE_ID}").center.map((v,i)=>p.translation[i]+p.scale*v);
  })()`);
  const initial = await image(), startCenter = await center(), parentStart = await translation(), n = await count();
  assert.ok(startCenter.every((v,i)=>Math.abs(v-[0,.85,0][i])<1e-5));
  const releaseParent = await drag();
  const heldImage = await image(), heldCenter = await center();
  assert.notEqual(heldImage,initial);
  assert.deepEqual(await translation(),parentStart);
  await releaseParent();
  await wait(frameCube+".translation[1]<0.85");
  const end = await translation();
  assert.ok(Math.abs(end.x)<1e-6 && end.z===0);
  const worldDelta = -3*(end.y-parentStart.y);
  assert.ok(Math.abs(worldDelta - expectedTravel)<.001);
  assert.ok(heldCenter.every((v,i)=>Math.abs(v-startCenter[i]-(i===0 ? worldDelta : 0))<1e-5));
  assert.deepEqual(await commandCounts(n),{setTransform:1,selection:0});
  assert.equal(await image(),heldImage);
  await named("Undo ");
  await wait(frameCube+".translation[1]===0.85");
  assert.equal(await image(),initial);
  report.parent = {worldDelta,startCenter,heldCenter,localStart:parentStart,localEnd:end};

  await evaluate('document.querySelector(\'button[title="Select (V)"]\').focus()');
  await key("Tab","Tab",8);
  assert.equal(await evaluate("document.activeElement === "+grip),true);
  for (const [k,code,distance,modifiers] of [["ArrowRight","ArrowRight",.1],["ArrowLeft","ArrowLeft",-.1],
    ["ArrowLeft","ArrowLeft",-1,8],["Enter","Enter",.1],[" ","Space",.1]]) {
    const before = await translation(), off = await count();
    assert.equal(await evaluate("document.activeElement === "+grip),true);
    await key(k,code,modifiers);
    await wait("probe.calls.length>"+off);
    await evaluate(raf);
    const after = await translation();
    assert.ok(Math.abs(-3*(after.y-before.y)-distance)<1e-5);
    assert.deepEqual(await commandCounts(off),{setTransform:1,selection:0});
  }
  report.keyboard = ["Tab focus","ArrowRight","ArrowLeft","Shift+ArrowLeft","Enter","Space"];
  await setup("end-on",relief);
  await evaluate(D+".setOrbitPose([10,.85,0],[0,.85,0])");
  await wait("!"+visible);
  assert.equal(await evaluate(grip+".parentElement.hidden"),true);
  report.endOnHidden = true;
  await setup("clipped-preview",relief,p => { cube(p).transform.translation.x=4.18; });
  await evaluate(D+".setOrbitPose([0,.85,10],[0,.85,0])");
  await evaluate(raf);
  const rect = await evaluate('document.querySelector(".viewport-canvas--terrain").getBoundingClientRect().toJSON()');
  const y = rect.top + rect.height/2;
  const clipCount = await count();
  // At 766 Field now picks the positive Z cone. Start on the visible
  // negative X shaft and carry the same captured axis through the right edge.
  await mouse("mousePressed",rect.left+736,y);
  assert.equal(await evaluate('document.querySelector(".transform-handles").dataset.axis'),"X");
  assert.equal(await hasCapture(),true);
  for (const x of [745,752,766,775,782,786,790,792,750]) {
    await mouse("mouseMoved",rect.left+x,y);
    await evaluate(raf);
    assert.equal(await hasCapture(),true,`capture lost at ${x}`);
    assert.equal((await translation()).x,4.18);
    if (x === 792) assert.equal(await evaluate(grip+'.parentElement.style.visibility'),"hidden");
  }
  await mouse("mouseReleased",rect.left+750,y);
  await wait(frameCube+".translation[0]>4.18");
  assert.equal(await hasCapture(),false);
  assert.deepEqual(await commandCounts(clipCount),{setTransform:1,selection:0});
  report.clippedPreview = {capturedAt:[736,745,752,766,775,782,786,790,792,750],after:await translation()};

  const ground = p => p.scene.objects.find(o=>o.id===TERRAIN_ID);
  const camera = p => p.scene.objects.find(o=>o.kind.type==="camera");
  const zero = {x:0,y:0,z:0}, unit = {x:1,y:1,z:1};
  const largeX = 4_000_000_300;
  await setup("colocated",relief,p => {
    cube(p).transform.translation.x=largeX;
    ground(p).transform.translation.x=largeX;
  },largeX);
  const colocated = await center(), terrainOrigin = await evaluate(S+".placement.translation");
  assert.equal(colocated[0],largeX);
  assert.equal(terrainOrigin[0],colocated[0]);
  report.colocated = {cube:colocated,terrainOrigin};

  for (const terrain of [true,false]) {
    await setup("singular-"+terrain,relief,p => {
      const grand=p.scene.objects.find(o=>o.name==="Sun"), parent=camera(p), child=cube(p);
      grand.transform={translation:zero,rotationDeg:{x:20,y:30,z:40},scale:{x:0,y:2,z:3}};
      parent.parent=grand.id;
      parent.transform={translation:zero,rotationDeg:{x:10,y:20,z:30},scale:unit};
      child.parent=parent.id;
      child.transform={translation:zero,rotationDeg:zero,scale:{x:.01,y:.01,z:.01}};
      ground(p).visible=terrain;
    });
    assert.equal(await evaluate(visible),false);
    const singularCount=await count(), prior=await read(), frame=await image();
    await evaluate(grip+".click()");
    await evaluate(raf);
    assert.deepEqual(await commandCounts(singularCount),{setTransform:0,selection:0});
    assert.equal((await read()).historyLen,prior.historyLen);
    assert.deepEqual(await translation(),zero);
    assert.equal(await image(),frame);
    report["singularTerrain"+terrain]={world:await center(),applied:0};
  }

  const farWorld=4e9*Math.SQRT1_2;
  await setup("angled-large",relief,p => {
    ground(p).visible=false;
    camera(p).transform={translation:zero,rotationDeg:{...zero,z:45},scale:unit};
    cube(p).parent=camera(p).id;
    cube(p).transform.translation={...zero,x:4e9};
  },[farWorld,farWorld,0]);
  await wait(visible);
  await evaluate(grip+".focus()");
  const angledCount=await count(), angledState=await read(), angledCenter=await center(), angledFrame=await image();
  await key("ArrowRight","ArrowRight",8);
  await evaluate(raf);
  assert.deepEqual(await center(),angledCenter);
  assert.deepEqual(await commandCounts(angledCount),{setTransform:0,selection:0});
  assert.deepEqual(await read(),angledState);
  assert.equal(await image(),angledFrame);
  report.angledLarge={world:angledCenter,applied:0};

  // Delay the actual fetch in either direction. project_state remains live.
  await evaluate(`{
    const send=window.fetch;
    window.fetch=async function(resource) {
      const url=new URL(resource instanceof Request ? resource.url : resource,location.href);
      if (url.hostname!=="ipc.localhost" || url.pathname!==probe.holdPath) return send.apply(this,arguments);
      probe.holdPath=null;
      const response=probe.delayReply ? send.apply(this,arguments) : null;
      await new Promise(done=>probe.resumeRequest=done);
      return response ?? send.apply(this,arguments);
    }
  }`);
  const hold=(path,reply=false)=>evaluate(`probe.resumeRequest=null;probe.holdPath="${path}";probe.delayReply=${reply}`);
  // A native f32 exactly halfway between two shortest decimal strings.
  const midpoint = 1_952_495.125;
  await setup("decimal-midpoint",relief,p => {
    ground(p).transform.translation.x=midpoint;
    cube(p).transform.translation.x=midpoint;
  },midpoint);
  await wait(visible);
  await evaluate(grip+".focus()");
  await hold("/apply_command");
  await key("ArrowRight","ArrowRight");
  await wait("!!probe.resumeRequest");
  await evaluate(raf);
  const midpointPreview = await center(), midpointFrame = await image();
  assert.equal((await translation()).x,1_952_495.1);
  await evaluate("probe.resumeRequest()");
  await wait(frameCube+".translation[0]===1952495.2");
  await evaluate(raf);
  assert.deepEqual(await center(),midpointPreview);
  assert.equal(await image(),midpointFrame);
  report.decimalMidpoint = {preview:midpointPreview,stored:await translation()};

  await setup("ordered-keys",relief);
  await wait(visible);
  await evaluate(grip+".focus()");
  const keysCount=await count(), keysState=await read();
  await hold("/apply_command",true);
  await key("ArrowRight","ArrowRight");
  await wait("!!probe.resumeRequest");
  await key("ArrowRight","ArrowRight");
  await evaluate("probe.resumeRequest()");
  await wait(frameCube+".translation[0]===0.2");
  assert.deepEqual(await commandCounts(keysCount),{setTransform:2,selection:0});
  assert.equal((await read()).historyLen,keysState.historyLen+2);
  report.orderedKeys={presses:2,x:(await translation()).x,commands:2};

  await setup("selection-first",relief);
  const selectionState=await read(), selectionCount=await count(), releaseSelection=await drag();
  await hold("/set_selection");
  await evaluate(`document.querySelector('[data-object-id="${TERRAIN_ID}"]').click()`);
  await wait("!!probe.resumeRequest");
  assert.equal(await hasCapture(),false);
  await releaseSelection();
  await evaluate("probe.resumeRequest()");
  await wait(`document.querySelector('[data-object-id="${TERRAIN_ID}"]').getAttribute("aria-selected")==="true"`);
  assert.deepEqual(await translation(),cube(selectionState.project).transform.translation);
  assert.equal((await read()).historyLen,selectionState.historyLen);
  assert.deepEqual((await read()).project.selection,[TERRAIN_ID]);
  assert.deepEqual(await commandCounts(selectionCount),{setTransform:0,selection:1});
  report.selectionFirst={selected:TERRAIN_ID,edits:0};

  await setup("release-first",relief);
  await named("Object:");
  const field = `[...document.querySelectorAll("label.field")].find(el=>el.textContent.trim()==="Y")?.querySelector("input")`;
  await wait("!!("+field+")");
  await evaluate(`{const el=${field}; el.focus(); el.select()}`);
  await cdp.send("Input.insertText",{text:"1.85"});
  await evaluate("document.activeElement.blur()");
  await wait(frameCube+".translation[1]===1.85");
  const preceding=await read(), orderedCount=await count(), releaseX=await drag();
  await hold("/apply_command");
  await releaseX();
  await wait("!!probe.resumeRequest");
  await key("z","KeyZ",2);
  await evaluate(raf);
  assert.deepEqual(await translation(),cube(preceding.project).transform.translation);
  await evaluate("probe.resumeRequest()");
  await wait(`(async()=>{const s=await __TAURI_INTERNALS__.invoke("project_state");return s.canRedo && s.historyLen===${preceding.historyLen}})()`);
  assert.deepEqual(await translation(),cube(preceding.project).transform.translation);
  assert.deepEqual(await evaluate(`probe.calls.slice(${orderedCount}).map(c=>c.cmd)`),["apply_command","undo"]);
  await named("Redo ");
  await wait(frameCube+".translation[0]>0");
  assert.equal((await translation()).y,1.85);
  report.releaseFirst={afterUndo:cube(preceding.project).transform.translation,afterRedo:await translation()};
  report.consecutive = await consecutiveEdits({ setup, open, menu, ready, drag, expectedTravel, hold, key, center, image, count,
    read, wait, evaluate, hasCapture, commandCounts, named, originalBryce, grip, frameCube, raf });
  return report;
}
