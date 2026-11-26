import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

async function selectThree(cdp, until) {
  await cdp.evaluate(`[...document.querySelectorAll(".menu__button")].find(el=>el.textContent.trim()==="View").click()`);
  const item = `[...document.querySelectorAll('[role="menuitemradio"]')].find(el=>el.textContent.includes("three.js"))`;
  await until(cdp, `!!(${item})`);
  await cdp.evaluate(`(${item}).click()`);
  await until(cdp, 'document.querySelector("[data-viewport-backend]")?.textContent.includes("View menu override")');
}

export async function checkRoundedMesh(cdp, field, until) {
  if (!field) await selectThree(cdp, until);
  const runtime = field ? "__vp01FieldDiagnostics().runtime" : "forge3dViewportDiagnostics().runtime";
  const mesh = `[...${runtime}.objects.values()].filter(g => g.visible).flatMap(g => g.children).find(c => c.userData.elevation)`;
  await until(cdp, `!!(${mesh})`);
  const heights = await cdp.evaluate(`[25,70].map(col => (${mesh}).geometry.attributes.position.getY(25*96+col))`);
  for (const [i,y] of [-0.04,3.06].entries()) {
    assert.ok(Math.abs(heights[i] - y) < 1e-4, `Rounded plateau at Y ${heights[i]} expected ${y}`);
  }
  return heights;
}

export async function checkHover(cdp, field, until, plateauReadout, backend = "three") {
  const plateau = plateauReadout !== undefined;
  const gpu = !field && backend === "webgpu";
  if (!field && !gpu) await selectThree(cdp, until);
  const runtime = field ? "__vp01FieldDiagnostics().runtime" : "forge3dViewportDiagnostics().runtime";
  const data = await cdp.evaluate(`(async () => {
    const r = ${runtime};
    const x = ${plateau ? 3 : 12*(69.5/95-.5)}, z = ${plateau ? 0 : 12*960/2688*(18.5/95-.5)};
    const eye = [x,${plateau ? 6 : 3},z+.001], aim = [x,0,z];
    if (${gpu}) forge3dViewportDiagnostics().setOrbitPose(eye, aim);
    else {
      r.camera.position.fromArray(eye);
      r.orbit.target.fromArray(aim);
      r.orbit.update();
      r.camera.updateMatrixWorld(true);
      r.needsRender = true;
    }
    await new Promise(ok => requestAnimationFrame(() => requestAnimationFrame(ok)));
    const canvas = ${gpu} ? document.querySelector(".viewport-canvas--terrain") : r.renderer.domElement, rect = canvas.getBoundingClientRect();
    const pixel = [rect.x+rect.width/2,rect.y+rect.height/2];
    if (!${gpu} && document.elementFromPoint(...pixel) !== canvas) throw Error("Hover missed the terrain canvas");
    const mesh = r && [...r.objects.values()].filter(g=>g.visible).flatMap(g=>g.children).find(m=>m.userData.elevation);
    const meshY = mesh?.geometry.attributes.position.getY(25*96+70);
    return {pixel, meshY, camera:r?.camera.position.toArray() ?? forge3dViewportDiagnostics().frame.camera.eye, aim:r?.orbit.target.toArray() ?? forge3dViewportDiagnostics().frame.camera.aim.orbitTarget,
      size:[canvas.width,canvas.height], dpr:devicePixelRatio,
      backend:document.querySelector("[data-viewport-backend]")?.textContent ?? "Field Instrument"};
  })()`);
  const [x,y] = data.pixel;
  await cdp.send("Input.dispatchMouseEvent",{type:"mouseMoved",x:x-10,y});
  await delay(120);
  await cdp.send("Input.dispatchMouseEvent",{type:"mouseMoved",x,y});
  await delay(240);
  data.cursor = await cdp.evaluate('document.querySelector(".viewport-readout__cursor dd")?.textContent');
  assert.deepEqual(data.size,[794,794]);
  assert.deepEqual(data.pixel,[680,465]);
  assert.equal(data.cursor,plateauReadout ?? "10 m");
  return data;
}
