import assert from "node:assert/strict";
import { CUBE_ID, TERRAIN_ID } from "./vp01/fixture.mjs";

function installClock() {
  const originalNow = performance.now.bind(performance);
  const originalTimer = window.setTimeout;
  const originalClear = window.clearTimeout;
  const tasks = new Map();
  let id = -1, now = originalNow()+1000, moving = false;
  performance.now = () => now;
  window.setTimeout = function(callback, delay, ...args) {
    if (!moving) return originalTimer.call(window,callback,delay,...args);
    tasks.set(--id,{due:now+delay,run:()=>callback(...args)});
    return id;
  };
  window.clearTimeout = key => { if (!tasks.delete(key)) originalClear(key); };
  window.hoverClock = {
    begin() { now+=1000; window.hoverSamples.length=0; return now; },
    get pending() { return tasks.size; },
    advance(ms) {
      now+=ms;
      for (const [key,task] of tasks) if (task.due<=now) {tasks.delete(key);task.run();}
    },
    pointer(type,[clientX,clientY]) {
      moving=true;
      try {document.elementFromPoint(clientX,clientY).dispatchEvent(new PointerEvent(type,
        {bubbles:type==="pointermove",clientX,clientY,buttons:0,pointerId:1,pointerType:"pen"}));}
      finally {moving=false;}
    },
    restore() {
      delete performance.now;
      window.setTimeout=originalTimer;
      window.clearTimeout=originalClear;
    },
  };
}

export async function checkTiming({cdp,ev,wait,raf,report,file,pixel,toggle}) {
  const D="forge3dViewportDiagnostics()", S=D+".terrainViewport.diagnosticSubmission";
  const readout='document.querySelector(".viewport-readout__cursor dd")?.textContent ?? null';
  report.timing={};
  const p=pixel, q=[p[0]+1,p[1]], last=[p[0]+2,p[1]];
  await ev(`(${installClock})()`);
  async function sequence(kind) {
    const start=await ev(`hoverClock.begin()`);
    await ev(`hoverClock.pointer("pointermove",${JSON.stringify(p)});hoverClock.advance(10);
      hoverClock.pointer("pointermove",${JSON.stringify(q)});hoverClock.advance(10)`);
    if (kind==="reentry") {
      await ev('document.querySelector(".viewport").dispatchEvent(new PointerEvent("pointerleave"))');
      assert.equal(await ev("hoverClock.pending"),0);
    }
    await ev(`hoverClock.pointer("${kind==="reentry"?"pointerenter":"pointermove"}",${JSON.stringify(last)})`);
    assert.equal(await ev("hoverClock.pending"),1,kind+" pending at 20ms");
    const before=await ev("hoverSamples.slice()");
    assert.equal(before.length,1);
    assert.equal(before[0].at,start); assert.deepEqual(before[0].client,p);
    const trailing = kind==="trailing" || kind==="sceneSync" || kind==="wheel" || kind==="resize" || kind==="reentry";
    let wheelSequence;
    if (kind==="wheel") {
      const previous=await ev(S+".sequence");
      await cdp.send("Input.dispatchMouseEvent",{type:"mouseWheel",x:last[0],y:last[1],deltaX:0,deltaY:30});
      await wait(S+".sequence > "+previous);
      wheelSequence=await ev(S+".sequence");
    } else if (kind==="resize") {
      await ev('document.querySelector(".viewport").style.height="727.25px"');
      await ev(raf);
      await ev('document.querySelector(".viewport").style.height="727.375px"');
      await ev(raf);
    } else if (kind==="sceneSync") {
      // A cube visibility change rebuilds the scene but leaves the sampled DEM intact.
      await toggle(CUBE_ID); await wait(`!${S}.visibleIds.includes("${CUBE_ID}")`);
    } else if (kind==="leave") {
      await ev('document.querySelector(".viewport").dispatchEvent(new PointerEvent("pointerleave"))');
    } else if (kind==="hide") {
      await toggle(TERRAIN_ID); await wait(`!${S}?.terrain`);
    } else if (kind==="project") {
      const gen=await ev(D+".frame.projectGeneration");
      await ev(`probe.path=${JSON.stringify(file)};[...document.querySelectorAll(".menu__button")].find(b=>b.textContent==="File").click()`);
      await ev('[...document.querySelectorAll(\'[role="menuitem"]\')].find(b=>b.textContent.includes("Open…")).click()');
      await wait(D+".frame.projectGeneration > "+gen);
    } else if (kind==="capture") {
      const handle=await ev('((r)=>[r.x+r.width/2,r.y+r.height/2])(document.querySelector(".world-x-grip").getBoundingClientRect())');
      await cdp.send("Input.dispatchMouseEvent",{type:"mousePressed",button:"left",buttons:1,x:handle[0],y:handle[1],clickCount:1});
      assert.equal(await ev('document.querySelector(".world-x-grip").hasPointerCapture(probe.pointer)'),true);
      await cdp.send("Input.dispatchMouseEvent",{type:"mouseMoved",buttons:1,x:handle[0]+8,y:handle[1]});
    }
    const pending=await ev("hoverClock.pending");
    assert.equal(pending,Number(trailing),kind+" pending before deadline");
    await ev("hoverClock.advance(39)"); assert.equal(await ev("hoverSamples.length"),1);
    await ev("hoverClock.advance(1)"); await ev(raf);
    if (kind==="capture") {
      await cdp.send("Input.dispatchMouseEvent",{type:"mouseMoved",buttons:1,x:p[0]+12,y:p[1]+4});
      await ev(raf);
    }
    const samples=await ev("hoverSamples.slice()"),text=await ev(readout);
    assert.deepEqual(samples.map(s=>s.at-start),trailing?[0,60]:[0],kind);
    if (trailing) {
      assert.deepEqual(samples[1].client,last);
      if (kind==="wheel") assert.equal(samples[1].submission.sequence,wheelSequence);
      if (kind==="resize") {
        assert.deepEqual(samples[0].layout,[794,727]);
        assert.deepEqual(samples[1].layout,[794,727.375]);
        assert.equal(samples[0].submission.sequence,samples[1].submission.sequence);
      }
      assert.equal(text,Math.round(samples[1].metres).toLocaleString("en-US")+" m");
    } else assert.ok(text==="—" || text===null,kind+" stale "+text);
    report.timing[kind]={start,moves:kind==="reentry"?[0,10]:[0,10,20],enter:kind==="reentry"?20:undefined,pending,samples,text};
    if (kind==="capture") {
      await cdp.send("Input.dispatchKeyEvent",{type:"keyDown",key:"Escape",code:"Escape",windowsVirtualKeyCode:27});
      await cdp.send("Input.dispatchMouseEvent",{type:"mouseReleased",button:"left",buttons:0,x:p[0],y:p[1]});
    }
  }
  try {
    await sequence("trailing"); await sequence("reentry"); await sequence("wheel"); await sequence("resize"); await sequence("sceneSync");
    await toggle(CUBE_ID); await wait(`${S}.visibleIds.includes("${CUBE_ID}")`);
    await sequence("leave"); await sequence("hide");
    await toggle(TERRAIN_ID); await wait(`!!${S}?.terrain`);
    await ev(`document.querySelector('button[title^="Move (G)"]').click();document.querySelector('button[title^="World-aligned"]').click()`);
    await wait(`!!${D}.terrainViewport.displayedCube(${D}.frame,"${CUBE_ID}") && document.querySelector(".world-x-grip").getBoundingClientRect().width>0`);
    await ev(raf); await sequence("capture");
    await sequence("project");
  } finally {await ev("hoverClock.restore()");}
}

export async function checkWheel(cdp,until,gpu) {
  const ev=expr=>cdp.evaluate(expr);
  const D="forge3dViewportDiagnostics()", dd='document.querySelector(".viewport-readout__cursor dd").textContent';
  await ev(`Object.assign(document.querySelector(".viewport").style,{boxSizing:"content-box",flex:"none",width:"794px",height:"727px"});
    ${D}.setOrbitPose([3,10,.001],[3,0,0]);
    window.wheelEvents=[];
    window.addEventListener("wheel",e=>wheelEvents.push({at:performance.now(),x:e.clientX,y:e.clientY,delta:e.deltaY,trusted:e.isTrusted}),true)`);
  await until(cdp,`Math.abs(${D}.frame.camera.eye[1]-10)<.001 && ${D}.frame.dimensions.height===727`);
  const x=910,y=439;
  const observe=()=>ev(`(async()=>{
    const d=${D}, s=d.terrainViewport.diagnosticSubmission;
    const result={eye:d.frame.camera.eye,text:${dd},at:performance.now(),
      moves:probe.trace.filter(e=>e.type==="pointermove").length,wheels:wheelEvents.slice(),
      backend:document.querySelector("[data-viewport-backend]").textContent,
      selections:probe.calls.filter(c=>c.cmd==="set_selection").length};
    if (${gpu}) {
      const r=document.querySelector(".viewport-canvas--terrain").getBoundingClientRect();
      const col=Math.floor((${x}-r.x)*s.width/r.width),row=Math.floor((${y}-r.y)*s.height/r.height);
      const pixels=await d.terrainViewport.diagnosticRuntime.readRgba();
      return {...result,pixel:[col,row],alpha:pixels[4*(row*s.width+col)+3],sequence:s.sequence,sample:hoverSamples.at(-1)};
    }
    return result;
  })()`);
  await cdp.send("Input.dispatchMouseEvent",{type:"mouseMoved",x,y,pointerType:"pen"});
  await until(cdp,dd+'==="10 m"');
  const before=await observe();
  async function zoom(delta,text) {
    await cdp.send("Input.dispatchMouseEvent",{type:"mouseWheel",x,y,deltaX:0,deltaY:delta});
    await until(cdp,dd+"==="+JSON.stringify(text));
    const after=await observe();
    assert.equal(after.moves,before.moves,"stationary pointer");
    assert.equal(after.selections,before.selections);
    assert.ok(after.wheels.at(-1).trusted);
    assert.equal(after.wheels.at(-1).delta,delta);
    return after;
  }
  const outside=await zoom(1200,"\u2014"), inside=await zoom(-1200,"10 m");
  assert.ok(outside.eye[1]>before.eye[1] && inside.eye[1]<outside.eye[1]);
  if (gpu) {
    assert.deepEqual([before.alpha,outside.alpha,inside.alpha],[255,0,255]);
    assert.ok(before.sequence<outside.sequence && outside.sequence<inside.sequence);
    for (const state of [before,outside,inside]) {
      assert.equal(state.sample.submission.sequence,state.sequence);
      assert.deepEqual(state.sample.client,[x,y]);
    }
    assert.equal(outside.sample.metres,null);
    assert.equal(Math.round(inside.sample.metres),10);
  }
  return {client:[x,y],before,outside,inside};
}
