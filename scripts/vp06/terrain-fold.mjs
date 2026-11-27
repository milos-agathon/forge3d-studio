import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { CUBE_ID, TERRAIN_ID } from "../vp01/fixture.mjs";
import { until } from "../viewport-desktop.mjs";

// Distances from unprojecting the displayed WebGPU depth at the pixel centres
// with each object isolated. One 24-bit depth step spans 0.000165–0.000217
// Studio units here. Allow two steps for depth quantization and rounding.
const samples = [
  { pixel:[340,387], owner:TERRAIN_ID, terrainDistance:11.778358, cubeDistance:12.482157 },
  { pixel:[340,386], owner:CUBE_ID, terrainDistance:13.479332, cubeDistance:12.481551 },
];
const pixels = samples.map(sample => sample.pixel);
const diagnostics = "forge3dViewportDiagnostics()";
const submission = diagnostics + ".terrainViewport.diagnosticSubmission";

export async function terrainFoldControl(cdp, { fixture, path, openFile, settle, toggle, colours, click, report }) {
  const scene = structuredClone(fixture);
  scene.selection = [];
  scene.viewport.mode = "solid";
  for (const obj of scene.scene.objects) obj.visible = obj.id === CUBE_ID || obj.id === TERRAIN_ID;
  const cube = scene.scene.objects.find(obj => obj.id === CUBE_ID);
  cube.transform.translation = { x:-1.9488649369237582, y:.7063403638791527, z:-.7193590198779843 };
  cube.transform.scale = { x:.1, y:.1, z:.1 };
  const file = join(dirname(path), "bryce-terrain-fold.studio3d");
  await writeFile(file, JSON.stringify(scene));

  await cdp.send("Emulation.setDeviceMetricsOverride", { width:1440, height:833, deviceScaleFactor:1, mobile:false });
  await cdp.evaluate('Object.assign(document.querySelector(".viewport").style,{width:"794px",height:"794px"})');
  await openFile(file);
  await settle("solid", [CUBE_ID,TERRAIN_ID]);
  await cdp.evaluate(`${diagnostics}.setOrbitPose([8,1.35,7],[0,.7,0])`);
  await until(cdp, `${submission}?.width === 794 && ${submission}.height === 794 &&
    ${submission}.camera.position.every((v,i) => Math.abs(v*${submission}.placement.scale +
      ${submission}.placement.translation[i] - [8,1.35,7][i]) < .00001)`);

  async function check(label, sample, id) {
    await click(label, sample.pixel, id, [id]);
    const row = report.clicks.at(-1);
    row.expectedDistance = id === TERRAIN_ID ? sample.terrainDistance : sample.cubeDistance;
    assert.ok(Math.abs(row.actual.distance - row.expectedDistance) <= .00044, JSON.stringify(row));
    if (id === TERRAIN_ID) assert.ok(Number.isFinite(row.actual.elevation), JSON.stringify(row));
    else assert.ok(!("elevation" in row.actual), JSON.stringify(row));
  }

  report.terrainFold = {};
  for (const mode of ["solid", "material"]) {
    if (mode === "material") await cdp.evaluate('document.querySelector(\'button[title^="Material preview"]\').click()');
    await settle(mode, [CUBE_ID,TERRAIN_ID]);
    await click("clear fold selection before colour control", [80,94], null, []);
    const both = await colours(pixels);

    await toggle(CUBE_ID);
    await settle(mode, [TERRAIN_ID]);
    const terrainOnly = await colours(pixels);
    for (const sample of samples) await check("Bryce fold, cube hidden", sample, TERRAIN_ID);

    await toggle(CUBE_ID);
    await settle(mode, [CUBE_ID,TERRAIN_ID]);
    await toggle(TERRAIN_ID);
    await settle(mode, [CUBE_ID]);
    const cubeOnly = await colours(pixels);
    for (const sample of samples) await check("Bryce fold, terrain hidden", sample, CUBE_ID);

    await toggle(TERRAIN_ID);
    await settle(mode, [CUBE_ID,TERRAIN_ID]);
    await click("clear fold selection before restored colour control", [80,94], null, []);
    assert.deepEqual(await colours(pixels), both);
    for (const [i, sample] of samples.entries()) {
      assert.notEqual(terrainOnly[i], cubeOnly[i]);
      assert.equal(both[i], sample.owner === TERRAIN_ID ? terrainOnly[i] : cubeOnly[i]);
      await check("Bryce fold, both visible", sample, sample.owner);
    }
    report.terrainFold[mode] = { pixels, both, terrainOnly, cubeOnly };
  }
}
