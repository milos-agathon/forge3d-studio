import assert from "node:assert/strict";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { until } from "../viewport-desktop.mjs";

// A 256x256 noise mask repeated three times on a glTF quad. At a grazing
// angle the mip-filtered alpha crosses its cutoff between derivative quads.
export async function mipmappedCutoutControl(cdp, { root, dir, openBryce, observeSelection, coords, record }) {
  const file = fileURLToPath(new URL("./mip-cutout.glb", import.meta.url));
  const project = JSON.parse(await readFile(join(root, "samples/cube-animation.studio3d")));
  const mesh = project.scene.objects.find(object => object.kind.type === "mesh");
  const assetId = "069a0bbb-b5ac-428c-a76a-9fa68f49e324";
  mesh.kind.source = { type:"gltf", asset:assetId, node:null };
  mesh.transform = {translation:{x:0,y:0,z:0}, rotationDeg:{x:0,y:82,z:0}, scale:{x:1,y:1,z:1}};
  project.scene.objects = [mesh];
  project.scene.activeCamera = null;
  project.selection = [];
  project.assets = [{id:assetId, name:"mip-cutout.glb", kind:"glb", path:file, byteSize:(await stat(file)).size}];
  project.cartography = [];
  project.timeline.tracks = [];
  Object.assign(project.viewport, {gridVisible:false, mode:"material"});
  Object.assign(project.render, {shadows:false, sunVisibility:false});
  const fixture = join(dir, "mip-cutout.studio3d");
  await writeFile(fixture, JSON.stringify(project));
  await cdp.evaluate('localStorage.setItem("studio.viewport.renderer","three")');
  await openBryce(cdp, fixture);
  const diagnostics = "forge3dViewportDiagnostics()";
  await cdp.evaluate(diagnostics + ".setOrbitPose([0,0,20],[0,0,0])");
  await until(cdp, `${diagnostics}.runtime?.renderer.domElement.height === 727 &&
    ${diagnostics}.runtime.objects.get("${mesh.id}")?.getObjectByProperty("isMesh",true)?.material?.map?.image?.width === 256`);
  await observeSelection();
  const raf = "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))";
  async function checkPixels(label, cases, width, height) {
    await cdp.evaluate(raf);
    const frame = await cdp.evaluate(`(() => {
      const {scene, renderer, camera, objects} = ${diagnostics}.runtime;
      const gl = renderer.getContext(), mesh = objects.get("${mesh.id}");
      const viewport = [...gl.getParameter(gl.VIEWPORT)];
      const sample = () => {
        renderer.render(scene, camera);
        return ${JSON.stringify(cases)}.map(([x,y]) => {
          const rgba = new Uint8Array(4);
          gl.readPixels(x, gl.drawingBufferHeight - 1 - y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
          return [...rgba];
        });
      };
      const visible = sample();
      try {
        mesh.visible = false;
        return {visible, hidden:sample(), viewport, buffer:[gl.drawingBufferWidth,gl.drawingBufferHeight]};
      } finally {
        mesh.visible = true;
        renderer.render(scene, camera);
      }
    })()`);
    const viewport = [0,0,width,height];
    assert.deepEqual(frame.buffer, [width,height], label + " drawing buffer");
    assert.deepEqual(frame.viewport, viewport, label + " viewport before picking");
    for (const [i, [x, y, kind]] of cases.entries()) {
      const pixel = [x, y], covered = kind === "surface";
      const check = covered ? assert.notDeepEqual : assert.deepEqual;
      check(frame.visible[i], frame.hidden[i], label + " framebuffer coverage at " + pixel);
      const selected = covered ? [mesh.id] : [];
      await cdp.click(await coords(pixel));
      await until(cdp, "selectionCalls.length === 1");
      await cdp.evaluate(raf);
      await record(label + " " + kind, pixel,
        selected[0] ?? null, selected, [selected], undefined, "three.js");
      const restored = await cdp.evaluate(`(() => {
        const renderer = ${diagnostics}.runtime.renderer, gl = renderer.getContext();
        return renderer.getRenderTarget() === null && [...gl.getParameter(gl.VIEWPORT)];
      })()`);
      assert.deepEqual(restored, viewport, label + " restored viewport at " + pixel);
    }
  }
  await checkPixels("mipmapped cutout", [[389,268,"surface"],[423,382,"opening"]], 794,727);

  const metrics = await cdp.evaluate("({width:innerWidth,height:innerHeight,deviceScaleFactor:devicePixelRatio,mobile:false})");
  try {
    await cdp.send("Emulation.setDeviceMetricsOverride", {...metrics, deviceScaleFactor:1.25});
    for (const width of [790,794]) {
      await cdp.evaluate(`document.querySelector(".viewport").style.width = "${width}px"`);
      await until(cdp, `${diagnostics}.frame.dimensions.width === ${Math.floor(width * 1.25)} &&
        ${diagnostics}.frame.dimensions.height === 908`);
    }
    await checkPixels("resized mipmapped cutout at DPR 1.25", [
      [528,456,"opening"], [525,498,"opening"], [433,309,"opening"], [521,562,"opening"],
      [498,306,"surface"], [472,560,"surface"],
    ], 992,908);
  } finally {
    await cdp.send("Emulation.setDeviceMetricsOverride", metrics);
  }
}
