import assert from "node:assert/strict";
import { join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { openFixture } from "./vp08-fixture.mjs";
import { until } from "./viewport-desktop.mjs";
import { CUBE_ID } from "./vp01/fixture.mjs";
import { instrument } from "./vp07-page.mjs";

// Measure geometry from both the ordinary grips and Field’s held helper group.
export function measureControl(camera, controls, helpers) {
  const gizmo=controls.getHelper().children.find(c=>c.isTransformControlsGizmo);
  const group=(helpers?gizmo.helper:gizmo.gizmo)[controls.mode];
  return group.children.filter(c=>c.visible).map(mesh=>{
    const pos=mesh.geometry.attributes.position;
    const vertex=i=>mesh.position.clone().fromBufferAttribute(pos,i).applyMatrix4(mesh.matrixWorld);
    let points=[0,Math.floor(pos.count/3),pos.count-1].map(vertex);
    if(helpers && ["AXIS","X","Y","Z"].includes(mesh.name)) {
      // The million-unit guide endpoints can project behind the camera. Sample
      // the same line on each side of its anchor, inside the displayed view.
      const pivot=mesh.position.clone().setFromMatrixPosition(mesh.matrixWorld);
      const direction=vertex(pos.count-1).sub(vertex(0)).normalize();
      const extent=camera.position.distanceTo(pivot)*.1;
      points=[pivot.clone().addScaledVector(direction,-extent),pivot,pivot.clone().addScaledVector(direction,extent)];
    }
    const pixels=points.map(point=>{
      const p=point.project(camera);
      return [(p.x+1)*397,(1-p.y)*363.5];
    });
    return {axis:mesh.name,pixels};
  });
}

// Use the real toolbar. Leaving active buttons alone preserves hover history.
export async function clickTransformToolbar(cdp, tool, space) {
  for (const title of [{move:"Move (G)",rotate:"Rotate (R)",scale:"Scale (S)"}[tool],
    space==="world"?"World-aligned axes":"Object-aligned axes"]) {
    const point=await cdp.evaluate(`(() => {
      const b=[...document.querySelectorAll("button[title]")].find(b=>b.title===${JSON.stringify(title)});
      if (b.classList.contains("is-active")) return null;
      const r=b.getBoundingClientRect();
      return {x:r.left+r.width/2,y:r.top+r.height/2};
    })()`);
    if (!point) continue;
    await cdp.send("Input.dispatchMouseEvent",{type:"mouseMoved",...point,buttons:0});
    for (const [type,buttons] of [["mousePressed",1],["mouseReleased",0]]) {
      await cdp.send("Input.dispatchMouseEvent",{type,...point,button:"left",buttons,clickCount:1});
    }
    await cdp.evaluate("new Promise(r=>requestAnimationFrame(r))");
  }
}

export async function recordField(cdp,{directory,out=directory,cases,reference,eye:defaultEye,aim:defaultAim}) {
  const ev=expr=>cdp.evaluate(expr), wait=expr=>until(cdp,expr);
  const raf=()=>ev("new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))");
  const named=prefix=>ev(`[...document.querySelectorAll("button[title]")].find(b=>b.title.startsWith(${JSON.stringify(prefix)})).click()`);
  const data={};
  for (const {id,mode,tool,space,axis,eye=defaultEye,aim=defaultAim,trace,point:fixed,follow,travel,release,long} of cases) {
    let fixtureRetries=0;
    if (!follow) {
      const openReadyFixture=async()=>{
        await openFixture(cdp,join(directory,mode+".studio3d"));
        await wait('window.__vp01FieldDiagnostics?.().runtime.renderer.domElement.height===727 && [...__vp01FieldDiagnostics().runtime.objects.values()].some(g=>g.children.some(c=>c.userData.elevation))');
      };
      try { await openReadyFixture(); }
      catch (error) {
        if (!error.message.startsWith("Timed out waiting for ")) throw error;
        // A cold WebView can miss its first terrain load. Retry only setup,
        // before any gesture in this document. Consecutive drags never reopen.
        console.warn(id+" Field fixture load timed out; retrying once.");
        fixtureRetries++;
        await openReadyFixture();
      }
      await ev(`window.rig=__vp01FieldDiagnostics().runtime;rig.camera.position.fromArray(${JSON.stringify(eye)});
        rig.orbit.target.fromArray(${JSON.stringify(aim)});rig.orbit.update();rig.needsRender=true;(${instrument})();`);
      await ev(`window.fieldTrace=[];for(const type of ["pointerdown","pointermove","pointerup"])window.addEventListener(type,e=>{
        const r=rig.renderer.domElement.getBoundingClientRect();fieldTrace.push({type,x:e.clientX-r.left,y:e.clientY-r.top,trusted:e.isTrusted});
      },true)`);
    }
    if (long) await clickTransformToolbar(cdp,tool,space);
    else {
      await named({move:"Move (G)",rotate:"Rotate (R)",scale:"Scale (S)"}[tool]);
      await named(space==="world"?"World-aligned":"Object-aligned");
    }
    await raf();
    const rect=await ev("rig.renderer.domElement.getBoundingClientRect().toJSON()");
    assert.equal(rect.width,794); assert.equal(rect.height,727);
    const before=await ev('__TAURI_INTERNALS__.invoke("project_state")');
    const start=before.project.scene.objects.find(o=>o.id===CUBE_ID).transform;
    if (follow) {
      assert.equal(before.sessionId,data[follow].sessionId);
      assert.deepEqual(start,data[follow].native);
    }
    const geometry=reference(start,tool,space,eye,aim);
    const press=trace?.find(e=>e.type==="pointerdown");
    const point=press?[press.x,press.y]:fixed??geometry.point(axis);
    const moves=trace?trace.filter(e=>e.type==="pointermove").map(e=>[e.x-point[0],e.y-point[1]])
      : [1,2,3].map(k=>(travel??[6,-4]).map(v=>v*k));
    const camera=()=>ev("([rig.camera.matrixWorld.elements,rig.camera.projectionMatrix.elements,rig.orbit.target.toArray()])");
    const startCamera=await camera();
    const measure=helpers=>ev(`(${measureControl})(rig.camera,rig.gizmo,${helpers})`);
    const landmarks=await measure(false);
    const input=(type,dx,dy,buttons)=>cdp.send("Input.dispatchMouseEvent",{type,buttons,x:rect.x+point[0]+dx,y:rect.y+point[1]+dy,
      ...(type==="mouseMoved"?{}:{button:"left",clickCount:1})});
    const guide=id==="solid-scale-local-Z";
    const screenshot=async phase=>writeFile(join(out,"field-scale-Z-"+phase+".png"),await cdp.screenshot(rect));
    if (guide) await screenshot("start");
    await input("mouseMoved",0,0,0); await raf();
    assert.equal(await ev("rig.gizmo.axis"),axis,id+" Field hover");
    await ev("fieldTrace.length=0;probe.calls.length=0");
    await input("mousePressed",0,0,1); await raf();
    assert.equal(await ev("rig.gizmo.dragging && rig.gizmo.axis"),axis,id+" Field acquisition");
    for(const [dx,dy] of moves) { await input("mouseMoved",dx,dy,1); await raf(); }
    if (guide) await screenshot("held");
    const heldGuides=await measure(true);
    const heldHandles=await measure(false);
    assert.deepEqual(await camera(),startCamera);
    assert.deepEqual(before.project.selection,[CUBE_ID],id+" Field selection");
    await input("mouseReleased",...(release??moves.at(-1)),0);
    await wait(`(async()=>(await __TAURI_INTERNALS__.invoke("project_state")).historyLen===${before.historyLen+1})()`);
    const after=await ev('__TAURI_INTERNALS__.invoke("project_state")');
    assert.deepEqual(after.project.selection,before.project.selection);
    const native=after.project.scene.objects.find(o=>o.id===CUBE_ID).transform;
    const commands=await ev("probe.calls.map(c=>c.args.command?.type??c.cmd)");
    assert.deepEqual(commands,["setTransform"]);
    data[id]={fixtureRetries,sessionId:before.sessionId,point,landmarks,heldHandles,heldGuides,native,matrix:geometry.matrix(native),camera:startCamera,commands,
      trace:await ev("fieldTrace"),backend:await ev("rig.renderer.getContext().constructor.name")};
    assert.ok(data[id].trace.every(e=>e.trusted));
    console.log("Field",id);
  }
  return data;
}

// VP-07 recorded travel with the former single-axis plane. Recheck its
// nine-move trace in Field itself when validating ordered edits and precision.
export async function verifyLegacyTravel(cdp, directory, reference, lane) {
  const fixture=JSON.parse(await readFile(join(directory,"solid.studio3d")));
  fixture.scene.objects.find(o=>o.id===CUBE_ID).transform=lane.before;
  await writeFile(join(directory,"vp07-solid.studio3d"),JSON.stringify(fixture));
  const trace=lane.gestures[0].trace;
  const cases=[{id:"vp07",mode:"vp07-solid",tool:"move",space:"world",axis:"X",trace}];
  const {vp07}=await recordField(cdp,{directory,cases,reference,transform:lane.before,eye:[9.5,7,11],aim:[0,.8,0]});
  const coordinates=events=>events.filter(e=>["pointerdown","pointermove","pointerup"].includes(e.type)).map(e=>[e.type,e.x,e.y]);
  assert.deepEqual(coordinates(vp07.trace),coordinates(trace));
  assert.ok(Math.abs(vp07.native.translation.x-lane.after.translation.x)<=1e-5);
  return vp07;
}
