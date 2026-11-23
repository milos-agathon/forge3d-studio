import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

async function readPlateaux() {
  const d = forge3dViewportDiagnostics();
  const web = d.terrainViewport.diagnosticRuntime;
  const { preview } = [...d.frame.terrains.values()][0];
  const heights = await web.readTerrainHeights();
  const rgba = await web.readRgba();
  const mask = Uint8Array.from({length:rgba.length/4}, (_,i) => Number(rgba[4*i+3] > 0));
  let bytes = "";
  for (let i = 0; i < mask.length; i += 32768) bytes += String.fromCharCode(...mask.subarray(i,i+32768));
  const samples = [25,70].map(col => {
    const x = 12*(col/95-0.5), z = 6*(25/95-0.5);
    return {texture: heights[25*96+col], accepted: preview.heights[25*96+col], hit: d.queryTerrain(x,z)};
  });
  const {domain, material, exaggeration} = vp04Calls.setTerrain;
  return {mask: btoa(bytes), count: mask.reduce((a,b) => a+b,0), samples,
    size: [web.width, web.height], exaggeration, clamp: material?.clamp?.heightRange ?? domain,
    rawDomain: [preview.minElevation,preview.maxElevation], domain};
}

export async function checkDatums(cdp, projects, loadProject, until, report, out) {
  const masks = {};
  report.datum = {};
  for (const name of ["level","collapsed","lifted","fractional","rounded","upperRounded","rawFormula","relative","roundFlat","roundNear","roundRaised","threshold","relativeSmall","clip"]) {
    await loadProject(cdp, projects[name], true);
    const sequence = await cdp.evaluate("forge3dViewportDiagnostics().terrainViewport.diagnosticSubmission.sequence");
    await cdp.evaluate("forge3dViewportDiagnostics().setOrbitPose([9.5,7,11],[0,0.8,0])");
    await until(cdp,"forge3dViewportDiagnostics().terrainViewport.diagnosticSubmission.sequence > " + sequence);
    const { mask, ...info } = await cdp.evaluate(`(${readPlateaux})()`);
    report.datum[name] = info;
    masks[name] = Buffer.from(mask,"base64");
    await writeFile(join(out, name + ".mask"), masks[name]);
    assert.ok(info.count > 0 && info.count < masks[name].length);
    assert.equal(info.exaggeration, projects[name].zScale);
    const [low,high] = {level:[4096,4096], collapsed:[4096,4096.0001], lifted:[4096,4096],
      fractional:[4150.24,4150.25], threshold:[4096.0049,4096.0051], relativeSmall:[0,0.01], clip:[100,101.499], relative:[0,0.01], roundFlat:[4096.006,4096.006],
      roundNear:[4096.006,4096.0061], roundRaised:[4096.006,4096.006], rounded:[100.004,100.304], upperRounded:[100.004,100.306], rawFormula:[0,0.31]}[name];
    assert.deepEqual(info.rawDomain, [low,high]);
    const flat = name !== "threshold" && Math.fround(low) === Math.fround(high);
    const origin = low - info.domain[0];
    if (flat) assert.equal(origin, 0);
    assert.ok(Math.fround(info.domain[1]) > Math.fround(info.domain[0]));
    for (const [i, {texture,accepted,hit}] of info.samples.entries()) {
      const sample = flat ? low : name === "threshold" ? [low,high][i] : Math.round([low,high][i]*100)/100;
      assert.ok(Math.abs(accepted-sample) < 1e-10);
      assert.equal(texture,Math.fround(accepted-origin));
      assert.ok(Math.abs(hit.elevation-sample) < 1e-4);
      const span = ["relative","relativeSmall","threshold","fractional","roundNear","roundFlat","roundRaised"].includes(name) ? 2 : 12;
      const vertical = projects[name].zScale*12/span;
      const translation = {lifted:0.5, roundRaised:0.46875, rawFormula:-0.04}[name] ?? 0;
      const expectedY = (sample - low)*vertical + translation;
      const gpuY = (Math.max(Math.fround(info.clamp[0]), Math.min(Math.fround(info.clamp[1]), texture))
        - Math.fround(info.domain[0]))*vertical + translation;
      Object.assign(info.samples[i], {expectedY, gpuY});
      assert.ok(Math.abs(gpuY - expectedY) <= 1e-4, `${name} plateau ${i} GPU Y`);
      assert.ok(Math.abs(hit.worldPosition[1] - expectedY) <= (name === "fractional" ? 1e-6 : 1e-4), `${name} plateau ${i} query Y`);
    }
  }
  const difference = (a,b) => {
    assert.equal(a.length, b.length);
    return a.reduce((count,v,i) => count + Number(v !== b[i]),0);
  };
  assert.deepEqual(report.datum.upperRounded.size, report.datum.rawFormula.size);
  report.datum.upperRoundedVsFormula = difference(masks.upperRounded, masks.rawFormula);
  assert.equal(report.datum.upperRoundedVsFormula, 0, "Rounded plateaux must render at the raw-elevation formula heights");
  report.datum.collapsedVsFlat = difference(masks.collapsed,masks.level);
  report.datum.collapsedVsLifted = difference(masks.collapsed,masks.lifted);
  assert.equal(report.datum.collapsedVsFlat,0);
  assert.ok(report.datum.collapsedVsLifted > 0);
  report.datum.roundNearVsFlat = difference(masks.roundNear, masks.roundFlat);
  report.datum.roundNearVsRaised = difference(masks.roundNear, masks.roundRaised);
  report.datum.fractionalVsRelative = difference(masks.fractional, masks.relative);
  assert.equal(report.datum.roundNearVsFlat, 0);
  assert.ok(report.datum.roundNearVsRaised > 0);
  assert.equal(report.datum.fractionalVsRelative, 0);
  report.datum.thresholdVsFlat = difference(masks.threshold,masks.roundFlat);
  report.datum.thresholdVsRelief = difference(masks.threshold,masks.relativeSmall);
  assert.ok(report.datum.thresholdVsFlat > 0);
  assert.equal(report.datum.thresholdVsRelief, 0);
}

async function requestDenseGrid(cdp, until) {
  await cdp.evaluate('document.querySelector(\'[role="treeitem"]:has(.tree-icon--terrain) .tree-name\').click()');
  await until(cdp,'!!document.querySelector(\'.props__rail [title^="Object:"]\')');
  await cdp.evaluate('document.querySelector(\'.props__rail [title^="Object:"]\').click()');
  await until(cdp,'[...document.querySelectorAll("label.field")].some(el=>el.textContent.includes("Solid mesh"))');
  await cdp.evaluate(`(() => { const slider=[...document.querySelectorAll("label.field")].find(el=>el.textContent.includes("Solid mesh")).querySelector("input");
     Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(slider,256); slider.dispatchEvent(new Event("input",{bubbles:true})); })()`);
}

const fixedViewport = `(function () {
    const style = new CSSStyleSheet();
    style.replaceSync(".viewport {box-sizing:content-box!important;width:256px!important;height:256px!important;min-height:256px!important;flex:none!important}");
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, style];
})()`;
const limitedBudget = `window.vp04LimitBudget = async () => {
    const {Forge3DRuntime}=await import("/forge3d-web/forge3d_web.js");
    const create=Forge3DRuntime.create;
    Forge3DRuntime.create=function(canvas, options) { return create.call(this,canvas,{...options,memoryBudgetBytes:2*1024*1024}); };
}`;

export async function checkAdmission(cdp, fixture, loadProject, until, report) {
  // Pin just this fixture's host so sidebar layout cannot change depth allocation
  // while the 2 MiB runtime admits the requested terrain.
  const {identifier} = await cdp.send("Page.addScriptToEvaluateOnNewDocument",{source:fixedViewport + ";" + limitedBudget});
  await loadProject(cdp,fixture,true);
  const readOverlay = async () => {
    await until(cdp,`(async () => {
      const d = window.forge3dViewportDiagnostics?.(), runtime = d?.runtime;
      const web = d?.terrainViewport.diagnosticRuntime, submission = d?.terrainViewport.diagnosticSubmission;
      if (submission?.projectId !== ${JSON.stringify(fixture.id)} || !web || !runtime?.overlay.children.length ||
          !document.querySelector(".cartography-label--feature")) return false;
      const terrain = d.frame.terrains.get(submission.terrain?.objectId);
      const mesh = terrain && runtime.objects.get(terrain.request.objectId)?.children.find(o => o.userData.forgeTerrain === terrain);
      const query = d.queryTerrain(0,0);
      if (!query || !mesh) return false;
      // A read can defer the next presentation. Capture the query and the
      // corresponding editor geometry synchronously while this frame is visible.
      const line = runtime.overlay.children[0];
      const world = line.localToWorld(runtime.camera.position.clone().fromBufferAttribute(line.geometry.attributes.instanceStart,0));
      const p = terrain.preview;
      const state = {resolution:p.resolution, rawMin:p.minElevation, rawMax:p.maxElevation, adoptedHeight:p.heights[0],
        gpuDatum:Math.fround(vp04Calls.setTerrain.domain[0]), line:world.toArray(), meshY:mesh.geometry.attributes.position.getY(0),
        query, status:document.querySelector("[data-viewport-backend]").textContent, budget:web.getMemoryReport().budgetBytes, size:[web.width,web.height]};
      const read = await web.readTerrainHeights();
      if (read.length !== p.resolution ** 2) throw Error("Submitted grid and height readback differ");
      window.vp04AdmissionSnapshot = {...state, gpuHeight:read[0]};
      return true;
    })()`);
    return cdp.evaluate("window.vp04AdmissionSnapshot");
  };
  report.flatAdmission={before:await readOverlay()};
  await requestDenseGrid(cdp, until);
  await until(cdp,'forge3dViewportDiagnostics().terrainViewport.diagnosticSubmission?.requestedTerrainResolution === 256 && !![...forge3dViewportDiagnostics().frame.terrains.values()][0]?.admission');
  report.flatAdmission.after=await readOverlay();
  assert.equal(report.flatAdmission.before.resolution,96);
  assert.ok(report.flatAdmission.after.resolution < 256 && report.flatAdmission.after.resolution > 96);
  await cdp.send("Page.removeScriptToEvaluateOnNewDocument",{identifier});
  for (const state of Object.values(report.flatAdmission)) {
    assert.deepEqual(state.size,[256,256]);
    assert.equal(state.budget,2*1024*1024);
    assert.equal(state.gpuHeight,Math.fround(3210.1234));
    assert.equal(state.gpuDatum,state.gpuHeight);
    assert.equal(state.adoptedHeight,3210.1234);
    assert.equal(state.query.elevation,3210.1234);
    assert.equal(state.meshY,0);
    assert.deepEqual(state.query.worldPosition,[0,0,0]);
    assert.ok(Math.abs(state.line[1] - 0.02) < 1e-7);
  }
}

// Both rasters have an exact 2:1 aspect ratio. Their longest side rounds in
// opposite directions if it is multiplied by six before division.
export async function checkExactEdges(cdp, projects, loadProject, until) {
  const results = {};
  for (const [name, span, halfX, north, south] of [
    ["edgeShort", [171.2,85.6], 6,-3,3], ["edgeWide", [25.1,12.55], 6,-3,3],
    ["scaledMiss", [84,61], 42,-30.5,30.5], ["scaledLeak", [42,29], 42,-29,29],
    ["translatedNorth", [5,2], 6,0.6,5.4], ["bryce", [4000,3800], 6,-5.7,5.7],
  ]) {
    await loadProject(cdp, projects[name], true);
    if (halfX === 42) {
      const seq = await cdp.evaluate("forge3dViewportDiagnostics().terrainViewport.diagnosticSubmission.sequence");
      await cdp.evaluate("forge3dViewportDiagnostics().setOrbitPose([95,80,100],[0,4,0])");
      await until(cdp, "forge3dViewportDiagnostics().terrainViewport.diagnosticSubmission.sequence > " + seq);
    }
    const result = await cdp.evaluate(`(async () => {
      const d = forge3dViewportDiagnostics(), web = d.terrainViewport.diagnosticRuntime;
      const terrain = [...d.frame.terrains.values()][0];
      const object = d.frame.objects.find(o => o.id === terrain.request.objectId);
      const {terrainTransform,terrainSamplePoint,runtimeToStudio} = await import("/src/viewport/forge3dWebMapping.ts");
      const tr = terrainTransform(terrain.preview, object.translation, object.scale[0]);
      const rgba = await web.readRgba();
      const bits = new DataView(new ArrayBuffer(8));
      function adjacent(v, direction) {
        bits.setFloat64(0,v);
        bits.setBigUint64(0,bits.getBigUint64(0) + BigInt(Math.sign(v) * direction));
        return bits.getFloat64(0);
      }
      const corners = [[-1,-1],[1,-1],[-1,1],[1,1]].map(([sx,sz]) => {
        const x = sx * ${halfX}, z = sz < 0 ? ${north} : ${south}, last = terrain.preview.resolution-1;
        const [fx,,fz] = runtimeToStudio(terrainSamplePoint(terrain.preview, terrain.zScale, sz < 0 ? 0 : last, sx < 0 ? 0 : last), tr);
        return {x, z, forward:[fx,fz], forwardHit:d.queryTerrain(fx,fz), hit:d.queryTerrain(x,z),
          inward:d.queryTerrain(x-sx*1e-8,z-sz*1e-8),
          outsideX:d.queryTerrain(adjacent(x,sx),z) ?? null, outsideZ:d.queryTerrain(x,adjacent(z,sz)) ?? null};
      });
      return {span:terrain.preview.spanXz, covered:rgba.filter((v,i) => i%4 === 3 && v).length, corners};
    })()`);
    assert.deepEqual(result.span, span);
    assert.ok(result.covered > 0);
    for (const [i, corner] of result.corners.entries()) {
      const height = (name === "bryce" ? [2444.75,2168.320068359375,2448.43994140625,2155.840087890625] : [11,14,17,22])[i];
      assert.deepEqual(corner.forward, [corner.x, corner.z], name + " forward corner");
      assert.deepEqual(corner.forwardHit, corner.hit);
      assert.ok(corner.hit, `${name} missed (${corner.x}, ${corner.z})`);
      assert.ok(Math.abs(corner.hit.elevation - height) < 1e-8);
      assert.ok(Math.abs(corner.inward.elevation - height) < 1e-4);
      assert.equal(corner.outsideX, null);
      assert.equal(corner.outsideZ, null);
    }
    results[name] = result;
  }
  return results;
}

export async function checkRetainedCorner(cdp, fixture, loadProject, until) {
  const result = {};
  const hasLine = fixture.raster === "twoPlateaux";
  for (const [name,n] of [["full",256],["reduced",148]]) {
    const source = name === "full" ? fixedViewport : fixedViewport + ";" + limitedBudget;
    const {identifier} = await cdp.send("Page.addScriptToEvaluateOnNewDocument", {source});
    try {
      await loadProject(cdp,fixture,true);
      await requestDenseGrid(cdp,until);
      await until(cdp,`(() => {
        const d = forge3dViewportDiagnostics(), frame = d.terrainViewport.diagnosticSubmission;
        const terrain = d.frame?.terrains.get(frame?.terrain?.objectId);
        return frame?.projectId === ${JSON.stringify(fixture.id)} && frame.terrain?.resolution === ${n} && !!d.queryTerrain(-6,-3)
          && terrain?.preview.resolution === ${n}
          && !!d.runtime.objects.get(terrain.request.objectId)?.children.find(m => m.userData.forgeTerrain === terrain)
          && ${hasLine ? "!!d.runtime.overlay.children.length" : "true"}
          && ${n === 256 ? "true" : "frame.requestedTerrainResolution === 256"};
      })()`);
      result[name] = await cdp.evaluate(`(async () => {
        const d = forge3dViewportDiagnostics(), web = d.terrainViewport.diagnosticRuntime;
        const terrain = [...d.frame.terrains.values()][0], {preview,heightOrigin} = terrain;
        const mesh = d.runtime.objects.get(terrain.request.objectId).children.find(m => m.userData.forgeTerrain === terrain);
        const line = d.runtime.overlay.children[0];
        const lineStart = line && line.localToWorld(d.runtime.camera.position.clone().fromBufferAttribute(line.geometry.attributes.instanceStart,0)).toArray();
        const hit = d.queryTerrain(-6,-3), meshY = mesh.geometry.attributes.position.getY(0), texture = await web.readTerrainHeights();
        return {size:[web.width,web.height], resolution:preview.resolution, domain:vp04Calls.setTerrain.domain,
          origin:heightOrigin, accepted:preview.heights[0], texture:texture[0], levels:[...new Set(texture)], hit, meshY, lineStart};
      })()`);
      const row = result[name];
      assert.deepEqual(row.size,[256,256]);
      assert.equal(row.resolution,n);
      assert.equal(row.accepted,4150.24);
      assert.equal(row.texture,Math.fround(4150.24 - row.origin));
      assert.equal(row.texture,Math.fround(row.domain[0]));
      assert.equal(row.hit.elevation,row.origin + row.texture);
      assert.deepEqual(row.hit.worldPosition,[-6,0,-3]);
      assert.equal(row.meshY, 0, `${fixture.raster} ${name} editor corner Y`);
      if (hasLine) {
        assert.equal(row.lineStart[0], -6);
        assert.equal(row.lineStart[2], -3);
        assert.ok(Math.abs(row.lineStart[1] - 0.96) < 1e-6, `${name} northwest drape lift`);
      }
    } finally { await cdp.send("Page.removeScriptToEvaluateOnNewDocument",{identifier}); }
  }
  assert.equal(result.full.origin, result.reduced.origin);
  if (!hasLine) {
    assert.deepEqual(result.full.levels,[0,Math.fround(0.01),1]);
    assert.deepEqual(result.reduced.levels,[0,1]);
    assert.equal(result.reduced.origin,4150.24);
  }
  return result;
}
