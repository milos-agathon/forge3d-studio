import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const xyz = (x=0,y=0,z=0) => ({x,y,z});
const equalVec = (a,b) => a.every((v,i)=>Math.abs(v-b[i])<1e-5);

// The strip crosses a horizontal world-space stroke, clear of the bulb and the other spokes.
export async function lightStrokes({pairedFixture,pose,sampleFrame,setExposure,toggle,click,native,rgba}, mode) {
  const point = [462,290];
  const strip = Array.from({length:31*11}, (_,i) => [point[0]-15+i%31, point[1]-5+Math.floor(i/31)]);
  const center = (strip.length-1)/2;
  const measurements = [];
  const warm = [.75,.25,.125];
  // The dark control's unexposed sRGB equals the Solid background.
  const dark = [.004391442037410293,.005605391624202723,.006512090792594475];
  const dim = mode==="solid" ? dark : [.0018,0,0];
  for (const [kind,color,exposures] of [["directional",warm,[.5,8]],["point",warm,[.5,8]],["point",dim,[8]]]) {
    await pairedFixture(mode+"-stroke-"+kind+"-"+exposures[0], project => {
      const light = project.scene.objects.find(o => o.kind.type==="light");
      const camera = project.scene.objects.find(o => o.kind.type==="camera");
      camera.visible = false;
      light.name = "ProbeLight";
      light.transform.translation = xyz(0,.25,0);
      light.transform.rotationDeg = xyz(0,kind==="directional" ? -90 : 0,0);
      Object.assign(light.kind,{kind,color,intensity:1});
      project.scene.objects = [camera,light];
      project.viewport.mode = mode;
      project.render.exposure = exposures[0];
      project.render.shadows = false;
    });
    await pose([0,0,3]);
    const id = (await native()).scene.objects.find(o => o.kind.type==="light").id;
    await toggle(false);
    const hidden = await sampleFrame(strip);
    await toggle(true);
    let previous;
    for (const exposure of exposures) {
      if (previous) await setExposure(exposure);
      const shown = await sampleFrame([...strip,[405,282]]);
      const bulb = shown.pop().slice(0,3);
      const on = shown[center].slice(0,3), off = hidden[center].slice(0,3);
      const contrast = shown.map((pixel,i) => Math.max(...pixel.slice(0,3).map((c,k) => Math.abs(c-hidden[i][k]))));
      const changed = contrast.filter(delta => delta>0).length, maxDiff = Math.max(...contrast);
      assert.ok(changed>0 && maxDiff>1,"Invisible "+kind+" at exposure "+exposure);
      // WebGPU analytically antialiases a line. Field fully covers the centre
      // sample with its GL line. Compare both against their actual coverage.
      const alpha = rgba ? (await rgba(point))[3]/255 : kind==="point" ? .6 : .75;
      assert.ok(alpha>0);
      const expected = bulb.map((c,k) => Math.round(alpha*c+(1-alpha)*off[k]));
      assert.ok(on.every((c,k) => Math.abs(c-expected[k])<=2),
        "Stroke "+kind+" exposure "+exposure+" RGB "+on+" expected "+expected+" at alpha "+alpha);
      if (previous) assert.ok(on.every((c,k) => c>previous[k]),"Exposure edit did not brighten "+kind);
      await click(point);
      assert.deepEqual((await native()).selection,[id],"Visible stroke should select its light");
      await click([30,90]);
      measurements.push({id,kind,color,exposure,point,on,off,bulb,alpha,changed,maxDiff,pixels:strip.length});
      previous = on;
    }
  }
  return measurements;
}

export async function cameraStrokes({pairedFixture,pose,sampleFrame,setExposure,select,click,native,rgba},mode) {
  const frustum = [462,209], edge = [462,151], amber = [239,160,38];
  const samples = [];
  for (const backing of ["sky","mesh","occluded"]) {
    await pairedFixture(mode+"-camera-"+backing, project => {
      const camera = project.scene.objects.find(o => o.kind.type==="camera");
      const probe = structuredClone(camera);
      probe.id = randomUUID();
      probe.name = "ProbeCamera";
      probe.kind.fovDeg = 45;
      probe.transform.translation = xyz(0,.25,0);
      probe.transform.rotationDeg = xyz();
      camera.visible = false;
      const cube = project.scene.objects.find(o => o.kind.source?.primitive?.type==="cube");
      project.scene.objects = [camera,probe];
      if (backing!=="sky") {
        cube.transform.translation = xyz(0,0,backing==="mesh" ? -3 : 1.5);
        cube.transform.scale = xyz(8,8,.5);
        project.scene.objects.push(cube);
      }
      project.viewport.mode = mode;
      project.render.exposure = .5;
      project.render.shadows = false;
    });
    await pose([0,0,3]);
    const id = (await native()).scene.objects.find(o=>o.name==="ProbeCamera").id;
    for (const exposure of [.5,8]) {
      if (exposure===8) await setExposure(exposure);
      await select("Camera"); // The hidden source camera has no decoration at either sample.
      const [stroke,background] = await sampleFrame([frustum,edge]);
      const strokeAlpha = backing==="sky" ? (rgba ? (await rgba(frustum))[3]/255 : .75) : undefined;
      let undecoratedHit;
      if (backing==="sky") {
        // Field's Three line raycaster has a world-space tolerance. Compare
        // the identical click with and without the decoration in each engine.
        await click(edge);
        undecoratedHit = (await native()).selection;
        if (rgba) assert.deepEqual(undecoratedHit,[],"Studio hit empty sky without a box");
      }
      await select("ProbeCamera");
      const [selected] = await sampleFrame([edge]);
      if (backing==="occluded") {
        assert.deepEqual(selected,background,"Camera bounds showed through a foreground mesh");
        await click(frustum);
        const project = await native();
        const foreground = project.scene.objects.find(o=>o.kind.type==="mesh").id;
        assert.deepEqual(project.selection,[foreground],"Foreground mesh should own the hidden frustum pixel");
        samples.push({backing,exposure,id,stroke,background,selected,hit:foreground});
      } else {
        const alpha = backing==="sky" ? (rgba ? (await rgba(edge))[3]/255 : .75) : samples[0].alpha;
        assert.ok(alpha>0);
        const expected = amber.map((c,k)=>Math.round(alpha*c+(1-alpha)*background[k]));
        assert.ok(expected.every((c,k)=>Math.abs(c-selected[k])<=2),
          mode+" "+backing+" bounds at exposure "+exposure+" RGB "+selected+" expected "+expected);
        if (backing==="sky") {
          await click(edge);
          assert.deepEqual((await native()).selection,undecoratedHit,"Selection box changed the underlying pick");
          await click(frustum);
          assert.deepEqual((await native()).selection,[id],"Visible camera stroke missed");
          if (exposure===8) assert.ok(stroke.slice(0,3).every((c,i)=>c>samples[0].stroke[i]+20),
            mode+" camera stroke ignored exposure");
        }
        samples.push({backing,exposure,id,stroke,background,selected,alpha,strokeAlpha,undecoratedHit});
      }
    }
  }
  return samples;
}

export async function edgeCases({fixture,pose,ev,wait,click,rgba,button,native,ids,D,S,cdp,pixel}) {
  const report={};
  const setVisible=(p,...ids)=>{for(const o of p.scene.objects)o.visible=ids.includes(o.id)};
  const find=(p,id)=>p.scene.objects.find(o=>o.id===id);
  const project=await native();
  const camera=project.scene.objects.find(o=>o.kind.type==="camera");
  const sun=project.scene.objects.find(o=>o.kind.type==="light");
  await fixture("near-ray",p=>{
    setVisible(p,sun.id);
    const t=find(p,sun.id).transform;
    t.translation=xyz(0,0,-.03);t.rotationDeg=xyz(0,-6.4830736928972374,0);t.scale=xyz(1,1,1.1070794747774566);
  });
  await pose([0,0,0],[0,0,-1]);
  report.nearRay=[];
  for(const pt of [[477,362],[438,362]]) {
    await click([30,90]);
    const color=await rgba(pt);assert.ok(color[3]);
    await click(pt);assert.deepEqual((await native()).selection,[sun.id]);
    assert.equal(await ev(D+".lastPick.hit.id"),sun.id);
    report.nearRay.push({pt,color,id:sun.id});
  }

  await fixture("fallback-parent-camera",p=>{
    p.scene.activeCamera=null;p.selection=[camera.id];
    setVisible(p,camera.id,ids.Cube,ids.CameraCopy);
    const c=find(p,camera.id), parent=find(p,ids.Cube),other=find(p,ids.CameraCopy);
    parent.transform.translation=xyz(5,0,0);parent.transform.rotationDeg=xyz(0,90,0);
    c.parent=parent.id;c.transform.translation=xyz(0,0,3);c.transform.rotationDeg=xyz();
    other.transform.translation=xyz(3,0,0);other.transform.rotationDeg=xyz(0,90,0);
  });
  await button("Camera view");
  await wait(`!${S}.visibleIds.includes("${camera.id}") && !${S}.selectionBoxes.includes("${camera.id}")`);
  const view=await ev(D+".frame.camera");assert.ok(equalVec(view.eye,[8,0,0]));
  assert.ok(equalVec(view.aim.forward,[-1,0,0]));
  assert.ok((await ev(S+".visibleIds")).includes(ids.CameraCopy));
  await click([142,144]);assert.notEqual(await ev(D+".lastPick.hit?.id"),camera.id);
  report.fallbackCamera={id:camera.id,eye:view.eye,forward:view.aim.forward};

  await fixture("camera-capture",p=>{
    p.scene.activeCamera=null;
    const c=find(p,camera.id),parent=find(p,ids.Cube);
    parent.transform.translation=xyz(5);parent.transform.rotationDeg=xyz(10,36,-12);parent.transform.scale=xyz(2,3,-1);
    c.parent=parent.id;c.transform.scale=xyz(1,-2,1);
  });
  await pose([0,0,6]);
  await cdp.send("Input.dispatchKeyEvent",{type:"keyDown",key:"End",code:"End",windowsVirtualKeyCode:35});
  await cdp.send("Input.dispatchKeyEvent",{type:"keyUp",key:"End",code:"End",windowsVirtualKeyCode:35});
  await wait(`!${S}.visibleIds.includes("${camera.id}") && !!${D}.frame.camera.aim.forward`);
  const captured=await ev(D+".frame.camera");
  assert.ok(equalVec(captured.eye,[0,0,6]) && equalVec(captured.aim.forward,[0,0,-1]) && equalVec(captured.up,[0,1,0]));
  report.cameraCapture={eye:captured.eye,forward:captured.aim.forward,up:captured.up,local:find(await native(),camera.id).transform};

  await fixture("light-parent",p=>{
    const a=find(p,sun.id),b=find(p,ids.LightCopy),parent=find(p,ids.Cube);
    a.parent=parent.id;a.transform.rotationDeg=xyz();a.kind.color=[1,0,0];b.kind.color=[0,0,1];
    parent.transform.rotationDeg=xyz(0,90);parent.transform.translation=xyz();
  });
  const lighting=()=>ev(D+".frame.settings.sun");
  const before=await lighting();assert.ok(equalVec(before.direction,[-1,0,0]));assert.deepEqual(before.color,[1,0,0]);
  await ev(`document.querySelector('[data-object-id="${ids.Cube}"] button.tree-action').click()`);
  await wait(`!${S}.visibleIds.includes("${sun.id}")`);
  const after=await lighting();assert.deepEqual(after.color,[0,0,1]);report.lightHierarchy={before,after};

  report.bulbs=[];
  for(const color of [[0,0,0],[.75,.25,.125]]) {
    let base;
    for(const intensity of [0,1,4]) {
      await fixture("bulb-"+color[0]+"-"+intensity,p=>{
        setVisible(p,sun.id,ids.Cube);
        find(p,ids.Cube).transform.translation=xyz(9);
        const bulb=find(p,sun.id);bulb.transform.translation=xyz();bulb.kind.color=color;
        bulb.transform.rotationDeg=xyz();p.viewport.mode="material";p.render.iblIntensity=intensity;
      });
      await pose([0,0,2]);
      await wait(`${D}.terrainViewport.diagnosticAppearance?.skyIntensity===${intensity}`);
      const sample=await rgba([397,363]);
      assert.equal(sample[3],255);
      if(color[0]===0) assert.deepEqual(sample,[0,0,0,255]);
      else assert.ok(sample[0]>sample[1] && sample[1]>sample[2]);
      base??=sample;assert.deepEqual(sample,base);
      report.bulbs.push({color,intensity,sample});
    }
  }

  report.crowds=[];
  for(const count of [255,256,257]) {
    await fixture("crowd-"+count,p=>{
      const cube=find(p,ids.Cube);
      p.scene.objects=[camera,...Array.from({length:count},(_,i)=>{
        const o=structuredClone(cube);o.id=i?randomUUID():cube.id;o.name="Cube "+i;
        o.transform.translation=xyz(i?500+i*3:0);return o;
      })];p.scene.objects[0].visible=false;
    });
    await pose([0,0,5]);
    await wait(S+".objects.length==="+count);
    await ev(`{const runtime=${D}.terrainViewport.diagnosticRuntime;
      window.vp12Reads={readObjectMask:0,readPixelDepth:0};
      for(const name of Object.keys(vp12Reads)) {
        const read=runtime[name].bind(runtime);
        runtime[name]=(...args)=>{vp12Reads[name]++;return read(...args)};
      }}`);
    const samples=[];
    for(const pt of [[392,363],[397,363]]) {
      await click([30,90]);await click(pt);
      assert.deepEqual((await native()).selection,[ids.Cube]);
      samples.push({pt,id:await ev(D+".lastPick.hit.id")});
    }
    const slots=await ev(S+".materialSlots");assert.equal(slots,2);
    const reads=await ev("vp12Reads");
    assert.ok(reads.readObjectMask && reads.readPixelDepth, "centre diagonal must take the raster depth path");
    report.crowds.push({count,slots,samples,reads});
  }
  report.distinct=[];
  for(const count of [256,257]) {
    const samples=[];
    const grid=[];
    await fixture("distinct-"+count,p=>{
      p.viewport.mode="material";p.render.shadows=false;
      const cube=find(p,ids.Cube);
      p.scene.objects=Array.from({length:count},(_,i)=>{
        const o=structuredClone(cube);o.id=randomUUID();o.name="Tile "+i;
        o.transform.translation=xyz((i%17-8)*.22,(Math.floor(i/17)-7)*.22);
        o.transform.scale=xyz(.09,.09,.09);
        o.kind.material.baseColor=[i/(count-1),1-i/(count-1),.125];
        if (count>256) {
          o.kind.material.roughness=.4+.4*i/(count-1);
          o.kind.material.metallic=.15*i/(count-1);
        }
        grid.push(o.id);return o;
      });
      p.scene.objects.unshift({...structuredClone(camera),visible:false});
    });
    await pose([0,0,6]);
    for(const i of [0,128,count-1]) {
      const pt=await pixel(grid[i]);
      const color=await rgba(pt);assert.equal(color[3],255);
      if(i===0) assert.ok(color[1]>color[0]);
      if(i===count-1) assert.ok(color[0]>color[1]);
      await click(pt);assert.deepEqual((await native()).selection,[grid[i]]);
      samples.push({i,pt,color,id:grid[i]});
    }
    const draw=await ev(`(s=>({surfaces:s.surfaceCount,batches:s.scatterBatches,slots:s.materialSlots}))(${S})`);
    assert.equal(draw.surfaces,count);
    assert.equal(draw.batches,count===256?256:1);
    report.distinct.push({count,samples,...draw});
  }
  return report;
}

export async function mixedHierarchy({ev,wait,fixture,pose,button,tree,pixel,mouse,rect,cdp,ids,D,S,raf}) {
  await fixture("mixed-parent",p=>{
    p.render.shadows=false;
    const parent=p.scene.objects.find(o=>o.id===ids.Cube),child=p.scene.objects.find(o=>o.id===ids.Sphere);
    parent.transform.translation=xyz();child.transform.translation=xyz(3);child.parent=parent.id;
  });
  await pose([0,3,12]);await tree(ids.Cube);await button("Move (G)");await button("World-aligned");
  await wait(`${D}.runtime?.gizmo.object?.userData.studioId==="${ids.Cube}" && ${S}.visibleIds.includes("${ids.Sphere}")`);
  const positions=()=>ev(`(d=>[${JSON.stringify(ids.Cube)},${JSON.stringify(ids.Sphere)}].map(id=>{
    const group=d.runtime.objects.get(id);group.updateWorldMatrix(true,false);
    return {editor:group.matrixWorld.elements.slice(12,15),gpu:d.terrainViewport.displayedObject(d.frame,id).center};
  }))(${D})`);
  const before=await positions(),r=await rect(),p=await pixel(ids.Cube);
  const y=r.y+p[1]+.5;let x;
  for(let dx=12;dx<95;dx+=3) {
    x=r.x+p[0]+dx+.5;
    await cdp.send("Input.dispatchMouseEvent",{type:"mouseMoved",x,y,buttons:0});
    if(await ev(D+".runtime.gizmo.axis")==="X")break;
  }
  assert.equal(await ev(D+".runtime.gizmo.axis"),"X");
  await mouse("mousePressed",x,y);await mouse("mouseMoved",x+35,y);await ev(raf);
  const held=await positions();
  assert.ok(held[0].gpu[0]-before[0].gpu[0]>.01);
  for(const key of ["editor","gpu"])
    assert.ok(Math.abs(held[1][key][0]-before[1][key][0]-(held[0].gpu[0]-before[0].gpu[0]))<1e-6);
  const settled = async (translation, previousSequence) => {
    const cube = JSON.stringify(ids.Cube);
    await wait(`(async()=>Math.abs((await __TAURI_INTERNALS__.invoke("project_state")).project.scene.objects
      .find(o=>o.id===${cube}).transform.translation.x - (${translation})) < 1e-5)()`);
    await wait(`(d=>d.terrainViewport.diagnosticSubmission?.sequence > ${previousSequence} &&
      Math.abs(d.frame.objects.find(o=>o.id===${cube}).translation[0] - (${translation})) < 1e-5 &&
      !!d.terrainViewport.displayedObject(d.frame,${cube}))(${D})`);
  };
  const heldSequence = await ev(S+".sequence");
  await mouse("mouseReleased",x+35,y);
  await settled(held[0].editor[0],heldSequence);
  const after=await positions();
  assert.ok(equalVec(after[1].gpu,held[1].gpu));
  const committedSequence = await ev(S+".sequence");
  await button("Undo ");
  await settled(before[0].editor[0],committedSequence);
  const undone=await positions();assert.deepEqual(undone,before);
  const history = [];
  for (const [action,expected] of [["Redo ",after],["Undo ",before],["Redo ",after],["Undo ",before]]) {
    const sequence = await ev(S+".sequence");
    await button(action);
    await settled(expected[0].editor[0],sequence);
    const displayed = await positions();
    assert.deepEqual(displayed,expected);
    history.push({action:action.trim(),displayed});
  }
  return {before,held,after,undone,history};
}
