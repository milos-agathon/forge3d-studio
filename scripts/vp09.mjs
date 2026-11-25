import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { Euler, Matrix4, PerspectiveCamera, Quaternion, Vector3 } from "three";
import "./prepare-viewport-runtime.mjs";
import { createFixture, CUBE_ID, FIELD_REVISION, TERRAIN_ID, verifyProvenance } from "./vp01/fixture.mjs";
import { observeContexts } from "./vp01/startup.mjs";
import { observeUpload, sampleStudio } from "./vp04/page.mjs";
import { openFixture } from "./vp08-fixture.mjs";
import { installReplay } from "./vp08-page.mjs";
import { desktop, fieldCheckout, until } from "./viewport-desktop.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const field = fieldCheckout(root);
const out = await mkdtemp(join(tmpdir(), "studio-vp09-"));
console.log("VP-09 evidence", out);
process.env.PYTHONDONTWRITEBYTECODE = "1";
process.env.FORGE3D_STUDIO_PYTHON ??= execFileSync("python", ["-c", "import sys; print(sys.executable)"], {encoding:"utf8"}).trim();
const { values } = parseArgs({options:{"engine-pythonpath":{type:"string"}}});
process.env.PYTHONPATH = [join(root,"scripts/vp09"), values["engine-pythonpath"], process.env.PYTHONPATH].filter(Boolean).join(delimiter);
const { path } = await createFixture(join(out,"fixture"));
const project = JSON.parse(await readFile(path));
const terrain = project.scene.objects.find(o => o.id === TERRAIN_ID);
delete terrain.kind.overlay;
project.assets = project.assets.filter(a => a.id === terrain.kind.asset);
project.selection = [];
Object.assign(project.render, {width: 320, height: 240});
const cameraId = project.scene.activeCamera;
const authored = project.scene.objects.find(o => o.id === cameraId);
const rolled = new PerspectiveCamera();
rolled.position.set(11, 8, 13);
rolled.lookAt(0, 0.8, 0);
rolled.rotateZ(Math.PI / 6);
const degrees = new Euler().setFromQuaternion(rolled.quaternion, "ZYX");
authored.transform.rotationDeg = Object.fromEntries(["x","y","z"].map(k => [k, degrees[k]*180/Math.PI]));
authored.transform.translation = { x:11, y:8, z:13 };
Object.assign(authored.kind, {fovDeg:53, near:12, far:36});
await writeFile(path, JSON.stringify(project));
const cubeFile = join(out,"fixture","cube.studio3d");
await writeFile(cubeFile, JSON.stringify({...project, assets:[], scene:{...project.scene,
  objects:project.scene.objects.filter(o => o.id !== TERRAIN_ID)}}));
const report = {base:execFileSync("git", ["rev-parse","HEAD"], {cwd:root,encoding:"utf8"}).trim(),
  engine:JSON.parse(execFileSync(process.env.FORGE3D_STUDIO_PYTHON, ["-c",
    "import json, forge3d, forge3d.io; assert hasattr(forge3d.io, 'write_hdr'), 'Field Instrument requires forge3d.io.write_hdr'; print(json.dumps([forge3d.__version__, forge3d.__file__]))"], {encoding:"utf8"})),
  fieldRevision:FIELD_REVISION, webRevision:(await verifyProvenance()).commit, authored, frames:{}, landmarkErrors:{}};
const poseEye = [9.5,7,11], pivot = [0,.8,0];
const q = array => new Quaternion().fromArray(array);
const v = array => new Vector3().fromArray(array);
const direction = (pose, vector) => v(vector).applyQuaternion(q(pose.rotation));
const close = (a,b,label,tol=1e-6) => assert.ok(Math.abs(a-b)<=tol, label+" ("+a+" vs "+b+")");
function samePose(a,b,label) {
  close(v(a.eye).distanceTo(v(b.eye)),0,label+" eye");
  close(q(a.rotation).angleTo(q(b.rotation)),0,label+" rotation");
  for (const key of ["fov","near","far"]) close(a[key],b[key],label+" "+key);
}

// Observe the normal command path. Substitute the output filename at the native save dialog.
function observeCommands(stillPath) {
  const calls = window.cameraCalls = [];
  const fetch = window.fetch;
  window.fetch = async function(resource, init) {
    const url = new URL(resource instanceof Request ? resource.url : resource, location.href);
    const name = decodeURIComponent(url.pathname.slice(1));
    if (url.hostname !== "ipc.localhost" || init?.method !== "POST") return fetch.apply(this, arguments);
    if (name === "plugin:dialog|save") return new Response(JSON.stringify(stillPath),
      {headers:{"Content-Type":"application/json","Tauri-Response":"ok"}});
    if (!["apply_command","set_playhead","render_frame","render_still"].includes(name)) return fetch.apply(this, arguments);
    const call = { name, args:JSON.parse(init.body), update:replay.updates };
    calls.push(call);
    const response = await fetch.apply(this, arguments);
    call.ok = response.headers.get("Tauri-Response") === "ok";
    if (!call.ok) call.error = await response.clone().text();
    if (call.ok && name.startsWith("render_")) {
      const frame = await response.clone().json();
      call.renderPath = frame.renderPath;
      if (name === "render_frame") window.lastNativePreview = {call, png:frame.png};
    }
    return response;
  };
}

async function rolledFlyExit(cdp, pose, dragHandle) {
  const ev = expr => cdp.evaluate(expr);
  const step = n => ev("replay.step("+n+")");
  const key = (type,key,code)=>cdp.send("Input.dispatchKeyEvent",{type,key,code});
  const free = await pose();
  await ev(`document.querySelector('[title^="Camera view"]').click()`);
  await step(2);
  await ev(`document.querySelector('[title^="Fly camera"]').click()`);
  await step(2);
  const start = await pose();
  close(q(start.rotation).angleTo(rolled.quaternion),0,"fly inherits authored roll");
  await key("keyDown","w","KeyW");
  await step(60);
  await key("keyUp","w","KeyW");
  const flown = await pose();
  close(v(flown.eye).distanceTo(v(start.eye)),5,"rolled forward travel");
  await key("keyDown","Escape","Escape");
  await key("keyUp","Escape","Escape");
  await step(1);
  const exit = await pose();
  await step(30);
  const idle = await pose();
  for (const restored of [exit,idle]) {
    samePose(restored,{...flown,fov:free.fov,near:free.near,far:free.far},"rolled orbit handoff");
    close(v(restored.target).sub(v(restored.eye)).distanceTo(direction(flown,[0,0,-1]).multiplyScalar(10)),0,"rolled orbit target");
  }
  if (dragHandle) await dragHandle();
  const [x,y] = await ev(`(()=>{const r=document.querySelector(".viewport").getBoundingClientRect();return [r.x+250,r.y+350]})()`);
  const index = await ev("replay.trace.length");
  await cdp.send("Input.dispatchMouseEvent",{type:"mouseWheel",x,y,deltaX:0,deltaY:-100});
  await until(cdp,`replay.trace.slice(${index}).some(e=>e.type==="wheel")`);
  await step(2);
  const nextOrbit = await pose();
  close(v(nextOrbit.eye).distanceTo(v(nextOrbit.target)),9.5,"first orbit wheel after rolled exit");
  return {free,start,flown,exit,idle,nextOrbit};
}

async function run(cdp, role) {
  const isField = role === "field";
  const ev = expr => cdp.evaluate(expr);
  const step = (n=1, ms=1000/60) => ev("replay.step("+n+","+ms+")");
  const click = selector => ev("document.querySelector("+JSON.stringify(selector)+").click()");
  const state = () => ev('__TAURI_INTERNALS__.invoke("project_state").then(s=>s.project)');
  const submission = "forge3dViewportDiagnostics().terrainViewport.diagnosticSubmission";
  async function setup(filename, terrain) {
    await openFixture(cdp,filename);
    const fieldReady = 'window.__vp01FieldDiagnostics?.().runtime.renderer.domElement.height===727';
    const editorTerrain = ' && [...__vp01FieldDiagnostics().runtime.objects.values()].some(g=>g.children.some(c=>c.userData.elevation))';
    await until(cdp,isField ? fieldReady+(terrain ? editorTerrain : "") :
      'window.vp04Calls?.submittedCamera && !forge3dViewportDiagnostics().runtime && '+submission+'?.width===794 && '+submission+'.visibleIds.length>0 && !!'+submission+'.terrain==='+terrain);
    const view = await ev("("+installReplay+")("+isField+",true)");
    assert.deepEqual(view.css,[794,727]);
    assert.deepEqual(view.physical,view.css);
    assert.equal(view.dpr,1);
    return view;
  }
  const view = await setup(path,true);
  const clip = {x:view.x,y:view.y,width:view.css[0],height:view.css[1]};
  const lane = report[role] = { view, input:[], travel:[], captures:[], native:{} };
  assert.match(view.backend,isField ? /WebGL2RenderingContext/ : /WebGPU available/);
  if (!isField) {
    lane.contexts = await ev('__vp01Contexts.filter(c=>c.requested.includes("webgl"))');
    assert.ok(lane.contexts.length && lane.contexts.every(c=>c.result===null));
    assert.ok(report.candidateShell.flags.includes("--disable-webgl"));
  }

  const stillPath = join(out,role,"still.png");
  await ev("("+observeCommands+")("+JSON.stringify(stillPath)+")");
  const flyButton = '[title^="Fly camera"]', cameraButton = '[title^="Camera view"]';
  async function press(key,code=key,type="keyDown") {
    lane.input.push({key,code,type,update:await ev("replay.updates")});
    await cdp.send("Input.dispatchKeyEvent",{type,key,code});
  }
  const tap = async (key,code) => { await press(key,code); await press(key,code,"keyUp"); };
  async function pose() {
    if (isField) return {...await ev("replay.fieldCamera()"), target:(await ev("replay.sample()")).target};
    const { native, placement } = await ev("({native:vp04Calls.submittedCamera, placement:"+submission+".placement})");
    const studio = point => point.map((n,i)=>n*placement.scale+placement.translation[i]);
    const rotation = new Quaternion().setFromRotationMatrix(new Matrix4().lookAt(v(native.position),v(native.target),v(native.up)));
    return {eye:studio(native.position),target:studio(native.target),rotation:rotation.toArray(),
      near:native.near*placement.scale,far:native.far*placement.scale,fov:native.fovYDegrees};
  }
  async function setFree() {
    await ev("replay.setPose("+JSON.stringify(poseEye)+","+JSON.stringify(pivot)+")");
    await step(2);
  }
  async function look(dx,dy,advance=true) {
    const x=view.x+250,y=view.y+350;
    for (const [type,px,py,buttons] of [["mousePressed",x,y,1],["mouseMoved",x+dx,y+dy,1],["mouseReleased",x+dx,y+dy,0]]) {
      await cdp.send("Input.dispatchMouseEvent",{type,x:px,y:py,button:"left",buttons,clickCount:1});
    }
    if (advance) await step();
  }
  async function marks(name) {
    const pair = report.frames[name] ??= {};
    const drawn = await pose();
    const png = role+"/"+name+".png";
    const points = isField ? await ev("replay.fieldLandmarks()") :
      await ev("("+sampleStudio+")().then(s=>{if(!s.visible||!s.count) throw Error('Missing WebGPU terrain');return s.landmarks.map(({index,pixel})=>({index,pixel}))})");
    await writeFile(join(out,png), await cdp.screenshot(clip));
    pair[role] = {drawn, png, points};
    if (isField) return;
    let reference = pair.field;
    if (name.startsWith("take-")) {
      close(v(drawn.eye).distanceTo(v(pair.field.drawn.eye)),0,name+" eye");
      close(q(drawn.rotation).angleTo(q(pair.field.drawn.rotation)),0,name+" heading and roll");
      close(drawn.fov,authored.kind.fovDeg,name+" evaluated recording lens");
      // Field draws its free lens during flight, then uses the target lens
      // on playback. Compare the take's framing to that authored key.
      const key = name.replace("take-","scrub-");
      reference = report.frames[key].field;
      pair.landmarkReference = "field/"+key;
    } else {
      samePose(drawn,reference.drawn,name);
    }
    const errors = report.landmarkErrors[name] = points.map(({index,pixel},i) => {
      assert.equal(index,reference.points[i].index);
      return Math.hypot(...pixel.map((n,j)=>n-reference.points[i].pixel[j]));
    });
    assert.ok(Math.max(...errors)<=1,name+" physical pixels "+errors);
  }
  async function capture(key,code) {
    const start = await ev("cameraCalls.length");
    const drawn = await pose();
    await tap(key,code);
    await until(cdp,`cameraCalls.slice(${start}).some(c=>c.ok && c.args.command?.type==="setActiveCamera")`);
    const commands = await ev(`cameraCalls.slice(${start}).filter(c=>c.name==="apply_command").map(c=>c.args.command)`);
    assert.deepEqual(commands.map(c=>[c.type,c.id]),[["setTransform",cameraId],["setActiveCamera",cameraId]]);
    const saved = (await state()).scene.objects.find(o=>o.id===cameraId).transform;
    const {x,y,z} = saved.rotationDeg;
    const rotation = new Quaternion().setFromEuler(new Euler(x*Math.PI/180,y*Math.PI/180,z*Math.PI/180,"ZYX"));
    close(rotation.angleTo(q(drawn.rotation)),0,code+" saved rotation");
    close(v(drawn.eye).distanceTo(new Vector3(saved.translation.x,saved.translation.y,saved.translation.z)),0,code+" saved eye",2e-6);
    lane.captures.push({code,commands,saved,drawn});
  }
  await setFree();
  const free = await pose();
  assert.ok(Math.abs(v(free.eye).distanceTo(v(free.target))-10)>1);
  await tap("0","Digit0");
  await step(2);
  lane.cameraEntry = await pose();
  if (isField) {
    // Field's entry effect applies a Y-up orbit update once. An ordinary tool
    // change re-evaluates its active camera and draws the authored roll.
    await click('[title^="Move (G)"]');
    await click('[title^="Select (V)"]');
    await step();
  }
  await marks("rolled");
  const authoredView = await pose();
  close(q(authoredView.rotation).angleTo(rolled.quaternion),0,"authored roll");
  close(authoredView.fov,53,"vertical FOV");
  close(authoredView.near,rolled.position.length()*.1,"near guard");
  close(authoredView.far,rolled.position.length()*8,"far guard");
  await capture("End","End");
  await click(cameraButton);
  await step(4);
  const restored = await pose();
  lane.roundTrip = {free,restored};
  if (!isField) {
    samePose(restored,free,"free view restored");
    close(v(restored.target).distanceTo(v(free.target)),0,"free orbit pivot restored");
  }

  if (!isField) {
    const cubeRow = `[data-object-id="${CUBE_ID}"]`;
    await click(cubeRow);
    await until(cdp,`document.querySelector('${cubeRow}').getAttribute("aria-selected")==="true"`);
    await click('[title^="Move (G)"]');
    await click('[title^="World-aligned"]');
    await step(2);
    lane.rolledFlyExit = await rolledFlyExit(cdp,pose,async () => {
      const grip = 'document.querySelector(".world-x-grip")';
      const [x,y] = await ev(`(()=>{const r=${grip}.getBoundingClientRect();if(!r.width)throw Error("Grip hidden");return [r.x+r.width/2,r.y+r.height/2]})()`);
      const mouse = (type,dx,buttons)=>cdp.send("Input.dispatchMouseEvent",{type,x:x+dx,y,button:"left",buttons,clickCount:1});
      const sample = ()=>ev(`({camera:vp04Calls.submittedCamera,sequence:${submission}.sequence})`);
      const before = await sample();
      const cubeTransform = async ()=>(await state()).scene.objects.find(o=>o.id===CUBE_ID).transform;
      const original = await cubeTransform();
      await mouse("mousePressed",0,1);
      assert.ok(await ev(grip+".hasPointerCapture(1)"));
      await step();
      const acquired = await sample();
      await mouse("mouseMoved",22,1);
      await step();
      const moved = await sample();
      assert.ok(moved.sequence > acquired.sequence,"first moved frame submitted");
      await step(6);
      const held = await sample();
      await mouse("mouseReleased",22,0);
      await until(cdp,`cameraCalls.some(c=>c.ok && c.args.command?.type==="setTransform" && c.args.command.id==="${CUBE_ID}")`);
      await step(8);
      const released = await sample();
      const committed = await cubeTransform();
      lane.rolledHandle = {before,acquired,moved,held,released,original,committed};
      assert.notEqual(committed.translation.x,original.translation.x,"World X drag committed");
      assert.equal(committed.translation.y,original.translation.y);
      assert.equal(committed.translation.z,original.translation.z);
      for (const [stage,row] of Object.entries({acquired,moved,held,released})) {
        assert.deepEqual(row.camera.up,before.camera.up,stage+" submitted camera up");
        assert.deepEqual(row.camera,before.camera,stage+" submitted camera");
      }
    });
  }
  // Start the independent fly and recording sequence from the fixture's
  // normal free view in both apps, including Field's default projection.
  await setup(path,true);
  await ev("("+observeCommands+")("+JSON.stringify(stillPath)+")");
  await setFree();
  if (!isField) await press("Shift","ShiftLeft");
  await click(flyButton);
  await step();
  if (!isField) {
    const start = await pose();
    await press("w","KeyW");
    await step(60);
    await press("w","KeyW","keyUp");
    lane.preheldShift = v((await pose()).eye).distanceTo(v(start.eye));
    close(lane.preheldShift,14,"Shift held before fly");
    await press("s","KeyS");
    await step(60);
    await press("s","KeyS","keyUp");
    await press("Shift","ShiftLeft","keyUp");
  }
  const beforeLook = await pose();
  await look(27,-16);
  const angles = new Euler().setFromQuaternion(q(beforeLook.rotation),"YXZ");
  angles.y -= 27*.0032;
  angles.x += 16*.0032;
  angles.z = 0;
  close(q((await pose()).rotation).angleTo(new Quaternion().setFromEuler(angles)),0,"left-drag look");
  for (const fast of [false,true]) {
    if (fast) await press("Shift","ShiftLeft");
    for (const key of ["w","e"]) {
      const before = await pose();
      await press(key,"Key"+key.toUpperCase());
      await step(60);
      await press(key,"Key"+key.toUpperCase(),"keyUp");
      const after = await pose();
      await step(10);
      samePose(await pose(),after,"release stopped motion");
      const delta = v(after.eye).sub(v(before.eye));
      const axis = key==="w" ? direction(before,[0,0,-1]) : new Vector3(0,1,0);
      const expected = fast ? 14 : 5;
      close(delta.distanceTo(axis.multiplyScalar(expected)),0,key+" travel");
      lane.travel.push({key,fast,updates:60,dt:1/60,distance:delta.length(),delta:delta.toArray()});
      const back = key==="w" ? "s" : "q";
      await press(back,"Key"+back.toUpperCase());
      await step(60);
      await press(back,"Key"+back.toUpperCase(),"keyUp");
      samePose(await pose(),before,back+" reversed travel");
    }
    if (fast) await press("Shift","ShiftLeft","keyUp");
  }
  const base = await pose();
  await press("d","KeyD");
  await step(1,500);
  const capped = await pose();
  close(v(capped.eye).sub(v(base.eye)).distanceTo(direction(base,[1,0,0]).multiplyScalar(.5)),0,"elapsed time cap");
  await ev('window.dispatchEvent(new Event("blur"))');
  await step(12);
  samePose(await pose(),capped,"blur stopped motion");
  await capture("1","Numpad1");
  assert.equal(await ev('document.querySelector(\'[title^="Fly camera"]\').getAttribute("aria-pressed")'),"true");
  await tap("Escape","Escape");
  await step(30);
  const afterFly = await pose();
  samePose(afterFly,capped,"fly exit");
  close(v(afterFly.target).sub(v(afterFly.eye)).distanceTo(direction(capped,[0,0,-1]).multiplyScalar(10)),0,"fly exit pivot");
  lane.flyExit = {capped,afterFly};
  await click(flyButton);
  await press("a","KeyA");
  await step(1,100);
  samePose(await pose(),base,"A follows camera left");
  await tap("Escape","Escape");
  await click(flyButton);
  await step(12);
  samePose(await pose(),base,"re-entering fly clears held keys");
  await press("a","KeyA","keyUp");
  lane.pitchLimits = [];
  for (const [dy,count,limit] of [[-300,3,1.55],[300,4,-1.55]]) {
    for (let i=0;i<count;i++) await look(0,dy);
    const pitch = new Euler().setFromQuaternion(q((await pose()).rotation),"YXZ").x;
    close(pitch,limit,"pitch clamp");
    lane.pitchLimits.push(pitch);
  }
  if (!isField) {
    const displayed = await pose();
    await look(28,18,false);
    await tap("Escape","Escape");
    await step(12);
    samePose(await pose(),displayed,"fly exit with an unsubmitted look");
  } else await tap("Escape","Escape");
  await setFree();
  const northBefore = await pose();
  await click(".north-arrow");
  await step(2);
  const northAfter = await pose();
  await until(cdp,'document.querySelector(".north-arrow").innerText.includes("BRG 000")');
  lane.north = {before:northBefore,after:northAfter,readout:await ev('document.querySelector(".north-arrow").innerText')};
  assert.match(lane.north.readout,/BRG 000\u00b0/);
  close(v(northBefore.target).distanceTo(v(northAfter.target)),0,"North pivot");
  close(northBefore.eye[1],northAfter.eye[1],"North height");
  close(v(northBefore.eye).distanceTo(v(northBefore.target)),v(northAfter.eye).distanceTo(v(northAfter.target)),"North radius");
  await setFree();

  await click('[aria-label="Animation"][role="tab"]');
  await click(".button--record");
  await until(cdp,'!!document.querySelector(".is-recording")');
  await step(1,0);
  await press("w","KeyW");
  const samples = {0:await pose()};
  close(samples[0].fov,isField ? free.fov : authored.kind.fovDeg,"initial recording lens");
  const frameAt = frame => 'document.querySelector(".timeline__frame").textContent.trim().startsWith("'+frame+' /")';
  for (let frame=1;frame<=8;frame++) {
    if (frame===5) await look(9,0,false);
    await step(1,42);
    await until(cdp,frameAt(frame));
    if (frame%4===0) {
      samples[frame] = await pose();
      await marks("take-"+frame);
    }
  }
  await press("w","KeyW","keyUp");
  await click(".button--record");
  await until(cdp,'cameraCalls.some(c=>c.ok && c.args.command?.type==="setChannelKeys")');
  const track = (await state()).timeline.tracks.find(t=>t.objectId===cameraId);
  lane.take = track;
  const channels = new Map(track.channels.map(c=>[c.channel,c.keys]));
  assert.equal(channels.size,6);
  for (const [i,frame] of [0,4,8].entries()) {
    const xyz = prefix => ["X","Y","Z"].map(axis=>channels.get(prefix+axis)[i].value);
    close(v(xyz("translation")).distanceTo(v(samples[frame].eye)),0,"recorded sample eye",2e-6);
    const [x,y,z] = xyz("rotation").map(n=>n*Math.PI/180);
    close(new Quaternion().setFromEuler(new Euler(x,y,z,"ZYX")).angleTo(q(samples[frame].rotation)),0,"recorded sample rotation");
  }
  for (const c of track.channels) assert.deepEqual(c.keys.map(k=>k.frame),[0,4,8]);
  assert.ok(track.channels.some(c=>Math.abs(c.keys[2].value-c.keys[1].value)>.01));
  await click(cameraButton);
  async function scrub(frame) {
    const start = await ev("cameraCalls.length");
    await ev(`(()=>{const e=document.querySelector(".timeline__scrub");Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(e,${frame});e.dispatchEvent(new Event("input",{bubbles:true}))})()`);
    await until(cdp,frameAt(frame)+' && cameraCalls.slice('+start+').some(c=>c.name==="set_playhead" && c.ok && c.args.frame==='+frame+')');
    await step(1,0);
  }
  await scrub(4);
  await marks("scrub-4");
  await scrub(8);
  await marks("scrub-8");
  lane.recordingErrors = {};
  for (const frame of [4,8]) {
    const sample = report.frames["take-"+frame][role], played = report.frames["scrub-"+frame][role];
    close(played.drawn.fov,authored.kind.fovDeg,"authored playback FOV");
    const errors = lane.recordingErrors[frame] = played.points.map((p,i)=>
      Math.hypot(...p.pixel.map((x,j)=>x-sample.points[i].pixel[j])));
    if (!isField) assert.ok(Math.max(...errors)<=1,"recorded-to-scrubbed landmark error "+errors);
  }
  await scrub(0);
  await click('[aria-label="Start playback"]');
  for (let frame=1;frame<=8;frame++) {
    await step(1,42);
    await until(cdp,frameAt(frame));
    await step(1,0);
    if (frame%4===0) {
      await marks("play-"+frame);
      samePose(report.frames["play-"+frame][role].drawn,report.frames["scrub-"+frame][role].drawn,"scrub and playback");
    }
  }
  await click('[aria-label="Stop playback"]');
  lane.pointerTrace = await ev("replay.trace");
  lane.playheadCalls = await ev('cameraCalls.filter(c=>c.name==="set_playhead").map(c=>({frame:c.args.frame,update:c.update}))');

  // Read the service requests after a real preview, still, and two offline
  // animation renders. The latter evaluate the native project's keyed clone.
  await click('[title^="Rendered mode"]');
  await until(cdp,'cameraCalls.some(c=>c.name==="render_frame" && c.ok) && document.querySelector(".viewport-rendered img")?.naturalWidth>0');
  await click('[title^="Render a full-resolution still"]');
  await until(cdp,'cameraCalls.some(c=>c.name==="render_still" && c.ok)');
  lane.renderCalls = await ev('cameraCalls.filter(c=>c.name==="render_frame" || c.name==="render_still")');
  for (const c of lane.renderCalls.filter(c=>c.ok)) assert.equal(c.renderPath,"mapscene");
  for (const frame of [4,8]) {
    const output = join(out,role,"native-"+frame+".png");
    const result = await ev('__TAURI_INTERNALS__.invoke("render_animation_frame",'+JSON.stringify({frame,width:320,height:240,quality:"final",output})+')');
    assert.equal(result.evaluatedFrame,frame);
  }
  const native = (await readFile(process.env.VP09_RENDER_LOG,"utf8")).trim().split(/\r?\n/).map(s=>JSON.parse(s));
  for (const [name,output] of [["preview",null],["still",stillPath],...([4,8].map(f=>["key-"+f,join(out,role,"native-"+f+".png")]))]) {
    lane.native[name] = native.findLast(r=>r.output===output)?.camera;
    assert.ok(lane.native[name],name+" native renderer payload "+JSON.stringify(native));
  }

  if (!isField) {
    // While Rendered stays open, scrub and leave camera view. Both actions
    // should replace the displayed native image without pressing Re-render.
    const start = await ev("cameraCalls.length");
    await scrub(4);
    const renderedKey = lane.native["key-4"];
    await until(cdp,`cameraCalls.slice(${start}).some(c=>c.name==="render_frame" && c.ok && Math.abs(c.args.view.target[0]-${renderedKey.target[0]})<0.001)`);
    await click(cameraButton);
    await until(cdp,`cameraCalls.slice(${start}).some(c=>c.name==="render_frame" && c.ok && c.args.view.fovDeg===${free.fov})`);
    const wheelStart = await ev("cameraCalls.length");
    await cdp.send("Input.dispatchMouseEvent",{type:"mouseWheel",x:view.x+250,y:view.y+350,deltaX:0,deltaY:-100});
    await until(cdp,"cameraCalls.length>"+wheelStart);
    await step();
    const snapStart = await ev("cameraCalls.length");
    await click(".north-arrow");
    await step();
    await until(cdp,`cameraCalls.slice(${snapStart}).some(c=>c.name==="render_frame" && c.ok && Math.abs(c.args.view.phiDeg-270)<1e-6)`);
    await until(cdp,`lastNativePreview.call.args.view.phiDeg===270 && document.querySelector(".viewport-rendered img")?.src.endsWith(lastNativePreview.png)`);
    lane.renderedTransitions = await ev("cameraCalls.slice("+start+").filter(c=>c.name==='render_frame' && c.ok)");
  }

  if (!isField) {
    // Reopen the authored pose with the optional relief metadata omitted.
    const legacy = structuredClone(project);
    delete legacy.scene.objects.find(o=>o.id===TERRAIN_ID).kind.elevationRange;
    const lens = {channel:"fovDeg",keys:[[0,53],[12,67],[24,82]].map(([frame,value])=>({frame,value,interpolation:"linear"}))};
    legacy.timeline.tracks.push({objectId:cameraId,channels:[lens]});
    const legacyPath = join(out,"fixture","missing-range.studio3d");
    await writeFile(legacyPath, JSON.stringify(legacy));
    await setup(legacyPath,true);
    await ev("("+observeCommands+")("+JSON.stringify(stillPath)+")");
    await tap("0","Digit0");
    await step(2);
    const stationary = await pose();
    close(q(stationary.rotation).angleTo(rolled.quaternion),0,"rolled starting pose");
    await click('[aria-label="Animation"][role="tab"]');
    await click(".button--record");
    await until(cdp,'!!document.querySelector(".is-recording")');
    lane.stationaryLens = [stationary.fov];
    for (let frame=1;frame<=4;frame++) {
      await step(1,42);
      await until(cdp,frameAt(frame));
      await step(1,0);
      const sample = await pose();
      lane.stationaryLens.push(sample.fov);
      samePose(sample,{...stationary,fov:Math.fround(53+frame*14/12)},"stationary take with animated lens");
    }
    await click(".button--record");
    await until(cdp,'cameraCalls.some(c=>c.ok && c.args.command?.type==="setChannelKeys")');
    const stationaryTrack = (await state()).timeline.tracks.find(t=>t.objectId===cameraId);
    assert.deepEqual(stationaryTrack.channels.find(c=>c.channel==="fovDeg"),lens);
    assert.equal(stationaryTrack.channels.length,7);
    for (const channel of stationaryTrack.channels.filter(c=>c.channel!=="fovDeg")) {
      assert.deepEqual(channel.keys.map(k=>k.frame),[0,4]);
      close(channel.keys[0].value,channel.keys[1].value,"stationary "+channel.channel);
    }
    lane.stationaryTake = stationaryTrack;
    await click(cameraButton);
    for (const {frame,value} of lens.keys.slice(1)) {
      await scrub(frame);
      close((await pose()).fov,value,"later lens key "+frame);
    }
    await scrub(0);
    const drawn = await pose();
    samePose(drawn,stationary,"stationary playback");

    const nativeView = await ev("forge3dViewportDiagnostics().nativeView");
    assert.equal(nativeView.measureRelief,true);
    close(nativeView.rollDeg,30,"live native roll",1e-4);
    await click('[title^="Rendered mode"]');
    await until(cdp,'window.lastNativePreview && document.querySelector(".viewport-rendered img")?.src.endsWith(lastNativePreview.png)');
    await writeFile(join(out,role,"rolled-preview.png"),Buffer.from(await ev("lastNativePreview.png"),"base64"));
    await click('[title^="Solid mode"]');
    const imagePath = name=>join(out,role,name+".png");
    for (const [name,view] of [["rolled-still",nativeView],["level-still",{...nativeView,rollDeg:0}]]) {
      await ev('__TAURI_INTERNALS__.invoke("render_still",'+JSON.stringify({path:imagePath(name),view})+')');
    }
    await ev('__TAURI_INTERNALS__.invoke("render_animation_frame",'+JSON.stringify({frame:0,width:320,height:240,quality:"final",output:imagePath("rolled-key")})+')');
    const log = (await readFile(process.env.VP09_RENDER_LOG,"utf8")).trim().split(/\r?\n/).map(s=>JSON.parse(s));
    const still = log.find(r=>r.output===imagePath("rolled-still")).camera;
    const keyed = log.find(r=>r.output===imagePath("rolled-key")).camera;
    close(still.rollDeg,keyed.rollDeg,"native keyed roll",1e-4);
    close(v(still.target).distanceTo(v(keyed.target)),0,"missing-range native aim",.001);
    assert.ok(nativeView.target[2]-still.target[2]>200,"measured half relief");
    const preview = log.findLast(r=>r.output===null).camera;
    close(preview.rollDeg,still.rollDeg,"native preview roll");
    close(v(preview.target).distanceTo(v(still.target)),0,"native preview aim");
    lane.missingRange = {nativeView,preview,still,keyed};
    lane.nativeRollPixels = JSON.parse(execFileSync(process.env.FORGE3D_STUDIO_PYTHON,
      [join(root,"scripts/vp09/roll_pixels.py"),imagePath("level-still"),imagePath("rolled-still"),imagePath("rolled-key")],{encoding:"utf8"}));

    await click(flyButton);
    await step();
    await click('[role="tab"][aria-label="Object"]');
    const field = `[...document.querySelectorAll("label")].find(l=>l.querySelector(".field-label")?.textContent==="Name")?.querySelector("input")`;
    await until(cdp, "!!("+field+")");
    await ev(`window.nameInput=${field};nameInput.focus();nameInput.select()`);
    const start = await ev("cameraCalls.length");
    for (const key of "east") {
      await cdp.send("Input.dispatchKeyEvent",{type:"keyDown",key,code:"Key"+key.toUpperCase(),text:key});
      await step();
      await press(key,"Key"+key.toUpperCase(),"keyUp");
    }
    await tap("End","End");
    await step();
    lane.inspectorName = await ev("nameInput.value");
    assert.equal(lane.inspectorName,"east");
    assert.deepEqual(await ev("cameraCalls.slice("+start+").filter(c=>c.name==='apply_command')"),[]);
    samePose(await pose(),drawn,"editing preserves camera");
    await ev("nameInput.blur()");
  }

  await setup(cubeFile,false);
  await setFree();
  lane.axes = {};
  for (const axis of ["X","Y","Z"]) {
    await ev('document.querySelector(\'[aria-label="Look along the '+axis+' axis"]\').dispatchEvent(new MouseEvent("click",{bubbles:true}))');
    await step(2);
    const drawn = lane.axes[axis] = await pose();
    const unit = new Vector3().setComponent("XYZ".indexOf(axis),1);
    close(v(drawn.eye).sub(v(drawn.target)).normalize().distanceTo(unit),0,axis+" positive axis",2e-6);
    if (axis==="Y") close(direction(drawn,[0,1,0]).distanceTo(v([0,0,-1])),0,"top view map north",2e-6);
  }
}

try {
  for (const role of ["field","candidate"]) {
    process.env.VP09_RENDER_LOG = join(out,role+"-renderer.jsonl");
    await desktop({root, field, out, role, values:{}, report, metrics:{width:1440,height:833},
      candidatePlugins:[{name:"vp09-submitted-camera", transform(code,id) {
        if (id.endsWith("/src/main.tsx")) return "await window.observeCameraDraws();\n"+code;
      }}],
      observeCandidate:cdp=>cdp.send("Page.addScriptToEvaluateOnNewDocument",{runImmediately:true,
        source:`(${observeContexts})(false,"document");window.observeCameraDraws=${observeUpload};`}),
    },cdp=>run(cdp,role));
  }
  await desktop({root,field,out,role:"editor",values:{},report,metrics:{width:1440,height:833}}, async cdp=>{
    await openFixture(cdp,path);
    const diag = "forge3dViewportDiagnostics()";
    await until(cdp,"window.forge3dViewportDiagnostics?.().runtime?.orbit.enabled");
    const [x,y] = await cdp.evaluate(`(()=>{const r=${diag}.runtime.renderer.domElement.getBoundingClientRect();return [r.x+250,r.y+350]})()`);
    const mouse = (type,dx,buttons)=>cdp.send("Input.dispatchMouseEvent",{type,x:x+dx,y,button:"left",buttons,clickCount:1});
    async function toggleCamera() {
      for (const type of ["keyDown","keyUp"]) await cdp.send("Input.dispatchKeyEvent",{type,key:"0",code:"Digit0"});
    }
    await mouse("mousePressed",0,1);
    await mouse("mouseMoved",12,1);
    await toggleCamera();
    await until(cdp,"!"+diag+".runtime.orbit.enabled");
    await mouse("mouseMoved",212,1);
    await toggleCamera();
    await until(cdp,diag+".runtime.orbit.enabled");
    const eye = diag+".runtime.camera.position.toArray()";
    const before = await cdp.evaluate(eye);
    await mouse("mouseMoved",213,1);
    await cdp.evaluate("new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))");
    const after = await cdp.evaluate(eye);
    report.editorHeldDrag = {before,after};
    close(v(before).distanceTo(v(after)),0,"orbit handoff while pointer held");
    await mouse("mouseReleased",213,0);
    await cdp.evaluate(`(()=>{
      const r=${diag}.runtime,render=r.renderer.render;
      r.renderer.render=function(scene,camera){
        const result=render.apply(this,arguments);
        if(scene===r.scene) window.editorPose={eye:camera.position.toArray(),rotation:camera.quaternion.toArray(),
          fov:camera.fov,near:camera.near,far:camera.far,target:r.orbit.target.toArray()};
        return result;
      };
      r.needsRender=true;
    })()`);
    await cdp.evaluate("("+installReplay+")(false,true)");
    report.editorRolledFlyExit = await rolledFlyExit(cdp,()=>cdp.evaluate("editorPose"));
    samePose(report.editorRolledFlyExit.idle,report.candidate.rolledFlyExit.idle,"editor and standalone rolled exit");
    samePose(report.editorRolledFlyExit.nextOrbit,report.candidate.rolledFlyExit.nextOrbit,"first orbit gesture");
  });
  for (const [name,reference] of Object.entries(report.field.native)) {
    const measured = report.candidate.native[name];
    for (const key of ["phiDeg","thetaDeg","radius","fovDeg"]) close(measured[key],reference[key],name+" "+key,1e-4);
    close(v(measured.target).distanceTo(v(reference.target)),0,name+" native target",1e-3);
  }
  for (const file of ["still.png","native-4.png","native-8.png"]) {
    const [reference,candidate] = await Promise.all(["field","candidate"].map(role=>readFile(join(out,role,file))));
    assert.ok(candidate.equals(reference),file+" matches the native reference");
  }
  report.passed = true;
  console.log("Physical landmark errors",report.landmarkErrors);
} finally {
  await writeFile(join(out,"results.json"),JSON.stringify(report,null,2)+"\n");
}
