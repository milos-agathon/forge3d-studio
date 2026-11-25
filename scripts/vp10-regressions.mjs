import assert from "node:assert/strict";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { CUBE_ID } from "./vp01/fixture.mjs";

export async function inputRegressions({cdp,ev,wait,open,select,input,native,frame,raf,waitPose,fixture,directory,
  state,diagnostics,handles,offsetField}) {
  const object=p=>p.scene.objects.find(o=>o.id===CUBE_ID);
  const report={pointer:[],keyboard:[]};
  const key=async (key,code,vk,modifiers=0)=>{
    for(const type of ["keyDown","keyUp"]) await cdp.send("Input.dispatchKeyEvent",{type,key,code,modifiers,windowsVirtualKeyCode:vk,
      ...(key==="Enter" && type==="keyDown"?{text:"\r"}:{})});
  };
  const pose=async()=>object((await native()).project).transform;
  for(const kind of ["miss","miss after valid move","miss then re-enter","equivalent rotation","offset XY"]) {
    const rotating=kind==="equivalent rotation", shifted=kind==="offset XY";
    const o=shifted?10000:0;
    const eye=(shifted?[9.5,7,11]:rotating?[0,0,10]:[3,2.5,9]).map(k=>k+o);
    const aim=[o,o,o],tool=rotating?"rotate":"move",axis=rotating?"X":shifted?"XY":"XZ";
    const p=structuredClone(fixture);
    object(p).transform={translation:{x:o,y:o,z:o},rotationDeg:{x:0,y:0,z:rotating?360:0},scale:{x:1,y:1,z:1}};
    const file=join(directory,kind+".studio3d");
    await writeFile(file,JSON.stringify(p));
    await open(file);
    await ev(`${diagnostics}.setOrbitPose(${JSON.stringify(eye)},${JSON.stringify(aim)})`);
    await select(tool,"world");
    const start=await native(), initial=await frame(true);
    const [px,py]=shifted?offsetField.point:rotating?[397,276]:[397,369];
    const r=await ev('document.querySelector(".viewport-canvas--terrain").getBoundingClientRect().toJSON()');
    const mouse=(type,point)=>input(type,r.x+point[0],r.y+point[1]);
    const count=await ev("probe.trace=[];probe.calls.length");
    await mouse("mousePressed",[px,py]);
    assert.equal(await ev(handles+".dataset.axis"),axis,kind);
    await ev(raf);
    if (kind==="miss after valid move") {
      await mouse("mouseMoved",[px+15,py+10]); await ev(raf);
      assert.ok((await frame(false)).changed>0);
    }
    let end=shifted?[px+18,py-12]:rotating?[px+8,py]:[397,0];
    await mouse("mouseMoved",end); await ev(raf);
    if (kind==="miss then re-enter") {
      assert.deepEqual(await frame(false),initial);
      end=[px+15,py+10]; await mouse("mouseMoved",end); await ev(raf);
    }
    const held=await frame(false);
    assert.deepEqual(await pose(),object(start.project).transform);
    assert.equal((await native()).historyLen,start.historyLen);
    await mouse("mouseReleased",end); await ev(raf);
    const changed=shifted || kind==="miss then re-enter";
    if (changed) await wait(`(async()=>(await ${state}).historyLen===${start.historyLen+1})()`);
    const after=await native(), actual=object(after.project).transform;
    assert.equal(after.historyLen-start.historyLen,+changed);
    if (kind!=="miss after valid move") assert.equal(held.changed>0,changed,kind);
    if (!changed) { assert.deepEqual(actual,object(start.project).transform); assert.deepEqual(await frame(false),initial); }
    if (shifted) assert.deepEqual(actual,offsetField.native,"offset plane at native float precision");
    const commands=await ev(`probe.calls.slice(${count}).map(c=>c.args.command?.type??c.cmd)`);
    assert.deepEqual(commands,changed?["setTransform"]:[]);
    report.pointer.push({kind,axis,held,actual,commands,trace:await ev("probe.trace")});
  }

  for(const tool of ["move","rotate","scale"]) for(const space of ["world","local"]) {
    await open(join(directory,"solid.studio3d")); await select(tool,space);
    const selector='.transform-keyboard button, .world-x-grip';
    const expected=tool==="rotate"?["X","Y","Z","E","XYZE"]:["X","Y","Z","XY","XZ","YZ","XYZ"];
    await ev('document.querySelector(\'button[title="Select (V)"]\').focus()');
    const names=[];
    for(let i=0;i<expected.length;i++) {
      await key("Tab","Tab",9,8);
      const axis=await ev(`document.activeElement.matches(${JSON.stringify(selector)}) && (document.activeElement.dataset.grip??"X")`);
      assert.ok(axis,tool+" "+space+" tab "+i); names.push(axis);
      const original=await pose(),start=await native(),off=await ev("probe.calls.length");
      const plane=axis.length===2, enter=axis==="E";
      if (enter) await key("Enter","Enter",13);
      else await key(plane?"ArrowUp":"ArrowRight",plane?"ArrowUp":"ArrowRight",plane?38:39);
      await wait(`(async()=>(await ${state}).historyLen===${start.historyLen+1})()`);
      const edited=await pose();
      assert.notDeepEqual(edited,original);
      const part=tool==="scale"?"scale":tool==="move"?"translation":"rotationDeg";
      for (const name of ["translation","rotationDeg","scale"].filter(n=>n!==part)) assert.deepEqual(edited[name],original[name]);
      if(tool==="scale") for(const k of ["x","y","z"]) {
        const changes=axis==="XYZ" || k===(plane?axis[1]:axis).toLowerCase();
        assert.ok(Math.abs(edited.scale[k]-original.scale[k]*(changes?1.01:1))<1e-5);
      }
      const commands=await ev(`probe.calls.slice(${off}).map(c=>c.args.command?.type??c.cmd)`);
      assert.deepEqual(commands,["setTransform"]);
      await key("z","KeyZ",90,2);
      await waitPose(original);
      assert.deepEqual(await pose(),original);
      report.keyboard.push({tool,space,axis,original,edited,commands});
    }
    assert.deepEqual(names.sort(),expected.sort());
  }
  const parented=structuredClone(fixture);
  const parent=parented.scene.objects.find(o=>o.kind.type==="camera");
  parent.transform={translation:{x:0,y:0,z:0},rotationDeg:{x:.34*180/Math.PI,y:.52*180/Math.PI,z:.70*180/Math.PI},scale:{x:2,y:3,z:6}};
  const child=object(parented);
  child.parent=parent.id;
  child.transform={translation:{x:0,y:0,z:0},rotationDeg:{x:25,y:35,z:40},scale:{x:.8,y:1.35,z:.64}};
  const parentFile=join(directory,"parent-planes.studio3d");
  await writeFile(parentFile,JSON.stringify(parented));
  for (const [axis,x,y] of [["XY",394,330],["XZ",424,343],["X",415,330]]) {
    await open(parentFile);
    await ev(diagnostics+".setOrbitPose([9.5,7,11],[0,0,0])"); await select("move","local");
    const start=await native(), off=await ev("probe.trace=[];probe.calls.length");
    const rc=await ev('document.querySelector(".viewport-canvas--terrain").getBoundingClientRect().toJSON()');
    await frame(true);
    await input("mousePressed",rc.x+x,rc.y+y);
    assert.equal(await ev(handles+".dataset.axis"),axis);
    for (const step of [1,2,3]) {await input("mouseMoved",rc.x+x+step*6,rc.y+y-step*4); await ev(raf);}
    const held=await frame(false);
    assert.ok(held.changed>0,"parent Local "+axis+" preview");
    assert.deepEqual((await native()).project,start.project);
    await input("mouseReleased",rc.x+x+18,rc.y+y-12);
    await wait(`(async()=>(await ${state}).historyLen===${start.historyLen+1})()`);
    const actual=await pose();
    const commands=await ev(`probe.calls.slice(${off}).map(c=>c.args.command?.type??c.cmd)`);
    assert.deepEqual(commands,["setTransform"]);
    // Transform the stored parent-local displacement back to world space and
    // measure leakage normal to the two displayed axes of the captured grip.
    const leakage=await ev(`(rig=>{
      const q=rig.object.getWorldQuaternion(rig.object.quaternion.clone());
      const vector=(x,y,z)=>rig.object.position.clone().set(x,y,z);
      const v=k=>vector(+(k==="X"),+(k==="Y"),+(k==="Z")).applyQuaternion(q);
      const delta=vector(...${JSON.stringify(["x","y","z"].map(k=>actual.translation[k]))}).applyMatrix4(rig.object.parent.matrix).normalize();
      const axis=${JSON.stringify(axis)};
      return axis.length===1?delta.cross(v(axis).normalize()).length():Math.abs(delta.dot(v(axis[0]).cross(v(axis[1])).normalize()));
    })(${diagnostics}.transformRig)`);
    assert.ok(leakage<1e-5,"parent "+axis+" leakage "+leakage);
    report.pointer.push({kind:"rotated nonuniform parent",axis,held,actual,leakage,commands,trace:await ev("probe.trace")});
    await key("z","KeyZ",90,2); await waitPose(child.transform);
  }

  const repeated=structuredClone(fixture);
  object(repeated).transform={translation:{x:0,y:0,z:0},rotationDeg:{x:0,y:0,z:0},scale:{x:1,y:1,z:1}};
  const keyboardFile=join(directory,"repeated-key.studio3d");
  await writeFile(keyboardFile,JSON.stringify(repeated));
  await open(keyboardFile);
  await ev(diagnostics+".setOrbitPose([7,1.9,7],[0,0,0])"); await select("move","local");
  const visible=()=>ev('[...document.querySelectorAll(".transform-keyboard button")].map(b=>b.dataset.grip)');
  const beforeAxes=await visible(),start=await native();
  assert.ok(!beforeAxes.includes("XZ"));
  await ev(`window.focusedGrip=document.querySelector('.transform-keyboard [data-grip="Y"]');focusedGrip.focus()`);
  const off=await ev("probe.calls.length");
  for (let n=1;n<=3;n++) {
    await key("ArrowLeft","ArrowLeft",37);
    await wait(`(async()=>(await ${state}).historyLen===${start.historyLen+n})()`);
    await ev(raf);
    assert.equal(await ev("document.activeElement===focusedGrip"),true,"Local Y focus after nudge "+n);
  }
  const afterAxes=await visible(),edited=await pose();
  assert.ok(afterAxes.includes("XZ")); assert.ok(Math.abs(edited.translation.y+.3)<1e-6);
  const commands=await ev(`probe.calls.slice(${off}).map(c=>c.args.command?.type??c.cmd)`);
  assert.deepEqual(commands,Array(3).fill("setTransform"));
  for(let n=0;n<3;n++) {await key("z","KeyZ",90,2);await ev(raf);}
  await waitPose(object(repeated).transform);
  report.repeatedKeyboard={axis:"Y",beforeAxes,afterAxes,edited,commands,focusRetained:true};
  return report;
}
