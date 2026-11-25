import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import "./prepare-viewport-runtime.mjs";
import { createFixture, CUBE_ID, FIELD_REVISION, TERRAIN_ID, verifyProvenance } from "./vp01/fixture.mjs";
import { observeContexts } from "./vp01/startup.mjs";
import { desktop, fieldCheckout, until } from "./viewport-desktop.mjs";
import { instrument } from "./vp07-page.mjs";
import { fieldOracle } from "./vp10-field.mjs";

import { inputRegressions } from "./vp10-regressions.mjs";
import { recordField, measureControl, verifyLegacyTravel, clickTransformToolbar } from "./vp10-desktop-reference.mjs";

const sequencesOnly = process.argv.includes("--sequences");
const root = fileURLToPath(new URL("../",import.meta.url));
const out = await mkdtemp(join(tmpdir(),"studio-vp10-"));
console.log("VP-10 evidence",out);
process.env.PYTHONDONTWRITEBYTECODE = "1";
process.env.FORGE3D_STUDIO_PYTHON ??= execFileSync("python",["-c","import sys; print(sys.executable)"],{encoding:"utf8"}).trim();
const field = fieldCheckout(root), reference = await fieldOracle(field);
const {path} = await createFixture(join(out,"fixture"));
const fixture = JSON.parse(await readFile(path));
const object = p => p.scene.objects.find(o=>o.id===CUBE_ID);
const terrain = fixture.scene.objects.find(o=>o.id===TERRAIN_ID);
delete terrain.kind.overlay;
fixture.assets = fixture.assets.filter(a=>a.id===terrain.kind.asset);
fixture.selection = [CUBE_ID];
Object.assign(object(fixture).transform,{rotationDeg:{x:19,y:15,z:23},scale:{x:.8,y:1.35,z:.64}});
const eye = [9.5,7,11], aim = [0,.8,0];
const report = {suite:sequencesOnly?"consecutive gestures":"VP-10",base:execFileSync("git",["rev-parse","HEAD"],{cwd:root,encoding:"utf8"}).trim(),
  reference:FIELD_REVISION,runtime:(await verifyProvenance()).commit,
  fixture:{name:"relief-only Bryce",id:CUBE_ID,transform:object(fixture).transform,eye,aim,width:794,height:727,dpr:1},cases:[]};
const json = JSON.stringify;
const D = "forge3dViewportDiagnostics()", S = D+".terrainViewport.diagnosticSubmission";
const pose = D+'.terrainViewport.displayedCube('+D+'.frame,"'+CUBE_ID+'")';
const handles = 'document.querySelector(".transform-handles")';
const state = '__TAURI_INTERNALS__.invoke("project_state")';
const raf = "new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))";
const shape = t=>({translation:t.translation,rotationDeg:t.rotationDeg,scale:t.scale});

function orientationError(measured,reference) {
  assert.deepEqual(measured.map(g=>g.axis),reference.map(g=>g.axis));
  return Math.max(0,...measured.flatMap((g,i)=>g.pixels.map(([x,y],j)=>
    Math.hypot(x-reference[i].pixels[j][0],y-reference[i].pixels[j][1]))));
}

async function framebuffer(saveStart) {
  const {terrainViewport} = forge3dViewportDiagnostics();
  const pixels = await terrainViewport.diagnosticRuntime.readRgba();
  if (saveStart) probe.startPixels = pixels.slice();
  let changed = 0;
  for (let i=0;i<pixels.length;i+=4) {
    if (pixels[i]!==probe.startPixels[i] || pixels[i+1]!==probe.startPixels[i+1] ||
        pixels[i+2]!==probe.startPixels[i+2] || pixels[i+3]!==probe.startPixels[i+3]) changed++;
  }
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256",pixels));
  return {changed,sha256:Array.from(digest,b=>b.toString(16).padStart(2,"0")).join("")};
}

async function run(cdp) {
  const ev = expr=>cdp.evaluate(expr), wait = expr=>until(cdp,expr);
  const named = prefix=>ev(`[...document.querySelectorAll("button[title]")].find(b=>b.title.startsWith(${json(prefix)})).click()`);
  const fileMenu = async label=>{
    await ev('[...document.querySelectorAll(".menu__button")].find(b=>b.textContent==="File").click()');
    await ev(`[...document.querySelectorAll('[role="menuitem"]')].find(b=>b.textContent.includes(${json(label)})).click()`);
  };
  const input = (type,x,y)=>cdp.send("Input.dispatchMouseEvent",{type,x,y,button:"left",buttons:type==="mouseReleased"?0:1,clickCount:1});
  const frame = start=>ev(`(${framebuffer})(${start})`);
  const native = ()=>ev(state);
  const bounds = ()=>ev(pose+".bounds");
  const observed = (helpers=false)=>ev(`(rig=>(${measureControl})(rig.camera,rig.controls,${helpers}))(${D}.transformRig)`);
  async function open(file,visible=true) {
    const last = (await native())?.sessionId;
    const previousGeneration = await ev("window.forge3dViewportDiagnostics?.().frame.projectGeneration");
    await ev("probe.path="+json(file));
    await fileMenu("Open…");
    await wait(`(async()=>{const s=await ${state};return !!s && s.sessionId!==${last} && !!window.forge3dViewportDiagnostics && ${D}.frame.projectId===s.project.id})()`);
    await ev(`document.querySelector('.recovery button[aria-label="Dismiss"]')?.click();
      Object.assign(document.querySelector(".viewport").style,{boxSizing:"content-box",flex:"none",width:"794px",height:"727px"});
      ${D}.setOrbitPose(${json(eye)},${json(aim)})`);
    await wait(`${S}?.projectGeneration===${D}.frame.projectGeneration && ${S}?.projectGeneration!==${previousGeneration} && ${S}?.width===794 && ${S}.height===727 && devicePixelRatio===1 && !${D}.runtime &&
      ${S}.visibleIds.includes("${CUBE_ID}")===${visible} && ${S}.visibleIds.includes("${TERRAIN_ID}") &&
      document.querySelector("[data-viewport-backend]").textContent.includes("WebGPU available")`);
    await ev(raf);
  }
  async function select(tool,space) {
    await named({move:"Move (G)",rotate:"Rotate (R)",scale:"Scale (S)"}[tool]);
    await named(space==="world"?"World-aligned":"Object-aligned");
    await ev(raf);
  }
  const frameTransform = D+`.frame.objects.find(o=>o.id===${json(CUBE_ID)})`;
  async function waitPose(t) {
    const triples = Object.fromEntries(Object.entries(shape(t)).map(([k,v])=>[k,[v.x,v.y,v.z]]));
    await wait(`(o=>o && ["translation","rotationDeg","scale"].every(k=>JSON.stringify(o[k])===JSON.stringify(${json(triples)}[k])))(${frameTransform})`);
    await ev(raf);
  }
  await wait('!!document.querySelector(".menu__button")');
  await ev(`(${instrument})();localStorage.setItem("studio.viewport.mapGrid","0")`);
  for (const {mode,tool,space,axis,id,follow,chain,long} of cases) {
        const file=join(dirname(path),mode+".studio3d");
        const fieldCase=report.field[id];
        const row={id};
        report.cases.push(row);
        if (!follow) await open(file);
        if (long) { await clickTransformToolbar(cdp,tool,space); await ev(raf); }
        else await select(tool,space);
        await wait(handles+'.getClientRects().length && '+handles+'.childNodes.length');
        const start=await native(), before=object(start.project).transform;
        row.sessionId=start.sessionId;
        row.historyBefore=start.historyLen;
        assert.deepEqual(start.project.selection,[CUBE_ID],id+" Studio selection");
        if (follow) {
          const previous=report.cases.find(r=>r.id===follow);
          assert.equal(start.sessionId,previous.sessionId);
          assert.equal(start.historyLen,previous.historyAfter,id+" consecutive undo depth");
          assert.deepEqual(before,previous.transform);
        }
        const oracle=reference(before,tool,space,eye,aim);
        row.handleErrorPx=orientationError(await observed(),fieldCase.landmarks);
        assert.ok(row.handleErrorPx<.01,id+" projected handles "+row.handleErrorPx);
        const startingBounds=await bounds();
        row.before=await frame(true);
        const initial=await ev(S);
        const clip=await ev('document.querySelector(".viewport-canvas--terrain").getBoundingClientRect().toJSON()');
        if (id==="solid-scale-local-Z") await writeFile(join(out,"studio-scale-Z-start.png"),await cdp.screenshot(clip));
        const [px,py]=fieldCase.point;
        const x=clip.x+px,y=clip.y+py;
        await cdp.send("Input.dispatchMouseEvent",{type:"mouseMoved",x,y,buttons:0});
        assert.equal(await ev(D+".transformRig.controls.axis"),axis,id+" hover");
        const offset=await ev("probe.trace=[];probe.calls.length");
        await input("mousePressed",x,y);
        row.grip=await ev(handles+".dataset.axis");
        assert.equal(row.grip,axis,id+" acquired grip");
        assert.ok(await ev('document.querySelector(".world-x-grip").hasPointerCapture(probe.pointer)'));
        const moves=fieldCase.trace.filter(e=>e.type==="pointermove");
        for (const p of moves) { await input("mouseMoved",clip.x+p.x,clip.y+p.y); await ev(raf); }
        await wait(S+".sequence>"+initial.sequence);
        await ev(raf);
        const held=await native(), submission=await ev(S);
        row.preview=await frame(false);
        row.preview.sequence=submission.sequence;
        assert.ok(row.preview.changed>0,id+" cube pixels");
        assert.deepEqual(submission.camera,initial.camera,id+" camera");
        assert.deepEqual(held.project,start.project,id+" native project");
        assert.equal(held.historyLen,start.historyLen);
        assert.deepEqual(await ev("probe.calls.slice("+offset+")"),[]);
        row.held={camera:submission.camera,transform:object(held.project).transform,selection:held.project.selection,
          historyLen:held.historyLen,sequence:held.projectSequence,nativeCommandCount:0};
        row.bounds=await bounds();
        const heldHandles=await observed();
        row.guideErrorPx=orientationError(await observed(true),fieldCase.heldGuides);
        assert.ok(row.guideErrorPx<.01,id+" held helpers "+row.guideErrorPx);
        row.preview.file=id+"-held.png";
        await writeFile(join(out,row.preview.file),await cdp.screenshot({x:clip.x,y:clip.y,width:794,height:727}));
        const release=fieldCase.trace.at(-1);
        assert.equal(release.type,"pointerup");
        await input("mouseReleased",clip.x+release.x,clip.y+release.y);
        await wait(`(async()=>(await ${state}).historyLen===${start.historyLen+1})()`);
        row.trace=await ev("probe.trace");
        assert.ok(row.trace.every(e=>e.trusted),id+" trusted Studio input");
        const after=await native();
        row.historyAfter=after.historyLen;
        assert.equal(after.sessionId,start.sessionId);
        assert.deepEqual(after.project.selection,start.project.selection);
        const committed=object(after.project).transform;
        await waitPose(committed);
        row.transform=committed;
        const committedHandles=reference(committed,tool,space,eye,aim).landmarks;
        row.heldHandleErrorPx=orientationError(heldHandles,fieldCase.heldHandles);
        assert.ok(row.heldHandleErrorPx<.01,id+" held handle orientation");
        row.fieldMatrix=fieldCase.matrix;
        const coords=events=>events.filter(e=>["pointerdown","pointermove","pointerup"].includes(e.type)).map(e=>[e.type,e.x,e.y]);
        assert.deepEqual(coords(row.trace),coords(fieldCase.trace),id+" desktop coordinates");
        row.nativeMatrix=oracle.matrix(committed);
        row.matrixError=Math.max(...row.nativeMatrix.map((v,i)=>Math.abs(v-row.fieldMatrix[i])));
        assert.ok(row.matrixError<=1e-5,id+" matrix "+row.matrixError);
        assert.deepEqual(await bounds(),row.bounds);
        assert.deepEqual(await frame(false),{changed:row.preview.changed,sha256:row.preview.sha256});
        const calls=await ev("probe.calls.slice("+offset+")");
        assert.deepEqual(calls.map(c=>[c.cmd,c.args.command?.type]),[["apply_command","setTransform"]]);
        assert.equal(calls[0].args.expectedSequence,start.projectSequence);
        row.expectedSequence=calls[0].args.expectedSequence;
        if (chain) {
          row.commands=calls.map(c=>c.args.command.type);
          row.passed=true;
          console.log(id,row.matrixError,row.preview.changed);
          continue;
        }
        await named("Undo "); await waitPose(before);
        assert.deepEqual(await bounds(),startingBounds);
        assert.ok(orientationError(await observed(),oracle.landmarks)<.01);
        assert.deepEqual(object((await native()).project).transform,before);
        assert.deepEqual(await frame(false),row.before);
        await named("Redo "); await waitPose(committed);
        assert.deepEqual(await bounds(),row.bounds);
        assert.ok(orientationError(await observed(),committedHandles)<.01);
        assert.equal((await frame(false)).sha256,row.preview.sha256);
        const saved=join(dirname(path),id+"-saved.studio3d");
        await ev("probe.path="+json(saved)); await fileMenu("Save as…");
        await wait(`(async()=>(await ${state}).dirty===false)()`);
        assert.deepEqual(object(JSON.parse(await readFile(saved))).transform,committed);
        await open(saved); await waitPose(committed);
        const reopened=(await native()).project;
        assert.deepEqual(reopened.selection,[CUBE_ID]);
        assert.deepEqual(object(reopened).transform,committed);
        assert.equal((await frame(false)).sha256,row.preview.sha256);
        row.commands=await ev(`probe.calls.slice(${offset}).map(c=>c.args.command?.type??c.cmd)`);
        assert.deepEqual(row.commands,["setTransform","undo","redo","save_project","open_project"]);
        row.passed=true;
        console.log(id,row.matrixError,row.preview.changed);
  }

  if (sequencesOnly) return;
  fixture.viewport.mode="solid";
  const file=join(dirname(path),"solid.studio3d");
  await open(file);
  await select("move","local");
  const before=await observed(), beforeBounds=await bounds();
  await named("Object:");
  await ev(`{const el=[...document.querySelectorAll("label.field")].filter(e=>e.textContent.trim()==="Z")[1].querySelector("input"); el.focus();el.select()}`);
  await cdp.send("Input.insertText",{text:"42"});
  await ev("document.activeElement.blur()");
  await wait(frameTransform+".rotationDeg[2]===42"); await ev(raf);
  const changed=await observed(), afterBounds=await bounds();
  assert.notDeepEqual(before,changed);
  assert.notDeepEqual(beforeBounds,afterBounds);
  const edited=object((await native()).project).transform;
  report.inspector={beforeBounds,afterBounds,handleErrorPx:orientationError(changed,reference(edited,"move","local",eye,aim).landmarks)};
  assert.ok(report.inspector.handleErrorPx<.01);
  report.aborted=[];
  for (const reason of ["escape","space","tool","capture loss","zero"]) {
    await select("rotate","local");
    const start=await native(), initial=await frame(true);
    const control=reference(object(start.project).transform,"rotate","local",eye,aim);
    const [px,py]=control.point("Z");
    const rect=await ev('document.querySelector(".viewport-canvas--terrain").getBoundingClientRect().toJSON()');
    const x=rect.x+px, y=rect.y+py;
    const capture='document.querySelector(".world-x-grip").hasPointerCapture(probe.pointer)';
    const offset=await ev("probe.trace=[];probe.calls.length");
    await input("mousePressed",x,y);
    assert.equal(await ev(handles+".dataset.axis"),"Z");
    assert.ok(await ev(capture));
    const travel=reason==="zero"?0:18;
    if (travel) await input("mouseMoved",x+travel,y+3);
    await ev(raf);
    const held=await frame(false);
    assert.equal(held.changed>0,!!travel,reason);
    if (reason==="escape") {
      for (const type of ["keyDown","keyUp"]) await cdp.send("Input.dispatchKeyEvent",{type,key:"Escape",code:"Escape"});
    } else if (reason==="tool") await named("Scale (S)");
    else if (reason==="space") await named("World-aligned");
    else if (reason==="capture loss") {
      await ev('document.querySelector(".world-x-grip").releasePointerCapture(probe.pointer)');
      await input("mouseMoved",x+travel,y+3);
    }
    if (travel) await wait("!"+capture);
    await input("mouseReleased",x+travel,y+(travel?3:0));
    await ev(raf);
    assert.deepEqual(await frame(false),initial,reason);
    const end=await native();
    assert.deepEqual(end.project,start.project);
    assert.equal(end.historyLen,start.historyLen);
    const calls=await ev("probe.calls.slice("+offset+")");
    assert.deepEqual(calls,[]);
    report.aborted.push({reason,held,trace:await ev("probe.trace"),nativeCommandCount:calls.length});
  }
  await named("Select (V)");
  await wait("!"+handles+".getClientRects().length");
  report.excluded=["select"];
  for (const label of ["hidden","ancestor-hidden","locked","terrain","multi-selected"]) {
    const p=structuredClone(fixture);
    if (label==="hidden") object(p).visible=false;
    if (label==="ancestor-hidden") {
      const parent=p.scene.objects.find(o=>o.kind.type==="camera");
      parent.visible=false; object(p).parent=parent.id;
    }
    if (label==="locked") object(p).locked=true;
    if (label==="terrain") p.selection=[TERRAIN_ID];
    if (label==="multi-selected") p.selection.push(TERRAIN_ID);
    const source=join(dirname(path),label+".studio3d");
    await writeFile(source,json(p));
    await open(source,!label.includes("hidden")); await select("rotate","local");
    assert.equal(await ev(handles+".getClientRects().length"),0,label);
    report.excluded.push(label);
  }
  report.regressions=await inputRegressions({cdp,ev,wait,open,select,input,native,frame,raf,waitPose,fixture,directory:dirname(path),
    state,diagnostics:D,handles,offsetField:report.field["offset-XY"]});
  report.backend=await ev('document.querySelector("[data-viewport-backend]").textContent');
  report.contexts=await ev('__vp01Contexts.filter(c=>c.requested.includes("webgl"))');
  assert.ok(report.contexts.length && report.contexts.every(c=>c.result===null));
}

const cases=[];
for (const mode of ["solid","material"]) {
  await writeFile(join(dirname(path),mode+".studio3d"),json({...fixture,viewport:{...fixture.viewport,mode}}));
  for (const tool of ["move","rotate","scale"]) for (const space of (mode==="solid"?["world","local"]:["local"])) {
    const axes=mode==="material"?["X"]:tool==="rotate"?["X","Y","Z","E","XYZE"]:["X","Y","Z","XY","XZ","YZ","XYZ"];
    for(const axis of axes) cases.push({id:[mode,tool,space,axis].join("-"),mode,tool,space,axis});
  }
}
for (const [name,tool,space,axis,point] of [
  ["center","move","world","XYZ",[418,368]],
  ["switch","scale","local","Y",[370,305]],
]) {
  const first="sequence-"+name+"-first";
  cases.push({id:first,mode:"solid",tool:"move",space:"world",axis:"X",point:[455,381],chain:true},
    {id:"sequence-"+name+"-second",mode:"solid",tool,space,axis,point,follow:first});
}
if (sequencesOnly) cases.length=0;
// Each row continues from the previous native commit in the same open document.
// Offsets are per move. The optional release offset exercises a final event at a
// different position from the last pointermove, as can happen near mouse-up.
const sequences={
  solid:[
    ["move","world","X",4,-3],["scale","local","Y",-2,2],["rotate","world","Z",2,3],
    ["move","local","XY",-3,1],["move","local","XYZ",3,-2],["rotate","local","XYZE",-2,-2],
    ["scale","world","XZ",2,2],["move","world","YZ",-2,1],["rotate","world","E",3,2],
    ["scale","local","X",-2,2],["rotate","local","Y",2,-3],["move","world","Z",-3,2,[-8,7]],
  ],
  material:[
    ["rotate","local","Y",-2,3],["move","world","XZ",3,-2],["scale","world","XY",-2,2],
    ["scale","local","XYZ",2,-1],["move","local","Z",-2,-3],["rotate","world","X",2,3],
    ["rotate","local","E",-3,1],["scale","local","YZ",2,-2],["move","world","XYZ",-2,2],
    ["move","local","X",2,-1],["rotate","world","XYZE",2,2],["scale","world","Z",-2,2],
  ]
};
for (const [mode,steps] of Object.entries(sequences)) {
  let follow;
  for (const [i,[tool,space,axis,dx,dy,release]] of steps.entries()) {
    const id=[mode,"chain",i+1,tool,space,axis].join("-");
    cases.push({id,mode,tool,space,axis,travel:[dx,dy],release,follow,long:true,chain:i<steps.length-1});
    follow=id;
  }
}
const offset=structuredClone(fixture);
offset.viewport.mode="solid";
const offsetPose=object(offset).transform={translation:{x:10000,y:10000,z:10000},rotationDeg:{x:0,y:0,z:0},scale:{x:1,y:1,z:1}};
await writeFile(join(dirname(path),"offset.studio3d"),json(offset));
const fieldCases=sequencesOnly?cases:[...cases,{id:"offset-XY",mode:"offset",tool:"move",space:"world",axis:"XY",transform:offsetPose,
  eye:eye.map(v=>v+10000),aim:[10000,10000,10000]}];
try {
  await desktop({root,field,out,values:{},report,role:"field",metrics:{width:1440,height:833}},async cdp=>{
    report.field=await recordField(cdp,{directory:dirname(path),out,cases:fieldCases,reference,transform:object(fixture).transform,eye,aim});
    await writeFile(join(out,"field-results.json"),json(report.field));
  });
  await desktop({root,field,out,values:{},report,role:"candidate",metrics:{width:1440,height:833},observeCandidate:async cdp=>{
    const source=`(${observeContexts})(false,"document")`;
    await cdp.send("Page.addScriptToEvaluateOnNewDocument",{source}); await cdp.evaluate(source);
  }},run);
  if (!sequencesOnly) {
    const guide=report.field["solid-scale-local-Z"].heldGuides.find(g=>g.axis==="Z");
    report.guidePixels=JSON.parse(execFileSync(process.env.FORGE3D_STUDIO_PYTHON,
      [join(root,"scripts/vp10-guide-pixels.py"),out,json(guide.pixels)],{encoding:"utf8"}));
    const { runVp07 } = await import("./vp07.mjs");
    const legacy = await runVp07();
    report.vp07 = { directory:legacy.directory, passed:legacy.report.passed, regressions:legacy.report.regressions };
    await desktop({root,field,out:legacy.directory,values:{},report:report.vp07,role:"field",metrics:{width:1440,height:833}},async cdp=>{
      report.vp07.field=await verifyLegacyTravel(cdp,dirname(path),reference,legacy.report.modes["relief-solid"]);
    });
  }
  report.passed=true;
} finally {
  await writeFile(join(out,"results.json"),json(report,null,2)+"\n");
}
