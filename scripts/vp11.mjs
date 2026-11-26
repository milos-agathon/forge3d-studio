import assert from "node:assert/strict";
import { Camera } from "@forge3d/web";
import { DoubleSide, Mesh, MeshBasicMaterial, PlaneGeometry, Raycaster } from "three";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import "./prepare-viewport-runtime.mjs";
import { createFixture, CUBE_ID, FIELD_REVISION, TERRAIN_ID, verifyProvenance } from "./vp01/fixture.mjs";
import { fixtures } from "./vp04/fixtures.mjs";
import { checkHover } from "./vp04/hover.mjs";
import { instrument } from "./vp07-page.mjs";
import { buildShell, desktop, fieldCheckout, until } from "./viewport-desktop.mjs";
import { checkTiming, checkWheel } from "./vp11-timing.mjs";
import { checkSidebar } from "./vp11-sidebar.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const out = await mkdtemp(join(tmpdir(), "studio-vp11-"));
console.log("VP-11 evidence", out);
process.env.PYTHONDONTWRITEBYTECODE = "1";
process.env.FORGE3D_STUDIO_PYTHON ??= execFileSync("python", ["-c", "import sys;print(sys.executable)"], {encoding:"utf8"}).trim();
const projects = await fixtures(root, out);
const saddle = JSON.parse(await readFile(projects.identity.path));
const raster = join(out, "saddle.tif");
const stripes = join(out, "stripes.tif");
execFileSync(process.env.FORGE3D_STUDIO_PYTHON, ["-c", `
import numpy as np, rasterio, sys
with rasterio.open(sys.argv[1]) as src:
    rows, cols = np.indices((96,96))
    for path, pattern in [(sys.argv[2], rows+cols), (sys.argv[3], cols)]:
        a = (100 + 40 * (pattern % 2)).astype("float32")
        with rasterio.open(path, "w", **src.profile) as dst: dst.write(a.repeat(2,axis=1),1)
`, saddle.assets[0].path, raster, stripes]);
saddle.assets[0].path = raster;
saddle.scene.objects.find(o=>o.id===TERRAIN_ID).kind.elevationRange = [100,140];
projects.saddle = { path:join(out,"saddle.studio3d") };
await writeFile(projects.saddle.path,JSON.stringify(saddle));
const slope = structuredClone(saddle);
slope.assets[0].path = stripes;
projects.slope = {path:join(out,"slope.studio3d")};
await writeFile(projects.slope.path,JSON.stringify(slope));
// Audit fixtures use metre-based GeoTIFF footprints as well as project metadata.
for (const [name,width,values] of [["edge47",47,[10,10]],["plateau",12,[0,1.5]],["rectStripes",12,[100,140]]]) {
  const project = structuredClone(slope), path = join(out,name+".tif");
  execFileSync(process.env.FORGE3D_STUDIO_PYTHON,["-c",`
import numpy as np, rasterio, sys
from rasterio.transform import from_origin
path, name, width = sys.argv[1:4]
cols = np.indices((96,192))[1]
if name == "edge47":
    data = np.full(cols.shape, 10)
elif name == "plateau":
    data = np.where(cols < 20, 0, 1.5)
else:
    data = 100 + 40 * (cols // 2 % 2)
with rasterio.open(path,"w",driver="GTiff",width=192,height=96,count=1,dtype="float32",crs="EPSG:32612",
                   transform=from_origin(400000,4100000,float(width)/192,float(width)/192)) as dst:
    dst.write(data.astype("float32"),1)
`,path,name,String(width)]);
  project.assets[0].path=path;
  Object.assign(project.scene.objects.find(o=>o.id===TERRAIN_ID).kind,{worldSpanXz:[width,width/2],elevationRange:values});
  projects[name]={path:join(out,name+".studio3d")};
  await writeFile(projects[name].path,JSON.stringify(project));
}
const placed = JSON.parse(await readFile(projects.placed.path));
const translated = structuredClone(placed);
translated.scene.objects.find(o=>o.id===TERRAIN_ID).transform.scale = {x:1,y:1,z:1};
projects.translationOnly = {path:join(out,"translationOnly.studio3d")};
await writeFile(projects.translationOnly.path,JSON.stringify(translated));
placed.scene.objects.find(o=>o.id===TERRAIN_ID).kind.zScale = 3;
projects.exaggerated = {path:join(out,"exaggerated.studio3d")};
await writeFile(projects.exaggerated.path,JSON.stringify(placed));
projects.relief = await createFixture(join(out,"relief"));
const relief = JSON.parse(await readFile(projects.relief.path));
const terrain = relief.scene.objects.find(o=>o.id===TERRAIN_ID);
delete terrain.kind.overlay;
relief.assets = relief.assets.filter(a=>a.id===terrain.kind.asset);
relief.viewport.mode = "solid";
relief.selection=[];
await writeFile(projects.relief.path,JSON.stringify(relief));

const report = { base:execFileSync("git",["rev-parse","HEAD"],{cwd:root,encoding:"utf8"}).trim(),
  field:FIELD_REVISION, runtime:(await verifyProvenance()).commit, readings:{} };
const D = "forge3dViewportDiagnostics()", S = D+".terrainViewport.diagnosticSubmission";
const dd = 'document.querySelector(".viewport-readout__cursor dd")?.textContent';
const raf = "new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))";
const json = JSON.stringify;

function observeSamples(field) {
  const samples = window.hoverSamples = [];
  window.addEventListener("pointermove", e => {
    window.hoverInput = {client:[e.clientX,e.clientY], trusted:e.isTrusted, target:e.target.className};
  }, true);
  if (field) {
    const {three,runtime} = __vp01FieldDiagnostics();
    const proto = three.Raycaster.prototype, original = proto.intersectObjects;
    let client;
    document.addEventListener("pointermove", e=>{client=[e.clientX,e.clientY]}, true);
    proto.intersectObjects = function(objects, recursive, ...rest) {
      const hits = original.call(this,objects,recursive,...rest);
      if (recursive === false && objects.length && objects.every(o=>o.userData.elevation)) {
        const hit=hits[0], elevation=hit?.object.userData.elevation;
        samples.push({at:performance.now(), client, metres: hit
          ? elevation.min + hit.object.worldToLocal(hit.point.clone()).y/elevation.scale : null,
          submission: {frame:runtime.renderer.info.render.frame,mesh:objects[0].uuid}});
      }
      return hits;
    };
  } else {
    const host = forge3dViewportDiagnostics().terrainViewport, sample = host.cursorElevation.bind(host);
    host.cursorElevation = (frame,x,y) => {
      const metres=sample(frame,x,y), {sequence, projectId, projectGeneration, terrain, visibleIds}=host.diagnosticSubmission;
      const {width,height}=document.querySelector(".viewport-terrain-surface").getBoundingClientRect();
      samples.push({at:performance.now(), client:[x,y], layout:[width,height], metres, submission:{sequence,projectId,projectGeneration,
        objectId:terrain?.objectId,resolution:terrain?.resolution,visibleIds}});
      return metres;
    };
  }
}

async function replay(cdp, field) {
  const ev = expr=>cdp.evaluate(expr), wait = expr=>until(cdp,expr);
  const role = field ? "field" : "candidate";
  const results = report.readings[role] = {};
  const canvas = field ? "__vp01FieldDiagnostics().runtime.renderer.domElement" : 'document.querySelector(".viewport-canvas--terrain")';
  async function open(name) {
    await ev(`localStorage.setItem("studio.viewport.mapGrid","0");__TAURI_INTERNALS__.invoke("open_project",{path:${json(projects[name].path)}})`);
    await ev("window.leaving=true");
    await cdp.send("Page.reload",{ignoreCache:true});
    await wait("!window.leaving && "+(field
      ? '!!window.__vp01FieldDiagnostics?.().runtime.objects.values().find(g=>g.children.some(c=>c.userData.elevation))'
      : '!!window.forge3dViewportDiagnostics?.().terrainViewport.diagnosticSubmission?.terrain'));
    await ev(`document.querySelector('.recovery button[aria-label="Dismiss"]')?.click(); (${instrument})(); (${observeSamples})(${field})`);
    if (!field) assert.equal(await ev(D+".runtime === null"),true);
  }
  async function record(name, expected) {
    await ev(raf);
    const r = await ev(`(() => {
      const c=${canvas}, frame=${field ? "__vp01FieldDiagnostics().runtime" : D+".frame"};
      const rect=c.getBoundingClientRect(), [x,y]=hoverSamples.at(-1).client;
      return {...hoverSamples.at(-1), input:window.hoverInput, cssSize:[c.clientWidth,c.clientHeight],surfaceSize:[rect.width,rect.height],
        bufferPoint:[(x-rect.left)*c.width/rect.width,(y-rect.top)*c.height/rect.height], text:${dd},size:[c.width,c.height],dpr:devicePixelRatio,
        camera:${field ? "{eye:frame.camera.position.toArray(),aim:frame.orbit.target.toArray()}" : "{eye:frame.camera.eye,aim:frame.camera.aim.orbitTarget}"},
        backend:${field ? "frame.renderer.getContext().constructor.name" : 'document.querySelector("[data-viewport-backend]").textContent'},
        selections:probe.calls.filter(c=>c.cmd==="set_selection").length};
    })()`);
    results[name]=r;
    assert.ok(r.client && r.submission && r.at >= 0,name+" missing terrain sample");
    assert.ok(r.input.trusted,name+" trusted terrain input");
    assert.deepEqual(r.client,r.input.client,name+" sampled pointer");
    assert.equal(r.text, r.metres===null ? "—" : Math.round(r.metres).toLocaleString("en-US")+" m",name);
    assert.equal(r.backend.includes(field ? "WebGL2" : "WebGPU available"),true);
    assert.equal(r.selections,0);
    if (expected!==undefined) assert.equal(r.text,expected,name);
    console.log(role, name, r.client, r.text);
    if (!field) {
      const ref=report.readings.field[name];
      for (const key of ["metres","text","client","size","cssSize","dpr"]) assert.deepEqual(r[key],ref[key],name+" "+key);
      // The two viewports show the same logical view. The candidate centres and
      // clips its canvas to preserve square framebuffer pixels.
      for (const axis of [0,1]) {
        const mid=r.size[axis]/2;
        const expected=mid+(ref.bufferPoint[axis]-mid)*ref.surfaceSize[axis]/r.surfaceSize[axis];
        assert.ok(Math.abs(r.bufferPoint[axis]-expected)<1e-4,name+" framebuffer coordinate");
      }
      for (const key of ["eye","aim"]) assert.ok(r.camera[key].every((v,i)=>Math.abs(v-ref.camera[key][i])<1e-8),name+" camera");
    }
  }
  async function pose(eye,aim) {
    if (field) await ev(`{const r=__vp01FieldDiagnostics().runtime;r.camera.position.fromArray(${json(eye)});
      r.orbit.target.fromArray(${json(aim)});
      // This comparison supplies an exact pose. Orbit damping would reconstruct
      // the Field eye from spherical coordinates between projection and hover.
      r.orbit.update=()=>false;
      r.camera.up.fromArray(${json(eye[0]===aim[0] && eye[2]===aim[2] ? [0,0,-1] : [0,1,0])});
      r.camera.lookAt(r.orbit.target);
      r.camera.updateMatrixWorld(true);r.needsRender=true}`);
    else {
      const seq=await ev(S+".sequence");
      await ev(D+`.setOrbitPose(${json(eye)},${json(aim)})`);
      await wait(S+".sequence > "+seq);
    }
    await ev(raf);
  }
  async function move(label,client,expected) {
    await delay(75); // Field drops moves inside its throttle window.
    const [x,y] = client;
    const before = await ev("hoverSamples.length");
    await cdp.send("Input.dispatchMouseEvent",{type:"mouseMoved",x,y,pointerType:"pen"});
    await wait("hoverSamples.length > "+before);
    const input = await ev("hoverInput");
    // Chromium reports trusted pen coordinates as floats at fractional DPR.
    assert.ok(input.client.every((v,i)=>Math.abs(v-client[i])<1e-4),label+" client "+input.client);
    await record(label,expected);
  }
  const centre = ()=>ev(`(r=>[r.x+r.width/2,r.y+r.height/2])(${canvas}.getBoundingClientRect())`);
  for (const [name,expected] of [["identity",undefined],["clip","102 m"],["halfHover","101 m"]]) {
    await open(name);
    await checkHover(cdp,field,until,expected,"webgpu");
    await record(name,expected??"10 m");
  }
  await open("edge47");
  for (const [name,x,expected] of [["47 m east edge",6,"10 m"],["47 m interior",6-1e-6,"10 m"],["47 m exterior",6+1e-6,"\u2014"]]) {
    await pose([x,5,0],[x,0,0]); await move(name,await centre(),expected);
  }
  await open("plateau");
  await pose([9.5,7,11],[0,.8,0]);
  for (const y of [366,378,381,384,396,405]) {
    const label="plateau pixel 301,"+y;
    await move(label,[584,68+y],y<=378 ? "1 m" : "2 m");
    if (!field) assert.equal(results[label].metres,report.readings.field[label].metres,label);
  }
  await open("edgeWide");
  await ev(`document.querySelector('[role="tab"][aria-label="Animation"]').click()`);
  const far = await ev(field ? "__vp01FieldDiagnostics().runtime.camera.far" : D+".frame.camera.far");
  for (const [label,x,y,expected] of [
    ["exact east edge",6,5,"10 m"], ["east exterior",6.000001,5,"—"],
    ["inside near plane",0,.02,"10 m"], ["beyond far plane",0,2*far,"10 m"], ["interior",0,5,"10 m"],
  ]) {
    await pose([x,y,0],[x,0,0]);
    await move(label,await centre(),expected);
  }
  const frameText = 'document.querySelector(".timeline__frame").textContent';
  const first = await ev(frameText), count = await ev("hoverSamples.length");
  await ev('document.querySelector(".timeline__play").click()');
  await wait("parseInt("+frameText+") >= "+(parseInt(first)+3));
  await ev(raf);
  const playback = {first,last:await ev(frameText),text:await ev(dd),samples:await ev("hoverSamples.length")-count};
  assert.equal(playback.text,"10 m");
  assert.equal(playback.samples,0);
  report[role+"Playback"]=playback;
  await ev('document.querySelector(".timeline__play").click()');
  await open("slope");
  const lo = Math.fround(2/95-.5), hi = Math.fround(3/95-.5);
  const stripeX = 12*(lo+(20.5-.00001)/40*(hi-lo));
  await pose([stripeX,5,0],[stripeX,0,0]);
  await move("Float32 stripe",await centre(),"120 m");
  await cdp.send("Emulation.setDeviceMetricsOverride",{width:1440,height:900,deviceScaleFactor:1.25,mobile:false});
  await open("saddle");
  const ground=(col,row)=>[12*(col/95-.5),12*960/2688*(row/95-.5)];
  const [sx,sz]=ground(48.25,48.25), sy=20*12/2688;
  await pose([sx,5,sz],[sx,sy,sz]);
  await move("saddle",await centre(),"120 m");
  if (!field) {
    const control = await ev(`(() => {const d=${D},p=d.frame.terrains.get("${TERRAIN_ID}").preview;
      return {heights:[0,1,96,97].map(i=>p.heights[48*96+48+i]),bilinear:d.queryTerrain(${sx},${sz}).elevation}})()`);
    assert.deepEqual(control.heights,[100,140,140,100]);
    assert.ok(Math.abs(control.bilinear-115)<1e-8);
    report.saddleControl=control;
  }
  for (const name of ["identity","translationOnly","placed","exaggerated"]) {
    await open(name);
    const [gx,gz]=ground(70,19), scale=name==="placed" || name==="exaggerated" ? 1.25 : 1;
    const world=[gx*scale+(name==="identity"?0:1.5),19*12/2688*(name==="exaggerated"?3:1)*scale+(name==="identity"?0:2),gz*scale+(name==="identity"?0:-.75)];
    // Look down onto the peak. In a shallow view its tip is a silhouette:
    // rounding a projected vertex can put the ray on the distant valley floor.
    await pose([4,18,-1.7],[3,0,-1.8]);
    const label=name+" peak";
    const client=field ? await ev(`(() => {const {three,runtime}=__vp01FieldDiagnostics();
      const p=new three.Vector3(...${json(world)}).project(runtime.camera), r=${canvas}.getBoundingClientRect();
      return [r.x+(1+p.x)*r.width/2,r.y+(1-p.y)*r.height/2]})()`) : report.readings.field[label].projectedClient;
    await move(label,client,"29 m");
    if (!field) assert.equal(results[label].metres,report.readings.field[label].metres,label);
    results[label].worldPoint=world;
    results[label].projectedClient=client;
  }
  await open("identity");
  for (const [label,x,expected] of [["edge",6,"10 m"],["outside",6.001,"—"]]) {
    await pose([x,5,.001],[x,0,0]); await move(label,await centre(),expected);
  }
  await pose([0,5,0],[0,8,-3]); await move("sky",await centre(),"—");
  await cdp.send("Emulation.setDeviceMetricsOverride",{width:1440,height:833,deviceScaleFactor:1,mobile:false});
  for (const dpr of [1,1.25]) {
    await cdp.send("Emulation.setDeviceMetricsOverride",{width:1440,height:833,deviceScaleFactor:dpr,mobile:false});
    await open("rectStripes");
    await ev('Object.assign(document.querySelector(".viewport").style,{boxSizing:"content-box",flex:"none",width:"793px",height:"727px"})');
    await wait(`${canvas}.width===${Math.floor(793*dpr)} && ${canvas}.height===${Math.floor(727*dpr)}`);
    await pose([-26.1,80,0],[-26.1,0,0]);
    const label="rectangular stripes DPR "+dpr;
    await move(label,[930,431.5],"109 m");
    assert.ok(Math.abs(results[label].metres-109.47960173631472)<1e-8,label);
  }
  // Raycast the admitted striped mesh independently at the submitted buffer
  // coordinate. This fixture has unit horizontal/exaggeration scale and no placement.
  let stripes;
  if (!field) {
    const {resolution,heights,minElevation,spanXz}=await ev(D+'.frame.terrains.get("'+TERRAIN_ID+'").preview');
    const geometry=new PlaneGeometry(1,1,resolution-1,resolution-1).rotateX(-Math.PI/2);
    for (const [i,m] of heights.entries()) geometry.attributes.position.setY(i,m-minElevation);
    const mesh=new Mesh(geometry,new MeshBasicMaterial({side:DoubleSide}));
    mesh.scale.set(spanXz[0],1,spanXz[1]);
    mesh.updateMatrixWorld();
    stripes={mesh,minElevation};
  }
  for (const [width,height] of [[793,727],[793.375,727],[793.625,727],[793.375,727.625]]) {
    await ev(`Object.assign(document.querySelector(".viewport").style,{width:"${width}px",height:"${height}px"})`);
    await wait(`${canvas}.width===${Math.floor(Math.round(width)*1.25)} && ${canvas}.height===${Math.floor(Math.round(height)*1.25)}`);
    const oblique=height!==727;
    await pose(oblique ? [5,60,0] : [0,60,0],oblique ? [0,15,0] : [0,0,0]);
    const points=oblique ? [420,431.5,445].map(y=>[680,y]) :
      [671,676,678,679,680,681,682,684,689,700,720].map(x=>[x,431.5]);
    const submission=field ? undefined : await ev(S);
    for (const [x,y] of points) {
      const label=`striped slope ${width}x${height} at ${x},${y}`;
      const centreText=width===793 ? "111 m" : width===793.375 ? "115 m" : "117 m";
      await move(label,[x,y],!oblique && x===680 ? centreText : undefined);
      const reading=results[label];
      if (field) assert.deepEqual(reading.surfaceSize,[width,height],label);
      else {
        assert.equal(reading.submission.sequence,submission.sequence,label);
        const ray=new Camera(submission.camera).screenRay(...reading.bufferPoint,submission);
        const caster=new Raycaster();
        caster.ray.origin.fromArray(ray.origin);
        caster.ray.direction.fromArray(ray.direction);
        const hit=caster.intersectObject(stripes.mesh)[0];
        assert.ok(hit,label+" submitted terrain hit");
        reading.submittedMetres=stripes.minElevation+hit.point.y;
        assert.ok(Math.abs(reading.submittedMetres-reading.metres)<.002,label+" submitted elevation");
        assert.equal(Math.round(reading.submittedMetres),Math.round(reading.metres),label);
      }
    }
  }
  if (!field) {
    async function stationaryResize(client,eye,aim,sizes) {
      const [x,y]=client, observations=[];
      for (const [width,height] of sizes) {
        const count=await ev("hoverSamples.length");
        await ev(`Object.assign(document.querySelector(".viewport").style,{boxSizing:"content-box",flex:"none",width:"${width}px",height:"${height}px"})`);
        if (!observations.length) {
          await pose(eye,aim);
          await cdp.send("Input.dispatchMouseEvent",{type:"mouseMoved",x,y,pointerType:"pen"});
        }
        await wait(`hoverSamples.length>${count} && hoverSamples.at(-1).layout[0]===${width} &&
          hoverSamples.at(-1).layout[1]===${height} && hoverSamples.at(-1).client.every((v,i)=>Math.abs(v-${json(client)}[i])<1e-4)`);
        await ev(raf);
        const state=await ev(`(async()=>{
          const sample=hoverSamples.at(-1),s=${S},r=${canvas}.getBoundingClientRect();
          const pixel=[Math.floor((sample.client[0]-r.left)*s.width/r.width),Math.floor((sample.client[1]-r.top)*s.height/r.height)];
          const rgba=await ${D}.terrainViewport.diagnosticRuntime.readRgba();
          return {...sample,text:${dd},buffer:[s.width,s.height],pixel,alpha:rgba[4*(pixel[1]*s.width+pixel[0])+3],
            moves:probe.trace.filter(e=>e.type==="pointermove").length,input:hoverInput,sequence:s.sequence};
        })()`);
        assert.ok(state.input.trusted);
        assert.deepEqual(state.client,state.input.client);
        assert.equal(state.submission.sequence,state.sequence);
        const first=observations[0];
        if (first) {
          assert.deepEqual(state.buffer,first.buffer);
          assert.equal(state.sequence,first.sequence,"CSS-only resize reused the submission");
          assert.equal(state.moves,first.moves,"pointer stayed stationary during resize");
        }
        observations.push(state);
      }
      return observations;
    }
    const slope=await stationaryResize([680,431.5],[0,60,0],[0,0,0],[[793,727],[793.375,727],[793,727]]);
    assert.deepEqual(slope.map(s=>s.text),["111 m","115 m","111 m"]);
    for (const state of slope) {
      const key=`striped slope ${state.layout[0]}x727 at 680,431.5`;
      assert.equal(state.metres,report.readings.field[key].metres);
      assert.ok(Math.abs(state.metres-results[key].submittedMetres)<.002);
    }
    const height=await stationaryResize([680,420],[5,60,0],[0,15,0],[[793.375,727.625],[793.375,727.875],[793.375,727.625]]);
    assert.notEqual(height[0].metres,height[1].metres);
    assert.equal(height[0].metres,height[2].metres);
    await open("edge47");
    const cx=13.333596458752131*(12/47);
    const edge=await stationaryResize([907.4356079101562,438.7699890136719],[cx,10,0],[cx,0,0],
      [[793.375,727],[793,727],[793.375,727]]);
    assert.deepEqual(edge.map(s=>s.alpha),[255,0,255]);
    assert.deepEqual(edge.map(s=>s.text),["10 m","\u2014","10 m"]);
    assert.equal(edge[1].metres,null);
    report.stationaryResize={edge,slope,height};
    report.framebufferEdges=[];
    for (const [height,cx,row] of [[727,4.152991081648329,472],[207,-.4935839564940858,56],[159,-2.4576288499593684,43]]) {
      await ev(`Object.assign(document.querySelector(".viewport").style,{boxSizing:"content-box",flex:"none",width:"793px",height:"${height}px"})`);
      await wait(`${S}.width===991 && ${S}.height===${Math.floor(height*1.25)}`);
      await pose([cx,5,0],[cx,0,0]);
      const capture=await ev(`(async()=>{const s=${S}, rgba=await ${D}.terrainViewport.diagnosticRuntime.readRgba();
        const {x,y,width,height}=${canvas}.getBoundingClientRect();
        return {sequence:s.sequence,camera:s.camera,placement:s.placement,size:[s.width,s.height],surface:{x,y,width,height},alpha:[899,900,901].map(col=>rgba[4*(${row}*s.width+col)+3])}})()`);
      assert.deepEqual(capture.alpha,[255,0,0],"captured terrain silhouette");
      const points=[];
      for (const [i,col] of [899,900,901].entries()) {
        const rect=capture.surface, [w,h]=capture.size;
        const x=rect.x+(col+.5)*rect.width/w, y=rect.y+(row+.5)*rect.height/h;
        const count=await ev("hoverSamples.length");
        await cdp.send("Input.dispatchMouseEvent",{type:"mouseMoved",x,y,pointerType:"pen"});
        await wait("hoverSamples.length > "+count);
        await ev(raf);
        const hit=await ev(`({...hoverSamples.at(-1),input:hoverInput,text:${dd},sequence:${S}.sequence})`);
        assert.ok(hit.input.trusted && Math.abs(hit.client[0]-x)<1e-4 && Math.abs(hit.client[1]-y)<1e-4);
        assert.equal(hit.sequence,capture.sequence);
        assert.equal(hit.submission.sequence,capture.sequence);
        assert.equal(hit.text,i===0?"10 m":"\u2014",`pixel ${col},${row} alpha ${capture.alpha[i]}`);
        if (i===0) assert.ok(hit.metres!==null && Math.abs(hit.metres-10)<1e-9);
        else assert.equal(hit.metres,null);
        const bufferPoint=[(hit.client[0]-rect.x)*w/rect.width,(hit.client[1]-rect.y)*h/rect.height];
        const ray=new Camera(capture.camera).screenRay(...bufferPoint,{width:w,height:h});
        const groundX=capture.placement.translation[0]+capture.placement.scale*
          (ray.origin[0]-ray.origin[1]*ray.direction[0]/ray.direction[1]);
        assert.equal(groundX<=6,capture.alpha[i]!==0,"submitted ray and framebuffer coverage");
        points.push({pixel:[col,row],bufferPoint,groundX,...hit});
      }
      report.framebufferEdges.push({height,...capture,points});
    }
  }
  await cdp.send("Emulation.setDeviceMetricsOverride",{width:1440,height:833,deviceScaleFactor:1,mobile:false});
  await open("relief");
  await ev('Object.assign(document.querySelector(".viewport").style,{boxSizing:"content-box",flex:"none",width:"794px",height:"727px"})');
  const eye=[9.5,7,11],dir=[-9.5,-6.2,-11];
  await pose(eye,eye.map((v,i)=>v+10*dir[i]/Math.hypot(...dir)));
  const pixel=await ev(`(r=>[r.x+398.5,r.y+346.5])(${canvas}.getBoundingClientRect())`);
  await move("Bryce visible cube",pixel);
  const toggle = async id => {
    const row = field ? `[...document.querySelectorAll('[role="treeitem"]')].find(r=>r.querySelector(".tree-name").textContent.trim()===${json(relief.scene.objects.find(o=>o.id===id).name)})`
      : `document.querySelector('[data-object-id="${id}"]')`;
    await ev(`(${row}).querySelector("button.tree-action").click()`);
    await ev(raf);
  };
  await toggle(CUBE_ID);
  await wait(field ? `!__vp01FieldDiagnostics().runtime.objects.get("${CUBE_ID}").visible` : `!${S}.visibleIds.includes("${CUBE_ID}")`);
  await move("Bryce hidden cube",pixel,results["Bryce visible cube"].text);
  assert.deepEqual(results["Bryce hidden cube"].size,[794,727]);
  await ev(`document.querySelector('button[title^="Material preview"]').click()`);
  await wait(field ? `document.querySelector('button[title^="Material preview"]').classList.contains("is-active")` : D+'.frame.settings.mode==="material" && !!'+S+'?.terrain');
  await ev(raf);
  await move("Bryce Material",pixel,results["Bryce visible cube"].text);
  if (!field) {
    await ev(`document.querySelector('button[title^="Solid mode"]').click()`);
    await wait(D+'.frame.settings.mode==="solid" && !!'+S+'?.terrain');
    await toggle(CUBE_ID); await wait(`${S}.visibleIds.includes("${CUBE_ID}")`);
    await cdp.click(pixel);
    await wait(`${D}.lastPick?.hit?.id === "${CUBE_ID}"`);
    await wait(`(async()=>(await __TAURI_INTERNALS__.invoke("project_state")).project.selection[0]==="${CUBE_ID}")()`);
    report.selection = await ev(`(async()=>({pixel:${D}.lastPick.pixel, uuid:(await __TAURI_INTERNALS__.invoke("project_state")).project.selection,
      calls:probe.calls.filter(c=>c.cmd==="set_selection").map(c=>c.args.ids)}))()`);
    assert.deepEqual(report.selection.uuid,[CUBE_ID]);
    assert.deepEqual(report.selection.calls,[[CUBE_ID]]);
    assert.deepEqual(report.selection.pixel,[398,346]);
    await checkTiming({cdp,ev,wait,raf,report,file:projects.relief.path,pixel,toggle});
    await open("identity");
    report.stationaryWheel = {webgpu: await checkWheel(cdp,until,true)};
    report.sidebar = {webgpu: await checkSidebar(cdp,true)};
  }
}

async function checkHybridOrbit(cdp) {
  const ev = expr=>cdp.evaluate(expr);
  await ev(`__TAURI_INTERNALS__.invoke("open_project",{path:${json(projects.identity.path)}})`);
  await cdp.send("Page.reload",{ignoreCache:true});
  await until(cdp,'!!window.forge3dViewportDiagnostics?.().runtime?.orbit.enabled && !!'+S+'?.terrain');
  await ev(`document.querySelector('.recovery button[aria-label="Dismiss"]')?.click(); (${observeSamples})(false);(${instrument})();`);
  const [x,y] = await ev(`(r=>[r.x+r.width/2,r.y+r.height/2])(${D}.runtime.renderer.domElement.getBoundingClientRect())`);
  await cdp.send("Emulation.setTouchEmulationEnabled",{enabled:true,maxTouchPoints:2});
  await cdp.send("Input.dispatchTouchEvent",{type:"touchStart",touchPoints:[{x,y,id:1}]});
  await cdp.send("Input.dispatchTouchEvent",{type:"touchMove",touchPoints:[{x:x+8,y,id:1}]});
  const captured = await ev(D+".runtime.renderer.domElement.hasPointerCapture(probe.pointer)");
  assert.equal(captured,true);
  const pen = ()=>cdp.send("Input.dispatchMouseEvent",{type:"mouseMoved",x,y,pointerType:"pen"});
  const before = await ev("hoverSamples.length");
  await pen(); await delay(100);
  const held = await ev("({input:hoverInput,samples:hoverSamples.length,text:"+dd+"})");
  assert.ok(held.input.trusted && held.samples===before && held.text==="—",json(held));
  assert.ok(await ev('probe.trace.some(e=>e.device==="pen" && e.trusted && e.buttons===0)'));
  await cdp.send("Input.dispatchTouchEvent",{type:"touchEnd",touchPoints:[]});
  await pen(); await until(cdp,"hoverSamples.length > "+before);
  report.hybridOrbit = {captured,held,resumed:await ev("hoverSamples.at(-1)"),events:await ev("probe.trace")};
  await cdp.send("Emulation.setTouchEmulationEnabled",{enabled:false});
  await ev(`[...document.querySelectorAll(".menu__button")].find(b=>b.textContent.trim()==="View").click()`);
  const threeItem=`[...document.querySelectorAll('[role="menuitemradio"]')].find(b=>b.textContent.includes("three.js"))`;
  await until(cdp,`!!(${threeItem})`);
  await ev(`(${threeItem}).click()`);
  await until(cdp,'document.querySelector("[data-viewport-backend]").textContent.includes("View menu override")');
  report.stationaryWheel.webgl2 = await checkWheel(cdp,until,false);
  report.sidebar.webgl2 = await checkSidebar(cdp,false);
}

try {
  const field = fieldCheckout(root);
  for (const role of ["field","candidate"]) {
    const isField = role === "field", port = isField ? 1432 : 1436;
    const shell = buildShell(isField ? field : root, "vp11-"+role, new URL("http://localhost:"+port));
    const config = {root,field,out,values:{[isField ? "field-shell" : "shell"]:shell},report,role,port};
    await desktop(config,cdp=>replay(cdp,isField));
    if (!isField) await desktop({...config,role:"editor"},checkHybridOrbit);
  }
  report.passed=true;
  console.log("VP-11 passed");
} finally { await writeFile(join(out,"results.json"),json(report,null,2)+"\n"); }
