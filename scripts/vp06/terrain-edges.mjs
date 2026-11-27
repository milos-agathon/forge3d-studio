import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Camera } from "@forge3d/web";
import { TERRAIN_ID } from "../vp01/fixture.mjs";
import { until } from "../viewport-desktop.mjs";

const diagnostics = "forge3dViewportDiagnostics()";
const submission = diagnostics + ".terrainViewport.diagnosticSubmission";
const raf = "new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))";

export async function terrainEdgeControl(cdp, bryce, flat, report) {
  await cdp.send("Emulation.setDeviceMetricsOverride", { width:1440, height:833, deviceScaleFactor:1, mobile:false });
  for (const [name, source, height, poses] of [
    ["Bryce", bryce, 794, [
      {eye:[9.5,7,11], aim:[3.487943814610962,3.0763422790092587,4.038671785339008],
        samples:[[137,319,false],[254,640,false],[138,319,true]]},
    ]],
    ["flat", flat, 727, [
      {eye:[0,50.8730837524357,.00001], aim:[0,0,0], samples:[[500,363,false]]},
      {eye:[0,50.873771895420745,.00001], aim:[0,0,0], samples:[[293,363,true]]},
    ]],
  ]) {
    const fixture = JSON.parse(await readFile(source));
    fixture.selection = [];
    fixture.viewport.mode = "solid";
    for (const obj of fixture.scene.objects) obj.visible = obj.id === TERRAIN_ID;
    const path = join(dirname(source), name + "-terrain-edges.studio3d");
    await writeFile(path, JSON.stringify(fixture));
    await cdp.evaluate(`__TAURI_INTERNALS__.invoke("open_project", {path:${JSON.stringify(path)}})`);
    await cdp.evaluate("window.leaving = true");
    await cdp.send("Page.reload", { ignoreCache:true });
    await until(cdp, "!window.leaving && !!window.forge3dViewportDiagnostics");
    await cdp.evaluate(`document.querySelector('.recovery button[aria-label="Dismiss"]')?.click();
      Object.assign(document.querySelector(".viewport").style, {boxSizing:"content-box", flex:"none", width:"794px", height:"${height}px"});
      window.edgeSelections = [];
      const previousFetch = window.fetch;
      window.fetch = function(resource, init) {
        const url = new URL(resource instanceof Request ? resource.url : resource, location.href);
        if (url.hostname === "ipc.localhost" && url.pathname === "/set_selection") edgeSelections.push(JSON.parse(init.body).ids);
        return previousFetch.apply(this, arguments);
      };`);
    const click = async ([x, y]) => {
      const coords = await cdp.evaluate(`(() => {
        const rect = document.querySelector(".viewport-canvas--terrain").getBoundingClientRect();
        return [rect.left+(${x}+.5)*rect.width/794, rect.top+(${y}+.5)*rect.height/${height}];
      })()`);
      await cdp.evaluate("edgeSelections.length = 0");
      await cdp.click(coords);
      await until(cdp, `edgeSelections.length === 1 && ${diagnostics}.lastPick?.pixel.join() === "${x},${y}"`);
      await cdp.evaluate(raf);
    };
    for (const mode of ["solid", "material"]) {
      if (mode === "material") await cdp.evaluate(`document.querySelector('button[title^="Material preview"]').click()`);
      await until(cdp, `${submission}?.width === 794 && ${submission}.height === ${height}
        && ${submission}.visibleIds.join() === "${TERRAIN_ID}" && ${diagnostics}.frame.settings.mode === "${mode}"
        && document.querySelector("[data-viewport-backend]").textContent.includes("WebGPU available")`);
      for (const {eye, aim, samples} of poses) {
        await cdp.evaluate(`${diagnostics}.setOrbitPose(${JSON.stringify(eye)}, ${JSON.stringify(aim)})`);
        await until(cdp, `${submission}?.camera.position.every((v,i) =>
          Math.abs(v * ${submission}.placement.scale + ${submission}.placement.translation[i] - ${JSON.stringify(eye)}[i]) < .0001)`);
        await cdp.evaluate(raf);
        await click([80,94]);
        await until(cdp, submission+".selectionBoxes.length===0");
        const state = await cdp.evaluate(submission);
        const colours = await cdp.evaluate(`(async () => {
          const rgba = await ${diagnostics}.terrainViewport.diagnosticRuntime.readRgba();
          return ${JSON.stringify(samples)}.map(([x,y]) => Array.from(rgba.subarray((y*794+x)*4, (y*794+x+1)*4)));
        })()`);
        for (const [i, [x, y, covered]] of samples.entries()) {
          const pixel = [x,y], expected = covered ? TERRAIN_ID : null;
          assert.equal(colours[i][3] > 0, covered, name + " framebuffer coverage at " + pixel);
          await click(covered ? [80,94] : [397,398]);
          await click(pixel);
          const observed = await cdp.evaluate(`(async () => ({
            actual:${diagnostics}.lastPick.hit ?? null, calls:edgeSelections,
            selected:(await __TAURI_INTERNALS__.invoke("project_state")).project.selection,
            rows:[...document.querySelectorAll('[role=treeitem][aria-selected=true]')].map(row=>row.dataset.objectId),
          }))()`);
          assert.equal(observed.actual?.id ?? null, expected);
          const ids = covered ? [TERRAIN_ID] : [];
          assert.deepEqual(observed.selected, ids);
          assert.deepEqual(observed.rows, ids);
          assert.deepEqual(observed.calls, [ids]);
          let projected;
          if (covered) {
            const hit = observed.actual;
            assert.equal(hit.frameRevision, state.sequence);
            assert.ok(Number.isFinite(hit.elevation));
            if (name === "flat") assert.equal(hit.elevation, 2000);
            const runtimePoint = hit.worldPosition.map((v,i) => (v-state.placement.translation[i])/state.placement.scale);
            projected = new Camera(state.camera).worldToScreen(runtimePoint,state);
            assert.ok(Math.hypot(projected.x-x-.5, projected.y-y-.5) < .001);
          }
          report.clicks.push({ label:name + " terrain silhouette", mode, backend:"forge3d-web", dpr:1, pixel,
            expected, ...observed, projected, frameRevision:state.sequence, disposition:"applied", rgba:colours[i] });
        }
      }
    }
  }
}
