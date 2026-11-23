import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { CUBE_ID } from "../vp01/fixture.mjs";
import { sha256 } from "../vp03/identity.mjs";
import { until } from "../viewport-desktop.mjs";
import { readFrame } from "./page.mjs";

// Repeat the Inspector and floating-origin reproductions in a blocked WebView.
export async function checkTransforms(cdp, { path, fixture, eye, state, settle, toggle, terrainName }) {
  const result = {};
  const origin = new Map();
  const frame = async () => Buffer.from(await cdp.evaluate(`(${readFrame})(false)`), "base64");
  const coverage = rgba => rgba.reduce((sum, value, i) => sum + Number(i % 4 === 3 && value > 0), 0);
  const scale = async value => {
    await cdp.evaluate(`{ const label = [...document.querySelectorAll(".group-label")].find(el => el.textContent === "Scale");
      const input = label.previousElementSibling.querySelector("input"); input.focus(); input.select(); }`);
    await cdp.send("Input.insertText", { text: String(value) });
    await cdp.evaluate("document.activeElement.blur()");
    await until(cdp, `forge3dViewportDiagnostics().frame.objects.find(o => o.id === "${CUBE_ID}").scale[0] === ${value}`);
  };
  for (const offset of [0, 4_000_000_000]) {
    const project = structuredClone(fixture);
    for (const o of project.scene.objects) o.transform.translation.x += offset;
    const file = join(dirname(path), `translated-${offset}.studio3d`);
    await writeFile(file, JSON.stringify(project));
    await cdp.evaluate(`__TAURI_INTERNALS__.invoke("open_project", {path:${JSON.stringify(file)}})`);
    await cdp.evaluate("window.vp05Leaving = true");
    await cdp.send("Page.reload", { ignoreCache: true });
    await until(cdp, "!window.vp05Leaving && document.readyState === 'complete'");
    await settle("solid", true, true);
    await cdp.evaluate(`document.querySelector('.recovery button[aria-label="Dismiss"]')?.click();
      [...document.querySelectorAll(".tree-name")].find(el => el.textContent === "VP-01 cube").click();
      document.querySelector('button[title^="Object:"]').click()`);
    await until(cdp, '[...document.querySelectorAll(".group-label")].some(el => el.textContent === "Scale")');
    // Keep the reproduction's physical framebuffer fixed across Inspector and
    // recovery-banner layout changes. Studio's normal ResizeObserver handles it.
    await cdp.evaluate(`Object.assign(document.querySelector(".viewport").style,
      {boxSizing:"content-box", flex:"none", width:"794px", height:"660px"}) && true`);
    await until(cdp, `${state}.physical.join() === "794,660"`);
    const move = ([x,y,z]) => [offset+x,y,z];
    // The VP-01 viewing ray passes through this target. Its X coordinate stays
    // exactly representable at both offsets, so byte-for-byte comparison is valid.
    const pose = [move(eye), move([0,0.8,0])];
    await cdp.evaluate(`forge3dViewportDiagnostics().setOrbitPose(...${JSON.stringify(pose)})`);
    assert.equal(await cdp.evaluate(`forge3dViewportDiagnostics().frame.objects.find(o => o.id === "${CUBE_ID}").translation[0]`), offset);
    for (const mode of ["solid", "material"]) {
      if (mode === "material") await cdp.evaluate(`document.querySelector('button[title^="Material preview"]').click()`);
      await settle(mode, true, true);
      const both = await frame();
      const row = (result[mode] ??= {})[offset] = { both: sha256(both) };
      await toggle("VP-01 cube");
      await settle(mode, false, true);
      const ground = await frame();
      await toggle("VP-01 cube");
      await settle(mode, true, true);
      if (offset === 0) {
        await cdp.evaluate("window.vp05ScaleOwner = forge3dViewportDiagnostics().terrainViewport.diagnosticRuntime");
        await scale(0);
        await settle(mode, true, true);
        const flat = await frame();
        assert.ok(await cdp.evaluate("vp05ScaleOwner === forge3dViewportDiagnostics().terrainViewport.diagnosticRuntime"));
        let flatPixels = 0, terrainPixels = 0;
        for (let i = 0; i < flat.length; i += 4) {
          if (!flat.subarray(i,i+4).equals(ground.subarray(i,i+4))) {
            flatPixels++;
            assert.ok(!both.subarray(i,i+4).equals(ground.subarray(i,i+4)), "Flat cube escaped the original silhouette");
          } else if (ground[i+3]) terrainPixels++;
        }
        assert.ok(flatPixels > 0 && terrainPixels > 0, "Flattening must retain both visible surfaces");
        await scale(1);
        await settle(mode, true, true);
        row.flat = { sha256: sha256(flat), flatPixels, terrainPixels, restored: sha256(await frame()) };
        assert.equal(row.flat.restored, row.both);
      }
      await toggle(terrainName);
      await settle(mode, true, false);
      const alone = await frame();
      const s = await cdp.evaluate(state);
      assert.deepEqual(s.camera.slice(0,2), pose);
      assert.deepEqual(s.physical, [794,660]);
      assert.equal(s.stats.visibleInstances, 1);
      assert.equal(s.stats.effectiveDraws, 1);
      row.cubeOnly = { sha256: sha256(alone), pixels: coverage(alone), camera: s.camera, stats: s.stats };
      assert.ok(row.cubeOnly.pixels > 0);
      if (offset === 0) origin.set(mode, row.cubeOnly.sha256);
      else assert.equal(row.cubeOnly.sha256, origin.get(mode), "Translating the camera and cube changed the cube-only framebuffer");
      await toggle(terrainName);
      await settle(mode, true, true);
    }
  }
  return result;
}
