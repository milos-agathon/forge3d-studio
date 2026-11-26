import assert from "node:assert/strict";
import { until } from "./viewport-desktop.mjs";

export async function checkSidebar(cdp,gpu) {
  const ev=expr=>cdp.evaluate(expr);
  const wait=expr=>until(cdp,expr);
  const point=[1253,529], [x,y]=point;
  const readout='document.querySelector(".viewport-readout__cursor dd").textContent';
  const closed='document.querySelector(".workspace").classList.contains("workspace--no-props")';
  const view="forge3dViewportDiagnostics()";
  async function toggle() {
    const key={key:"n",code:"KeyN",windowsVirtualKeyCode:78};
    await cdp.send("Input.dispatchKeyEvent",{type:"keyDown",...key});
    await cdp.send("Input.dispatchKeyEvent",{type:"keyUp",...key});
  }

  await cdp.send("Emulation.setDeviceMetricsOverride",{width:1440,height:900,deviceScaleFactor:1,mobile:false});
  await ev(`{
    const v=document.querySelector(".viewport");
    for (const property of ["flex","width","height","box-sizing"]) v.style.removeProperty(property);
    ${view}.setOrbitPose([0,5,0],[0,0,0]);
    window.sidebarEvents=[];
    const log=e=>sidebarEvents.push({type:e.type,device:e.pointerType,client:[e.clientX,e.clientY],trusted:e.isTrusted,at:performance.now()});
    for (const type of ["pointerenter","pointerleave"]) v.addEventListener(type,log);
    document.addEventListener("pointermove",log,true);
  }`);
  if (!await ev(closed)) await toggle();
  const wide=`${view}.frame.dimensions.width===1146`;
  await wait(closed+" && "+wide);

  const results={};
  for (const pointerType of ["mouse","pen"]) {
    // A real move establishes the input device. Only the keyboard changes the layout after this.
    await cdp.send("Input.dispatchMouseEvent",{type:"mouseMoved",x:x-3,y,pointerType});
    await cdp.send("Input.dispatchMouseEvent",{type:"mouseMoved",x,y,pointerType});
    await wait(`sidebarEvents.at(-1)?.device==="${pointerType}" && sidebarEvents.at(-1).client[0]===${x} && ${readout}==="10 m"`);
    const input=await ev('sidebarEvents.filter(e=>e.type==="pointermove").at(-1)');
    assert.ok(input.trusted);
    assert.equal(input.device,pointerType);
    assert.deepEqual(input.client,point);
    const offset=await ev("sidebarEvents.length");
    const snapshot=()=>ev(`(async()=>{
      const d=${view}, s=d.terrainViewport.diagnosticSubmission;
      const state={text:${readout},at:performance.now(),target:document.elementFromPoint(${x},${y}).className,
        backend:document.querySelector("[data-viewport-backend]").textContent,events:sidebarEvents.slice(${offset}),
        selections:probe.calls.filter(c=>c.cmd==="set_selection").length};
      if (${gpu}) {
        state.sample=hoverSamples.at(-1);
        state.sequence=s.sequence;
        const r=document.querySelector(".viewport-canvas--terrain").getBoundingClientRect();
        const col=Math.floor((${x}-r.left)*s.width/r.width), row=Math.floor((${y}-r.top)*s.height/r.height);
        if (col>=0 && col<s.width && row>=0 && row<s.height) {
          const rgba=await d.terrainViewport.diagnosticRuntime.readRgba();
          state.pixel=[col,row]; state.alpha=rgba[4*(row*s.width+col)+3];
        }
      }
      return state;
    })()`);
    const before=await snapshot();
    await toggle();
    await wait(`!${closed} && ${readout}==="\u2014" && sidebarEvents.slice(${offset}).some(e=>e.type==="pointerleave")`);
    const covered=await snapshot();
    await toggle();
    await wait(`${closed} && ${wide} && ${readout}==="10 m" && sidebarEvents.slice(${offset}).some(e=>e.type==="pointerenter")`);
    if (gpu) await wait("hoverSamples.at(-1).submission.sequence==="+view+".terrainViewport.diagnosticSubmission.sequence");
    const restored=await snapshot();
    assert.deepEqual(restored.events.map(e=>e.type),["pointerleave","pointerenter"]);
    for (const event of restored.events) { assert.ok(event.trusted); assert.deepEqual(event.client,point); }
    assert.equal(restored.selections,before.selections);
    if (gpu) {
      assert.deepEqual([before.alpha,covered.alpha,restored.alpha],[255,undefined,255]);
      assert.deepEqual(restored.sample.client,point);
      assert.equal(Math.round(restored.sample.metres),10);
    }
    results[pointerType]={input,before,covered,restored};
  }
  return results;
}
