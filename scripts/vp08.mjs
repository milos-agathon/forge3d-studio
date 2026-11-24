import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { decodePng } from "../node_modules/@forge3d/web/dist/png-decode.js";
import "./prepare-viewport-runtime.mjs";
import { createFixture, CUBE_ID, TERRAIN_ID, FIELD_REVISION, verifyProvenance } from "./vp01/fixture.mjs";
import { observeContexts } from "./vp01/startup.mjs";
import { desktop, fieldCheckout, until } from "./viewport-desktop.mjs";
import { observeUpload, sampleStudio } from "./vp04/page.mjs";
import { installReplay } from "./vp08-page.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const field = fieldCheckout(root);
const out = await mkdtemp(join(tmpdir(), "studio-vp08-"));
console.log("VP-08 evidence", out);
process.env.PYTHONDONTWRITEBYTECODE = "1";
process.env.FORGE3D_STUDIO_PYTHON ??= execFileSync("python", ["-c", "import sys; print(sys.executable)"], { encoding: "utf8" }).trim();
const { path } = await createFixture(join(out, "fixture"));
const project = JSON.parse(await readFile(path));
const terrain = project.scene.objects.find(o => o.id === TERRAIN_ID);
delete terrain.kind.overlay;
project.assets = project.assets.filter(a => a.id === terrain.kind.asset);
project.selection = [];
await writeFile(path, JSON.stringify(project));
const eye = [9.5,7,11], aim = [0,.8,0];
// Archived Bryce poses from Field Instrument at 64b7cf09 (Studio coordinates).
const defaultTarget = [3.487943814610962,3.0763422790092587,4.038671785339008];
const archivedEyes = {
  "low-oblique": [10.45933614627547,4.74947643860874,11.010064117003516],
  "near-nadir": [3.487943814610962,13.07022290061458,4.38845760709518],
};
const report = { base: execFileSync("git", ["rev-parse","HEAD"], {cwd:root,encoding:"utf8"}).trim(),
  reference: FIELD_REVISION, runtime: (await verifyProvenance()).commit, samples: {}, landmarks: {} };
const D = "forge3dViewportDiagnostics()", S = D + ".terrainViewport.diagnosticSubmission";
const close = (a,b,label,tolerance=1e-7) => assert.ok(Math.abs(a-b) < tolerance, label + ": " + a + " vs " + b);

async function openFixture(cdp) {
  const ev = expr => cdp.evaluate(expr);
  await until(cdp, '!!document.querySelector(".menu__button")');
  await ev('localStorage.setItem("studio.viewport.mapGrid","0")');
  await ev('__TAURI_INTERNALS__.invoke("open_project", {path:'+JSON.stringify(path)+'})');
  await reload(cdp);
}

async function reload(cdp) {
  const ev = expr => cdp.evaluate(expr);
  await ev("window.oldDocument=true");
  await cdp.send("Page.reload", {ignoreCache:true});
  await until(cdp, "!window.oldDocument && !!document.querySelector('.viewport')");
  await ev(`document.querySelector('.recovery button[aria-label="Dismiss"]')?.click();
    Object.assign(document.querySelector(".viewport").style,{boxSizing:"content-box",flex:"none",width:"794px",height:"727px"})`);
}

async function run(cdp, role) {
  const isField = role === "field";
  const ev = expr => cdp.evaluate(expr);
  await openFixture(cdp);
  await until(cdp, isField
    ? `window.__vp01FieldDiagnostics?.().runtime.renderer.domElement.height===727 &&
      !!__vp01FieldDiagnostics().runtime.objects.get("${TERRAIN_ID}")?.children.find(c=>c.userData.elevation)`
    : `!!window.vp04Calls?.setTerrain && !!vp04Calls.submittedCamera && document.querySelector("[data-viewport-backend]")?.textContent.includes("WebGPU available") && !${D}.runtime && ${S}?.width===794 && ${S}.visibleIds.includes("${CUBE_ID}")`);
  const view = await ev(`(${installReplay})(${isField})`);
  const lane = report[role] = { view };
  assert.deepEqual(view.css,[794,727]);
  assert.deepEqual(view.physical,view.css);
  assert.equal(view.dpr,1);
  if (isField) assert.equal(view.backend,"WebGL2RenderingContext");
  else {
    assert.match(view.backend,/WebGPU available/);
    lane.contexts = await ev('__vp01Contexts.filter(c=>c.requested.includes("webgl"))');
    assert.ok(lane.contexts.length && lane.contexts.every(c=>c.result===null));
  }

  const step = n => ev("replay.step("+n+")");
  const sample = async (name, updates) => {
    await step(updates);
    const { pose, live } = await ev("({pose:replay.sample(), live:replay.livePose()})");
    const pair = report.samples[name] ??= { updates, live: {} };
    pair[role] = pose;
    pair.live[role] = live;
    if (!isField) {
      for (const [label, poses] of [["displayed",pair],["live",pair.live]]) {
        for (const key of ["eye","target"]) {
          poses.candidate[key].forEach((v,i)=>close(v,poses.field[key][i],name+" "+label+" "+key,1e-6));
        }
        close(poses.candidate.radius,poses.field.radius,name+" "+label+" radius");
      }
    }
    return pose;
  };
  const marks = async name => {
    const row = report.landmarks[name] ??= {};
    if (isField) row.field = await ev("replay.fieldLandmarks()");
    else {
      const frame = await ev(`(${sampleStudio})().then(s=>({ landmarks:s.landmarks.map(({index,pixel})=>({index,pixel})),
        visible:s.visible, coverage:s.count, rgba:s.rgbaSha256 }))`);
      assert.ok(frame.visible && frame.coverage > 0);
      row.candidate = frame.landmarks;
      row.rgba = frame.rgba;
      row.errors = row.candidate.map(({index,pixel},i) => {
        assert.equal(index,row.field[i].index);
        return Math.hypot(...pixel.map((v,axis)=>v-row.field[i].pixel[axis]));
      });
      assert.ok(Math.max(...row.errors)<=1,JSON.stringify(row));
    }
  };

  // All positions are CSS pixels relative to the viewport's upper left.
  const mouse = (type,x,y,button="left",modifiers=0) => cdp.send("Input.dispatchMouseEvent", {
    type, x:view.x+x, y:view.y+y, button, modifiers,
    buttons:type==="mouseReleased" ? 0 : {left:1,right:2,middle:4}[button],
    ...(type==="mouseMoved" ? {} : {clickCount:1}),
  });
  async function drag(button,dx,dy,modifiers=0) {
    const x=250,y=350;
    await mouse("mousePressed",x,y,button,modifiers);
    await mouse("mouseMoved",x+dx/2,y+dy/2,button,modifiers);
    await step(2);
    await mouse("mouseMoved",x+dx,y+dy,button,modifiers);
    await mouse("mouseReleased",x+dx,y+dy,button,modifiers);
  }
  async function wheel(deltaY) {
    const count = await ev('replay.trace.filter(e=>e.type==="wheel").length');
    await cdp.send("Input.dispatchMouseEvent",{type:"mouseWheel",x:view.x+250,y:view.y+350,deltaX:0,deltaY});
    await until(cdp,`replay.trace.filter(e=>e.type==="wheel").length>${count}`);
  }
  async function idle() {
    const before = await ev("replay.sample().sequence");
    await step(32);
    const frames = await ev("replay.sample().sequence")-before;
    assert.equal(frames,0);
    return { updates:32, submissions:frames };
  }

  const start = await sample("default",2);
  close(start.radius,10,"fresh-open radius");
  eye.forEach((v,i)=>close(start.eye[i],v,"fresh-open eye"));
  defaultTarget.forEach((v,i)=>close(start.target[i],v,"fresh-open pivot"));
  await marks("default");
  lane.idleBeforeWheel = await idle();
  await wheel(-100);
  const zoom = await sample("idle wheel",1);
  assert.equal(zoom.sequence,start.sequence+1);
  close(zoom.radius/start.radius,.95,"idle wheel ratio");
  if (!isField) {
    lane.wheelFrame = await ev(`(${sampleStudio})().then(s=>({visible:s.visible,coverage:s.count,rgba:s.rgbaSha256}))`);
    assert.ok(lane.wheelFrame.visible && lane.wheelFrame.coverage > 0);
    assert.notEqual(lane.wheelFrame.rgba,report.landmarks.default.rgba);
  }
  close(Math.hypot(...start.eye.map((v,i)=>v-zoom.eye[i])),.5,"first wheel eye travel");
  const setPose = async (position,target) => {
    await ev(`replay.setPose(${JSON.stringify(position)},${JSON.stringify(target)})`);
    await step(2);
  };
  for (const [name,position] of Object.entries(archivedEyes)) {
    await setPose(position,defaultTarget);
    const pose = await sample(name,0);
    position.forEach((v,i)=>close(pose.eye[i],v,name+" archived eye"));
    defaultTarget.forEach((v,i)=>close(pose.target[i],v,name+" archived target"));
    await marks(name);
  }
  // The gesture trace uses a second, explicit common pivot after stock startup.
  for (const gap of [0,1]) {
    const name = "orbit to pan ("+gap+" intervening updates)";
    await setPose(eye,aim);
    await mouse("mousePressed",250,350);
    await mouse("mouseMoved",370,375);
    await step(3);
    await mouse("mouseMoved",400,379);
    await mouse("mouseReleased",400,379);
    await step(gap);
    await mouse("mousePressed",400,379,"right");
    await mouse("mouseMoved",430,403,"right");
    await mouse("mouseReleased",430,403,"right");
    await sample(name+" release",0);
    await sample(name+" rest",260);
    await marks(name);
  }
  // With two pan moves between frames, the second sees the matrix left by
  // the first move's lookAt, while orbit damping is still turning the eye.
  await setPose(eye,aim);
  await mouse("mousePressed",250,350);
  await mouse("mouseMoved",370,375);
  await mouse("mouseReleased",370,375);
  await step(4);
  await mouse("mousePressed",370,375,"right");
  await mouse("mouseMoved",385,387,"right");
  await mouse("mouseMoved",400,399,"right");
  await mouse("mouseReleased",400,399,"right");
  await sample("two pan moves release",0);
  await sample("two pan moves rest",260);
  await marks("two pan moves");
  await setPose(eye,aim);
  await mouse("mousePressed",250,350);
  await mouse("mouseMoved",253,350);
  const shortMove = await sample("three pixel orbit",8);
  assert.ok(Math.hypot(...eye.map((v,i)=>v-shortMove.eye[i]))>.2);
  await mouse("mouseMoved",258,350);
  await mouse("mouseReleased",258,350);
  await sample("slow drag rest",250);
  for (const [name,modifier] of [["shift",8],["ctrl",2],["meta",4]]) {
    await setPose(eye,aim);
    await drag("right",24,14,modifier);
    const orbit = await sample(name+" right orbit",250);
    aim.forEach((v,i)=>close(orbit.target[i],v,"modified right pivot"));
    assert.ok(Math.hypot(...eye.map((v,i)=>v-orbit.eye[i]))>1);
  }
  await setPose(eye,aim);
  await wheel(-100);
  await step(1);
  await drag("left",34,-28);
  await sample("orbit",1);
  await sample("orbit damping",8);
  await sample("orbit rest",230);
  await drag("left",-40,159);
  const nadir = await sample("high orbit rest",240);
  assert.ok((nadir.eye[1]-nadir.target[1])/nadir.radius>.99);

  for (const [button,modifiers,name] of [["right",0,"right"],["left",8,"shift"],["left",2,"ctrl"],["left",4,"meta"]]) {
    const before = await ev("replay.sample()");
    await drag(button,12,8,modifiers);
    const early = await sample(name+" pan",3);
    const tail = await sample(name+" pan tail",100);
    const after = await sample(name+" pan rest",120);
    const windows = { first100: tail.sequence-early.sequence, next120: after.sequence-tail.sequence };
    (lane.panDraws ??= {})[name] = windows;
    assert.equal(windows.next120,0,name+" settled pan continued drawing");
    if (!isField) assert.deepEqual(windows,report.field.panDraws[name],name+" damping submissions");
    close(after.target[1],before.target[1],"ground plane");
    close(after.radius,before.radius,"pan radius");
    assert.ok(Math.hypot(after.target[0]-before.target[0],after.target[2]-before.target[2])>.01);
  }
  await drag("middle",4,60);
  const dolly = await sample("middle dolly",1);
  close(dolly.radius, nadir.radius * .95**(-.6),"middle radius");
  // CDP wheel injection uses pixels. Exercise DOM line/page units separately.
  for (const [mode,delta,units] of [[1,-2,16],[2,1,100]]) {
    const before = await ev("replay.sample().radius");
    await ev(`document.elementFromPoint(${view.x+250},${view.y+350}).dispatchEvent(new WheelEvent("wheel",{
      clientX:${view.x+250},clientY:${view.y+350},deltaMode:${mode},deltaY:${delta},bubbles:true,cancelable:true}))`);
    const after = await sample("wheel mode "+mode,1);
    close(after.radius,before*.95**(-delta*units/100),"wheel units");
  }
  await drag("left",14,-245);
  const lower = await sample("lower hemisphere",240);
  assert.ok(lower.eye[1]<lower.target[1]);
  for (const [delta,limit] of [[20000,150],[-20000,.8]]) {
    await wheel(delta);
    close((await sample("radius "+limit,1)).radius,limit,"radius clamp");
  }
  // Return to an above-ground, unclamped frame with more real input.
  await wheel(5800);
  await drag("left",25,140);
  await sample("pick pose",250);
  lane.idleAfterOrbit = await idle();
  lane.trace = await ev("replay.trace");
  lane.dragSelectionCalls = await ev("replay.calls.length");
  assert.equal(lane.dragSelectionCalls,0);
  if (isField) return;
  assert.deepEqual(lane.trace,report.field.trace);
  lane.cubePixel = await ev("replay.cubePixel()");
  const clip = { x:view.x+lane.cubePixel.x, y:view.y+lane.cubePixel.y, width:1, height:1 };
  const [r,g,b,a] = decodePng(await cdp.screenshot(clip)).data;
  lane.compositedPixel = [r,g,b,a];
  assert.ok(r>g+24 && b>g+24 && a>200,"cube must be magenta on the displayed frame");
  await cdp.click([clip.x+.5,clip.y+.5]);
  await until(cdp,`${D}.lastPick?.hit?.id==="${CUBE_ID}" && document.querySelector('[data-object-id="${CUBE_ID}"]').getAttribute("aria-selected")==="true"`);
  lane.pick = await ev(D+".lastPick");
  assert.equal(await ev("replay.calls.length"),1);
  assert.deepEqual(await ev('__TAURI_INTERNALS__.invoke("project_state").then(s=>s.project.selection)'),[CUBE_ID]);
  await ev('document.querySelector(\'button[title^="Move (G)"]\').click(); document.querySelector(\'button[title^="World-aligned"]\').click()');
  await step(2);
  // Acquire the grip while there is still orbit momentum.
  await drag("left",14,10);
  await step(1);
  const grip = 'document.querySelector(".world-x-grip")';
  const [gx,gy] = await ev(`(()=>{const r=${grip}.getBoundingClientRect();if(!r.width)throw Error("Grip hidden");return [r.x+r.width/2,r.y+r.height/2]})()`);
  const frozen = await ev("replay.sample()");
  // Wheel changes the live eye immediately. The grip still belongs to the
  // displayed frame. Acquire it before giving the viewport another RAF.
  await wheel(-100);
  const pending = await ev("replay.livePose()");
  assert.ok(pending.radius < frozen.radius*.96);
  await mouse("mousePressed",gx-view.x,gy-view.y);
  assert.ok(await ev(grip+".hasPointerCapture(1)"));
  await step(1);
  const firstHeld = await ev("replay.sample()");
  assert.ok(await ev(grip+".hasPointerCapture(1)"));
  assert.deepEqual(firstHeld.eye,frozen.eye);
  assert.deepEqual(firstHeld.target,frozen.target);
  await step(11);
  await wheel(-100);
  await mouse("mouseMoved",gx-view.x+22,gy-view.y);
  await step(6);
  const held = await ev("replay.sample()");
  assert.ok(held.sequence > frozen.sequence,"the captured handle must submit its moved preview");
  assert.deepEqual(held.eye,frozen.eye);
  assert.deepEqual(held.target,frozen.target);
  await mouse("mouseReleased",gx-view.x+22,gy-view.y);
  await step(8);
  const released = await ev("replay.sample()");
  assert.deepEqual(released.eye,frozen.eye);
  assert.deepEqual(released.target,frozen.target);
  lane.handle = { frozen, pending, firstHeld, held, released };
  console.log("Cube pick",lane.pick.hit.id,"idle submissions",lane.idleAfterOrbit.submissions);
}

// With an editor present, one notch must still be consumed exactly once.
// Switch through the same persisted renderer preference used by the View menu.
async function editorOwnership(cdp) {
  await openFixture(cdp);
  const ev = expr => cdp.evaluate(expr);
  const badge = 'document.querySelector("[data-viewport-backend]")?.textContent';
  report.editorOwnership = [];
  for (const mode of ["hybrid","three"]) {
    if (mode === "three") {
      await ev('localStorage.setItem("studio.viewport.renderer","three")');
      await reload(cdp);
    }
    const status = mode === "three" ? "View menu override" : "WebGPU available";
    await until(cdp,`window.forge3dViewportDiagnostics?.().runtime && ${badge}.includes("${status}")`);
    const radius = D+".runtime.orbit.getDistance()";
    const before = await ev(radius);
    const [x,y] = await ev(`(()=>{const r=${D}.runtime.renderer.domElement.getBoundingClientRect();return [r.x+250,r.y+350]})()`);
    async function wheel() {
      await ev('window.wheelSeen=false;window.addEventListener("wheel",()=>window.wheelSeen=true,{capture:true,once:true})');
      await cdp.send("Input.dispatchMouseEvent",{type:"mouseWheel",x,y,deltaX:0,deltaY:-100});
      await until(cdp,"window.wheelSeen");
      await ev("new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))");
    }
    await wheel();
    const after = await ev(radius);
    close(after/before,.95,mode+" wheel ownership");
    const row = { backend:await ev(badge), before, after, protectedModes:[] };
    report.editorOwnership.push(row);
    for (const title of ["Camera view","Fly camera"]) {
      const toggle = `document.querySelector('button[title^="${title}"]').click()`;
      await ev(toggle);
      await until(cdp,`!${D}.runtime.orbit.enabled && !!${D}.frame.camera.aim.forward`);
      const pose = await ev(D+".frame.camera");
      await wheel();
      assert.deepEqual(await ev(D+".frame.camera"),pose);
      row.protectedModes.push(title);
      await ev(toggle);
      await until(cdp,`${D}.runtime.orbit.enabled && !!${D}.frame.camera.aim.orbitTarget`);
    }
  }
}

try {
  for (const role of ["field","candidate"]) {
    await desktop({root,field,out,role,values:{},report,metrics:{width:1440,height:833},
      candidatePlugins: [{ name:"vp08-observe-submissions", transform(code,id) {
        if (id.endsWith("/src/main.tsx")) return "await window.observeNavigationDraws();\n"+code;
      }}],
      observeCandidate: cdp=>cdp.send("Page.addScriptToEvaluateOnNewDocument",{runImmediately:true,
        source:`(${observeContexts})(false,"document");window.observeNavigationDraws=${observeUpload};`}),
    }, cdp=>run(cdp,role));
  }
  await desktop({root,field,out,role:"editor",values:{},report,metrics:{width:1440,height:833}},editorOwnership);
  report.passed = true;
  console.log("Max landmark errors (physical px)",Object.fromEntries(Object.entries(report.landmarks).map(([k,v])=>[k,Math.max(...v.errors)])));
} finally {
  await writeFile(join(out,"results.json"),JSON.stringify(report,null,2)+"\n");
}
