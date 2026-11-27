import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { decodePng } from "../node_modules/@forge3d/web/dist/png-decode.js";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import "./prepare-viewport-runtime.mjs";
import { verifyProvenance } from "./vp01/fixture.mjs";
import { observeContexts } from "./vp01/startup.mjs";
import { sha256 } from "./vp03/identity.mjs";
import { desktop, fieldCheckout, until } from "./viewport-desktop.mjs";
import { edgeCases, mixedHierarchy, lightStrokes, cameraStrokes } from "./vp12-cases.mjs";
import { instrument } from "./vp07-page.mjs";

const root = fileURLToPath(new URL("../",import.meta.url)), field = fieldCheckout(root);
const out = await mkdtemp(join(tmpdir(),"studio-vp12-")), saved = join(out,"objects.studio3d");
console.log("VP-12 evidence",out);
const seed = JSON.parse(await readFile(join(root,"samples/cube-animation.studio3d")));
seed.scene.objects = seed.scene.objects.filter(o => o.kind.type !== "mesh");
seed.timeline.tracks = [];
seed.selection = [];
seed.viewport.mode = "solid";
seed.viewport.gridVisible = false;
assert.equal(seed.render.shadows,true);
const [camera,light] = seed.scene.objects;
camera.transform.translation = {x:-3,y:2,z:3};
camera.transform.rotationDeg = {x:0,y:0,z:0};
light.transform.translation = {x:2,y:2,z:0};
light.transform.rotationDeg = {x:0,y:40,z:0};
const start = join(out,"start.studio3d");
await writeFile(start,JSON.stringify(seed));
const J = JSON.stringify, D = "forge3dViewportDiagnostics()", S = D+".terrainViewport.diagnosticSubmission";
const raf = "new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))";
const state = '__TAURI_INTERNALS__.invoke("project_state")';
const report = {base:execFileSync("git",["rev-parse","HEAD"],{cwd:root,encoding:"utf8"}).trim(),
  field:execFileSync("git",["rev-parse","HEAD"],{cwd:field,encoding:"utf8"}).trim(),
  runtime:(await verifyProvenance()).commit, contexts:[], inventory:[], planes:[]};
const sourceFiles = ["src/viewport/Viewport3D.tsx","src/viewport/viewportState.ts","src/viewport/viewportPicking.ts",
  "src/viewport/forge3dWebViewport.ts","src/viewport/forge3dWebMapping.ts","src/viewport/viewportGeometry.ts",
  "src/viewport/viewportObjects.ts","src/viewport/materialHelpers.ts","src/viewport/materialHelpers.wgsl",
  "src/viewport/lighting.ts","src/viewport/transformRig.ts","scripts/vp12.mjs","scripts/vp12-cases.mjs"];
report.sourceSha256 = Object.fromEntries(await Promise.all(sourceFiles.map(async name=>[name,sha256(await readFile(join(root,name)))])));
let scene, ids = {};
async function observe(cdp) {
  await cdp.send("Runtime.enable");
  await cdp.send("Runtime.addBinding",{name:"__vp01RecordContext"});
  cdp.on("Runtime.bindingCalled",({name,payload})=>{
    if (name==="__vp01RecordContext") report.contexts.push(JSON.parse(payload));
  });
  const source="("+observeContexts+')(false,"document")';
  await cdp.send("Page.addScriptToEvaluateOnNewDocument",{source}); await cdp.evaluate(source);
}

async function session(cdp, role) {
  const isField=role==="field";
  const ev = s=>cdp.evaluate(s), wait = s=>until(cdp,s);
  const button = prefix=>ev(`document.querySelector('button[title^="${prefix}"]').click()`);
  const tree = id=>ev(`document.querySelector('[data-object-id="${id}"] .tree-name').click()`);
  const native = async()=> (await ev(state)).project;
  const pickRow = id=>isField
    ? wait(`[...document.querySelectorAll('[aria-selected=true] .tree-name')].some(el=>el.textContent===${J(scene.scene.objects.find(o=>o.id===id).name)})`)
    : wait(`document.querySelector('[data-object-id="${id}"]').getAttribute("aria-selected")==="true"`);
  const canvas = isField ? "__vp01FieldDiagnostics().runtime.renderer.domElement" : 'document.querySelector(".viewport-canvas--terrain")';
  async function open(path) {
    const error=await ev(`localStorage.setItem("studio.viewport.mapGrid","0");
      __TAURI_INTERNALS__.invoke("open_project",{path:${J(path)}}).then(()=>null,e=>JSON.stringify(e))`);
    assert.equal(error,null,"Opening "+path+" failed: "+error);
    await ev("window.vp12Leaving=true");
    await cdp.send("Page.reload",{ignoreCache:true});
    await wait("!window.vp12Leaving && "+(isField?"!!window.__vp01FieldDiagnostics?.().runtime":"!!window.forge3dViewportDiagnostics?.().terrainViewport.diagnosticSubmission"));
    await ev(`document.querySelector('.recovery button[aria-label="Dismiss"]')?.click();
      Object.assign(document.querySelector(".viewport").style,{boxSizing:"content-box",flex:"none",width:"794px",height:"727px"});(${instrument})();`);
    await wait(canvas+".width===794 && "+canvas+".height===727 && devicePixelRatio===1");
    await button("Select (V)");
    await ev(raf);
  }
  const pose = async (eye,target=[0,0,0])=>{
    if (isField) await ev(`{const r=__vp01FieldDiagnostics().runtime;r.camera.position.fromArray(${J(eye)});r.orbit.target.fromArray(${J(target)});r.orbit.update();r.needsRender=true}`);
    else await ev(`${D}.setOrbitPose(${J(eye)},${J(target)})`);
    await ev(raf);
  };
  const rect = ()=>ev(canvas+".getBoundingClientRect().toJSON()");
  const mouse = (type,x,y,modifiers=0)=>cdp.send("Input.dispatchMouseEvent",{type,x,y,button:"left",buttons:type==="mouseReleased"?0:1,clickCount:1,modifiers});
  const click = async ([x,y],modifiers=0)=>{
    const count=await ev("probe.calls.filter(c=>c.cmd==='set_selection').length");
    const r=await rect();
    for (const t of ["mousePressed","mouseReleased"]) await mouse(t,r.x+x+.5,r.y+y+.5,modifiers);
    if (!isField) await wait("probe.calls.filter(c=>c.cmd==='set_selection').length>"+count);
    await ev(raf);
  };
  const pixel = async (id,local=[0,0,0])=> ev(isField
    ? `(r=>{const p=r.objects.get("${id}").localToWorld(r.camera.position.clone().fromArray(${J(local)})).project(r.camera);
      return [Math.floor((1+p.x)*397),Math.floor((1-p.y)*363.5)]})(__vp01FieldDiagnostics().runtime)`
    : `(d=>{const o=d.terrainViewport.displayedObject(d.frame,"${id}"),p=d.terrainViewport.diagnosticSubmission.placement;
      const m=o.world.elements,v=${J(local)},w=[0,1,2].map(i=>(m[12+i]+m[i]*v[0]+m[i+4]*v[1]+m[i+8]*v[2]-p.translation[i])/p.scale);
      const s=o.camera.worldToScreen(w,o);return [Math.floor(s.x),Math.floor(s.y)]})(${D})`);
  async function rgba(point) {
    return ev(`(async()=>{const r=${D}.terrainViewport.diagnosticRuntime, b=await r.readRgba(), i=4*(${point[1]}*r.width+${point[0]});return Array.from(b.slice(i,i+4))})()`);
  }
  async function pick(id,local) {
    const [cx,cy]=await pixel(id,local);
    for (const [dx,dy] of [[0,0],[-1,0],[1,0],[0,-1],[0,1]]) {
      const p=[cx+dx,cy+dy];
      if (!isField && !(await rgba(p))[3]) continue;
      await click(p);
      const n=await native();
      if (n.selection.length===1 && n.selection[0]===id && (isField || await ev(D+".lastPick?.hit?.id")===id)) {
        await pickRow(id); return p;
      }
    }
    throw Error("No visible pick for "+id+" at "+[cx,cy]);
  }
  async function edit(id,label,value) {
    await tree(id); await pickRow(id);
    await button("Object:");
    const axis = ["X","Y","Z"].includes(label) ? label.toLowerCase() : undefined;
    const bounds = S+".objects.find(o=>o.id==="+J(id)+").bounds";
    const before = axis && await ev(bounds);
    const original = axis && (await native()).scene.objects.find(o=>o.id===id).transform.translation[axis];
    const input=`[...document.querySelectorAll("label.field")].find(e=>e.textContent.trim()===${J(label)})?.querySelector("input")`;
    await wait("!!("+input+")");
    await ev(`{const el=${input};el.focus();el.select()}`);
    await cdp.send("Input.insertText",{text:String(value)}); await ev("document.activeElement.blur()"); await ev(raf);
    if (axis) {
      const delta = value - original;
      await wait(`${S}.selectionBoxes.includes(${J(id)}) && Math.abs(${bounds}.min.${axis} - (${before.min[axis]+delta})) < 1e-6`);
      const after = await ev(bounds);
      assert.ok(Math.abs(after.max[axis] - before.max[axis] - delta) < 1e-6);
      (report.inspectorBounds ??= []).push({id,axis,delta,before,after});
    }
  }
  async function fixture(label,modify) {
    const project=structuredClone(scene);project.selection=[];modify(project);
    const path=join(out,label+".studio3d");await writeFile(path,J(project));await open(path);
  }
  if (role==="editor") {
    report.mixedHierarchy=await mixedHierarchy({ev,wait,fixture,pose,button,tree,pixel,mouse,rect,cdp,ids,D,S,raf});
    return;
  }
  await open(isField?saved:start);
  if (!isField) {
    assert.equal(await ev(D+".runtime"),null);
    await pose([0,5,14]);
    let count=2;
    for (const [name,x] of [["Cube",-3],["Sphere",0],["Plane",3]]) {
      await button("Add object");
      await ev(`[...document.querySelectorAll(".add-menu__dropdown button")].find(b=>b.textContent==="${name}").click()`);
      await wait(S+".objects.length==="+(++count));
      const o=(await native()).scene.objects.find(o=>o.kind.source?.primitive.type===name.toLowerCase());
      ids[name]=o.id;
      assert.ok((await ev(S+".objects")).find(r=>r.id===o.id).triangles>0);
      if (x) await edit(o.id,"X",x);
      if (name==="Cube") await edit(o.id,"B",.03);
    }
    for (const [name,o,x] of [["Camera",camera,0],["Light",light,4]]) {
      await tree(o.id); await pickRow(o.id); await button("Duplicate (");
      await wait(S+".objects.length==="+(++count));
      const n=await native(), duplicate=n.scene.objects.filter(v=>v.kind.type===o.kind.type && v.id!==o.id)[0];
      ids[name+"Copy"]=duplicate.id;
      assert.ok((await ev(S+".objects")).find(r=>r.id===duplicate.id).segments>0);
      await edit(duplicate.id,"X",x);
      if(name==="Camera") await edit(duplicate.id,"Z",-4);
    }
    await click([30,90]);
    await wait(`(async()=>(await ${state}).project.selection.length===0)()`);
    await ev(`__TAURI_INTERNALS__.invoke("save_project",{path:${J(saved)}})`);
    scene=JSON.parse(await readFile(saved));
    report.projectSha256=sha256(await readFile(saved));
  } else {
    assert.equal(sha256(await readFile(saved)),report.projectSha256);
    assert.deepEqual((await native()).scene.objects.map(o=>o.id),scene.scene.objects.map(o=>o.id));
    assert.equal(await ev("__vp01FieldDiagnostics().runtime.renderer.getContext().constructor.name"),"WebGL2RenderingContext");
  }

  for (const [side,y] of [["above",6],["below",-6]]) {
    const eye=[0,y,13]; await pose(eye);
    const cameraPose=await ev(isField?'(r=>[r.camera.position.toArray(),r.orbit.target.toArray(),r.camera.fov])(__vp01FieldDiagnostics().runtime)':`[${D}.frame.camera.eye,${D}.frame.camera.aim.orbitTarget,${D}.frame.camera.fovYDegrees]`);
    assert.ok(cameraPose[0].every((v,i)=>Math.abs(v-eye[i])<1e-6) && cameraPose[1].every(v=>Math.abs(v)<1e-6) && cameraPose[2]===45);
    await click([30,90]); await ev(raf);
    const role=isField?"field":"studio", file=role+"-"+side+".png";
    const r=await rect();
    const capture=()=>cdp.screenshot({x:r.x,y:r.y,width:r.width,height:r.height});
    const image=await capture(), atCenter=await pixel(ids.Plane);
    await writeFile(join(out,file),image);
    const sample=png=>{const frame=decodePng(png),i=4*(atCenter[1]*frame.width+atCenter[0]);return Array.from(frame.data.slice(i,i+4));};
    const toggle=()=>ev('[...document.querySelectorAll(".tree-name")].find(el=>el.textContent==="Plane").closest(".tree-row").querySelector("button.tree-action").click()');
    await toggle();await ev(raf);
    const hidden=sample(await capture()),shown=sample(image);
    assert.notDeepEqual(shown,hidden,"Visible plane pixels "+role+" "+side);
    await toggle();await ev(raf);
    const at=await pick(ids.Plane);
    report.planes.push({role,side,eye,width:794,height:727,dpr:1,file,pixel:at,shown,hidden,id:ids.Plane});
  }
  const checkOrder=async()=>{
    if(isField) await open(join(out,"coplanar.studio3d"));
    else await fixture("coplanar",p=>{
      const cube=p.scene.objects.find(o=>o.id===ids.Cube);
      p.viewport.mode="material";p.render.shadows=false;
      p.scene.objects=Array.from({length:256},(_,i)=>{
        const o=structuredClone(cube);o.id=i===2?ids.Cube:crypto.randomUUID();o.name="Tile "+i;
        o.transform.translation={x:i===1||i===2?0:500+i*3,y:0,z:0};
        o.kind.material.baseColor=i%2?[.03,.8,.04]:[.8,.03,.04];o.visible=i!==255;
        return o;
      });
      p.scene.objects.unshift({...structuredClone(camera),visible:false});
    });
    await pose([0,0,6]);
    const pt=[401,359],samples=[];
    for(const visible of [false,true,false]) {
      if(samples.length) {
        await ev('[...document.querySelectorAll(".tree-name")].find(el=>el.textContent==="Tile 255").closest(".tree-row").querySelector("button.tree-action").click()');
        await ev(raf);
        if(!isField) await wait(S+".objects.length==="+(visible?256:255));
      }
      if(!isField) await click([30,90]);
      const r=await rect(),frame=decodePng(await cdp.screenshot({x:r.x,y:r.y,width:r.width,height:r.height}));
      const i=4*(pt[1]*frame.width+pt[0]),color=Array.from(frame.data.slice(i,i+4));
      assert.ok(color[0]>color[1]);if(samples.length)assert.deepEqual(color,samples[0].color);
      if(!isField){await click(pt);assert.deepEqual((await native()).selection,[ids.Cube]);}
      samples.push({visible,color,hit:isField?undefined:ids.Cube});
    }
    (report.coplanar??={})[role]=samples;
  };
  async function checkAuthoredColour() {
    const sampleFrame=async points=>{
      // Capture the same displayed viewport in both desktop implementations.
      const r=await rect(),image=decodePng(await cdp.screenshot({x:r.x,y:r.y,width:r.width,height:r.height}));
      return points.map(([x,y])=>Array.from(image.data.slice(4*(y*image.width+x),4*(y*image.width+x)+4)));
    };
    const pairedFixture=async(label,modify)=>{
      if(isField) await open(join(out,label+".studio3d"));
      else await fixture(label,modify);
    };
    const helperControls = {
      pairedFixture,pose,sampleFrame,click,native,rgba:isField ? undefined : rgba,
      select:async name => {
        await ev('[...document.querySelectorAll(".tree-name")].find(el=>el.textContent==='+J(name)+').click()');
        await wait('(async()=>{const p=(await '+state+').project;return p.selection.includes(p.scene.objects.find(o=>o.name==='+J(name)+').id)})()');
        await ev(raf);
      },
      toggle:async visible => {
        await ev('[...document.querySelectorAll(".tree-name")].find(el=>el.textContent==="ProbeLight").closest(".tree-row").querySelector("button.tree-action").click()');
        await wait('(async()=>(await '+state+').project.scene.objects.find(o=>o.name==="ProbeLight").visible==='+visible+')()');
        await ev(raf);
      },
      setExposure:async exposure => {
        await button("Render:");
        const input = '[...document.querySelectorAll("label.field")].find(el=>el.textContent.trim()==="Exposure").querySelector("input")';
        await ev('{const el='+input+';el.focus();el.select()}');
        await cdp.send("Input.insertText",{text:String(exposure)});
        await ev("document.activeElement.blur()");
        await wait((isField ? "__vp01FieldDiagnostics().runtime.renderer.toneMappingExposure" : D+".frame.settings.exposure")+"==="+exposure);
        await ev(raf);
      },
    };
    for (const mode of ["solid","material"]) {
      const strokes = await lightStrokes(helperControls,mode);
      const property = mode+"LightStrokes";
      (report[property]??={})[role]=strokes;
      if (isField) {
        const studio=report[property].candidate;
        assert.deepEqual(studio.map(s=>[s.id,s.exposure,s.bulb,s.off]),strokes.map(s=>[s.id,s.exposure,s.bulb,s.off]));
      }
      const cameras = (report.cameraStrokes??={})[mode]??={};
      cameras[role] = await cameraStrokes(helperControls,mode);
      if (isField) for (const [i,field] of cameras.field.entries()) {
        if (field.backing!=="sky") continue;
        const studio = cameras.candidate[i];
        for (let k=0;k<3;k++) {
          const source = (field.stroke[k]-(1-field.strokeAlpha)*field.background[k])/field.strokeAlpha;
          const expected = studio.strokeAlpha*source+(1-studio.strokeAlpha)*studio.background[k];
          assert.ok(Math.abs(studio.stroke[k]-expected)<=2,mode+" camera colour at exposure "+field.exposure);
        }
      }
    }
    const swatches=[[0,0,0],[.0018,.0018,.0018],[.003,.0008,.0018],[.007,.007,.007],
      [.1,.2,.5],[.02,.03,.04],[1,1,1],[.35,.55,.75],[.7,.2,.01]];
    await pairedFixture("threshold-colours",p=>{
      const cube=p.scene.objects.find(o=>o.id===ids.Cube);
      p.viewport.mode="material";p.render.shadows=false;p.render.exposure=8;p.render.iblIntensity=4;
      p.scene.objects=[{...structuredClone(camera),visible:false},...Array.from({length:257},(_,i)=>{
        const o=structuredClone(cube);o.name="Tile "+i;o.id=crypto.randomUUID();o.visible=i!==256;
        o.transform.translation={x:(i%17-8)*.22,y:(Math.floor(i/17)-7)*.22,z:0};
        o.transform.scale={x:.09,y:.09,z:.09};
        const m=o.kind.material;m.baseColor=swatches[i-120]??[i/256,1-i/256,.125];
        m.roughness=swatches[i-120] ? (i===128?.12:.6) : .4+.4*i/256;
        m.metallic=swatches[i-120] ? (i<124?1:i===124?0:.26) : .15*i/256;
        return o;
      })];
    });
    await pose([0,0,6]);
    const waitForLighting=()=>wait(isField
      ? "__vp01FieldDiagnostics().runtime.renderer.toneMappingExposure===8 && __vp01FieldDiagnostics().runtime.scene.environmentIntensity===4"
      : D+".terrainViewport.diagnosticAppearance?.skyIntensity===4");
    await waitForLighting();
    const grid=(await native()).scene.objects;
    const points=await Promise.all(swatches.map((_,i)=>pixel(grid[121+i].id)));
    if(!isField) await ev(`(async()=>{
      const api=await import(new URL("forge3d-web/index.js",document.baseURI).href);
      const proto=api.Forge3DRuntime.prototype,set=proto.setMaterials;
      proto.setMaterials=function(snapshot) {
        window.vp12GreyMaterials=snapshot;return set.call(this,snapshot);
      };
      window.vp12RestoreMaterialHook=()=>{proto.setMaterials=set};
    })()`);
    const samples=[];
    for(const count of [256,257,256]) {
      if(samples.length) {
        await ev('[...document.querySelectorAll(".tree-name")].find(el=>el.textContent==="Tile 256").closest(".tree-row").querySelector("button.tree-action").click()');
        if(!isField) await wait(S+".surfaceCount==="+count);
        await ev(raf);
      }
      const colors=await sampleFrame(points);
      if(samples.length)assert.deepEqual(colors,samples[0].colors,"Unrelated cube changed an authored material");
      samples.push({count,colors});
    }
    let floatControl;
    if(!isField) {
      // Compare the packed grey with a float material uniform on the same
      // geometry, camera, lighting and GPU. The next fixture reloads the page.
      floatControl=await ev(`(async()=>{
        const api=await import(new URL("forge3d-web/index.js",document.baseURI).href);
        const rt=${D}.terrainViewport.diagnosticRuntime, proto=api.Forge3DRuntime.prototype;
        const [x,y]=${J(points[1])}, offset=4*(rt.width*y+x);
        const sample=async()=>Array.from((await rt.readRgba()).slice(offset,offset+4));
        window.vp12RestoreMaterialHook();
        const original=window.vp12GreyMaterials, read=proto.readRgba;
        const measure=async material=>{
          const mats=new api.MaterialCollection();
          mats.set("grey",{id:"grey",baseColor:[.0018,.0018,.0018,1],metallic:1,roughness:.6,...material});
          proto.readRgba=async function(...args){
            this.setMaterials(mats.snapshot());
            try {return await read.apply(this,args)} finally {this.setMaterials(original)}
          };
          try {return await sample()} finally {proto.readRgba=read}
        };
        const packed=await sample(), uniform=await measure({});
        const result={packed,uniform};
        if(packed.some((v,i)=>Math.abs(v-uniform[i])>1)) {
          const tex=original.materials[1].material.textures;
          result.baseOnly=await measure({baseColor:[1,1,1,1],textures:{baseColor:tex.baseColor,sampler:tex.sampler}});
          result.surfaceOnly=await measure({roughness:1,textures:{metallicRoughness:tex.metallicRoughness,sampler:tex.sampler}});
        }
        return result;
      })()`);
      assert.ok(floatControl.packed.every((v,i)=>Math.abs(v-floatControl.uniform[i])<=1),JSON.stringify(floatControl));
    }
    const blackProject=await native();
    blackProject.scene.objects.find(o=>o.id===grid[122].id).kind.material.baseColor=[0,0,0];
    const blackPath=join(out,"threshold-black.studio3d");
    if(!isField)await writeFile(blackPath,J(blackProject));
    await open(blackPath);await pose([0,0,6]);await waitForLighting();
    const [blackControl]=await sampleFrame([points[1]]);
    assert.notDeepEqual(blackControl,samples[0].colors[1],"Dim material matched black at the same pixel");
    async function renderBulbs(label, mode, exposure, colours) {
      await pairedFixture(label, project => {
        const light = project.scene.objects.find(o => o.kind.type === "light");
        project.viewport.mode = mode;
        project.render.shadows = false;
        project.render.exposure = exposure;
        project.scene.objects = [{ ...structuredClone(camera), visible:false }, ...colours.map((color, i) => {
          const bulb = structuredClone(light);
          bulb.id = crypto.randomUUID();
          bulb.name = "Bulb " + i;
          bulb.kind.color = color;
          bulb.transform.translation = { x:(i-1)*.35, y:0, z:0 };
          bulb.transform.rotationDeg = { x:0, y:0, z:0 };
          return bulb;
        })];
      });
      await pose([0,0,1.6]);
      const lights = (await native()).scene.objects.slice(1);
      const points = await Promise.all(lights.map(async light => {
        const [x,y] = await pixel(light.id);
        return [x+8,y-8]; // Interior, clear of the ray through the bulb centre.
      }));
      return { points, pixels:await sampleFrame(points) };
    }
    const reds = [[0,0,0],[.0018,0,0],[.12,0,0]];
    const { points:bulbPoints, pixels:bulbs } = await renderBulbs("dim-bulbs","material",8,reds);
    assert.deepEqual(bulbs[0],[0,0,0,255]);
    assert.ok(bulbs[1][0]>0 && bulbs[1][0]<bulbs[2][0] && bulbs[1][1]===0 && bulbs[1][2]===0,JSON.stringify(bulbs));
    if (isField) assert.deepEqual(bulbs,report.authoredColour.candidate.bulbs,"Material bulb colour differs from Field");

    const yellows = [[1,.75,.02],[.75,1,.02],[.8,.8,.02]];
    const solidBulbs = [];
    for (const [exposure,colours] of [[1.35,yellows],[.5,yellows],[8,reds]]) {
      const sample = await renderBulbs("solid-bulbs-"+exposure,"solid",exposure,colours);
      assert.equal(new Set(sample.pixels.map(pixel => pixel.join(","))).size,3,
        "Solid bulb colours at exposure "+exposure+": "+J(sample.pixels));
      if (isField) {
        const studio = report.authoredColour.candidate.solidBulbs[solidBulbs.length];
        assert.deepEqual(studio.points,sample.points);
        for (const [i,pixel] of sample.pixels.entries()) {
          assert.ok(pixel.every((channel,c) => Math.abs(channel-studio.pixels[i][c])<=1),
            "Solid bulb "+i+" at exposure "+exposure+" Field "+J(pixel)+" Studio "+J(studio.pixels[i]));
        }
      }
      solidBulbs.push({exposure,colours,...sample});
    }
    (report.authoredColour??={})[role]={points,samples,floatControl,blackControl,bulbPoints,bulbs,solidBulbs};
  }
  await checkAuthoredColour();
  if(isField) {await checkOrder();return;}
  await open(saved);


  await pose([0,5,14]);
  const snapshot=()=>ev(S+".objects");
  const getBounds=async id=>(await snapshot()).find(r=>r.id===id).bounds;
  for(const o of scene.scene.objects) {
    const id=o.id, kind=o.kind.type, local=kind==="camera"?[0,Math.tan(o.kind.fovDeg*Math.PI/360)*1.15,-1.15]:kind==="light"?[0,0,-1]:[0,0,0];
    await button("Select (V)"); await click([30,90]);
    const at=await pick(id,local), before=await getBounds(id);
    const record=(await snapshot()).find(r=>r.id===id);
    await wait(S+".selectionBoxes.includes("+J(id)+")");
    await button("Move (G)"); await button("World-aligned");
    const grip='document.querySelector(".world-x-grip")'; await wait(grip+".getBoundingClientRect().width>0");
    const [gx,gy]=await ev(`(r=>[r.x+r.width/2,r.y+r.height/2])(${grip}.getBoundingClientRect())`);
    await mouse("mousePressed",gx,gy); await mouse("mouseMoved",gx+22,gy); await ev(raf);
    const held=await getBounds(id); assert.ok(held.min.x>before.min.x,"held bounds "+id);
    assert.deepEqual((await native()).scene.objects.find(v=>v.id===id).transform,o.transform);
    await mouse("mouseReleased",gx+22,gy); await ev(raf);
    await wait(`(async()=>(await ${state}).project.scene.objects.find(o=>o.id==="${id}").transform.translation.x!==${o.transform.translation.x})()`);
    await button("Undo "); await ev(raf);
    assert.deepEqual(await getBounds(id),before);
    console.log("Pick, move and Undo",o.name,id);
    report.inventory.push({name:o.name,id,triangles:record.triangles,segments:record.segments,hitPixel:at,hitLocal:local,previewBounds:held,restoredBounds:before});
  }
  await button("Select (V)"); await click([30,90]);
  await pick(ids.Cube); await click(await pixel(ids.Sphere),8);
  await wait(S+".selectionBoxes.length===2");
  assert.deepEqual((await ev(S+".selectionBoxes")).sort(),[ids.Cube,ids.Sphere].sort());
  await click([30,90]); await pick(ids.Sphere);
  // Compare selected and unselected GPU frames to find a real box stroke over transparent sky.
  await wait(S+".selectionBoxes.includes("+J(ids.Sphere)+")");
  const skyEdge=await ev(`(async()=>{const rt=${D}.terrainViewport.diagnosticRuntime;
    window.boxPixels=await rt.readRgba();return true})()`);
  assert.ok(skyEdge);
  await click([30,90]); await ev(raf);
  await wait(S+".selectionBoxes.length===0");
  const edge=await ev(`(async()=>{const rt=${D}.terrainViewport.diagnosticRuntime,b=await rt.readRgba();
    for(let i=0;i<b.length;i+=4)if(!b[i+3]&&boxPixels[i+3]>60)return [(i/4)%rt.width,Math.floor(i/(4*rt.width))];return null})()`);
  assert.ok(edge); await pick(ids.Sphere); await click(edge);
  assert.deepEqual((await native()).selection,[]); report.boxOnlySky=edge;
  const center=await pixel(ids.Cube), clay=await rgba(center);
  for(const mode of ["Material preview","Solid mode"]) {
    await button(mode); await wait(`${D}.frame.settings.mode==="${mode.startsWith("Material")?"material":"solid"}" && !document.querySelector(".viewport-canvas--terrain").hidden`);
    await ev(raf);
    const sample=await rgba(center), record=(await snapshot()).find(r=>r.id===ids.Cube), submitted=record.material;
    const authored=scene.scene.objects.find(o=>o.id===ids.Cube).kind.material;
    assert.ok(Math.abs(record.roughness-(mode.startsWith("Material")?authored.roughness:.62))<1e-6);
    assert.ok(Math.abs(record.metallic-(mode.startsWith("Material")?authored.metallic:0))<1e-6);
    if(mode.startsWith("Material")) {
      assert.notDeepEqual(sample,clay);
      assert.ok(submitted.slice(0,3).every((v,i)=>Math.abs(v-scene.scene.objects.find(o=>o.id===ids.Cube).kind.material.baseColor[i])<1e-6));
    } else assert.deepEqual(sample,clay);
    (report.modeCycle??=[]).push({mode,sample,submitted,roughness:record.roughness,metallic:record.metallic});
  }
  for (const [name,id] of [["cube",ids.Cube],["sphere",ids.Sphere],["mirrored",ids.Cube]]) {
    await fixture(name,p=>{for(const o of p.scene.objects){o.visible=o.id===id;if(o.visible){o.transform.translation={x:0,y:0,z:0};o.transform.scale.x=name==="mirrored"?-1:1;}}});
    await pose([0,0,5]);await pick(id);await click([30,90]);await pose([0,0,0],[0,0,-1]);
    assert.ok(await ev(`(async()=>!(await ${D}.terrainViewport.diagnosticRuntime.readRgba()).some((v,i)=>i%4===3&&v))()`),name+" inside framebuffer");
    await click([397,363]);assert.deepEqual((await native()).selection,[]);assert.equal(await ev(D+".lastPick.hit"),null);
  }
  await fixture("overlap",p=>{for(const o of p.scene.objects){o.visible=[ids.Sphere,ids.Cube].includes(o.id);o.transform.translation={x:0,y:0,z:o.id===ids.Sphere?2:0}}});
  await pose([0,0,8]);await pick(ids.Sphere);
  await button("Delete (");await wait(`!${S}.visibleIds.includes("${ids.Sphere}") && !${S}.selectionBoxes.includes("${ids.Sphere}")`);await pick(ids.Cube);
  await fixture("occluded-frustum",p=>{
    for(const o of p.scene.objects) {
      o.visible=[ids.Cube,camera.id].includes(o.id);
      if(o.visible) o.transform.translation={x:0,y:0,z:o.id===camera.id?-1:0};
    }
  });
  await pose([0,0,6]);
  const frustumLocal=[0,Math.tan(camera.kind.fovDeg*Math.PI/360)*1.15,-1.15];
  const toggleVisible=id=>ev(`document.querySelector('[data-object-id="${id}"] button.tree-action').click()`);
  await toggleVisible(ids.Cube);await wait(`!${S}.visibleIds.includes("${ids.Cube}")`);
  const strokePixel=await pick(camera.id,frustumLocal);
  await click([30,90]);await toggleVisible(ids.Cube);await wait(`${S}.visibleIds.includes("${ids.Cube}")`);
  const covered=await rgba(strokePixel);
  await toggleVisible(camera.id);await wait(`!${S}.visibleIds.includes("${camera.id}")`);
  assert.deepEqual(await rgba(strokePixel),covered);
  await toggleVisible(camera.id);await wait(`${S}.visibleIds.includes("${camera.id}")`);
  await click(strokePixel);await pickRow(ids.Cube);
  assert.equal(await ev(D+".lastPick.hit.id"),ids.Cube);
  report.occludedFrustum={pixel:strokePixel,foreground:ids.Cube,stroke:camera.id,rgba:covered};
  await fixture("ancestor",p=>{p.scene.objects.find(o=>o.id===ids.Sphere).parent=ids.Cube});
  await pose([0,5,14]);await tree(ids.Sphere);await pickRow(ids.Sphere);
  const descendantPixel=await pixel(ids.Sphere);
  await ev(`document.querySelector('[data-object-id="${ids.Cube}"] button.tree-action').click()`);
  await wait(`!["${ids.Sphere}","${ids.Cube}"].some(id=>${S}.visibleIds.includes(id)||${S}.selectionBoxes.includes(id))`);
  assert.equal((await rgba(descendantPixel))[3],0);await click(descendantPixel);assert.equal(await ev(D+".lastPick.hit"),null);
  await fixture("point",p=>{for(const o of p.scene.objects){o.visible=o.id===light.id;if(o.visible)o.kind.kind="point"}});
  await pose([0,5,14]);assert.equal((await snapshot())[0].segments,8);
  report.inventory.push({name:"Legacy point light",id:light.id,segments:8,triangles:(await snapshot())[0].triangles,hitPixel:await pick(light.id,[.28,0,0]),bulbPixel:await pick(light.id)});
  report.edgeCases=await edgeCases({fixture,pose,ev,wait,click,rgba,button,native,ids,D,S,cdp,pixel});
  await fixture("camera-view",p=>{
    for(const o of p.scene.objects) o.visible=o.kind.type==="camera";
    for(const o of p.scene.objects) if(o.kind.type==="camera"){
      o.transform.translation={x:0,y:0,z:o.id===camera.id?6:0};o.transform.rotationDeg={x:0,y:0,z:0};
    }
    p.selection=[camera.id];
  });
  await button("Camera view");await wait(`!${S}.visibleIds.includes("${camera.id}") && !${S}.selectionBoxes.includes("${camera.id}")`);
  await pick(ids.CameraCopy,[0,Math.tan(Math.PI/8)*1.15,-1.15]);
  await button("Object:");await ev('[...document.querySelectorAll("button")].find(b=>b.textContent.trim()==="Set active").click()');
  await wait(`!${S}.visibleIds.includes("${ids.CameraCopy}") && ${S}.visibleIds.includes("${camera.id}") && !${S}.selectionBoxes.includes("${ids.CameraCopy}")`);
  await checkOrder();
}

try {
  for (const role of ["candidate","field","editor"]) {
    await desktop({root,field,out,report,role,values:{},metrics:{width:1440,height:833},observeCandidate:role==="candidate"?observe:undefined},
      cdp=>session(cdp,role));
  }
  report.successfulWebGL=report.contexts.filter(c=>c.requested.includes("webgl")&&c.result).length;
  assert.equal(report.successfulWebGL,0);
  assert.ok(report.contexts.some(c=>c.requested==="webgpu"&&c.result));
  report.passed=true;
  console.log("VP-12 passed",out);
} catch(error) {report.error=error.stack;throw error;}
finally {await writeFile(join(out,"results.json"),J(report,null,2)+"\n");}
