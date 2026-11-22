import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sampleStudio } from "./page.mjs";
import { checkPlacement, projector } from "./projection.mjs";

export async function setVerticalScale(cdp, until, value) {
  const input = '[...document.querySelectorAll("label")].find(el => el.textContent === "Vertical scale")?.querySelector("input")';
  await until(cdp, `!!(${input})`);
  await cdp.evaluate(`{ const el = ${input}; el.focus(); el.select(); }`);
  await cdp.send("Input.insertText", { text: String(value) });
  await cdp.evaluate("document.activeElement.blur()");
  await until(cdp, "forge3dViewportDiagnostics().terrainViewport.diagnosticSubmission?.terrain?.zScale === " + value);
}

async function setPose(cdp, until, eye, aim) {
  const before = await cdp.evaluate("forge3dViewportDiagnostics().terrainViewport.diagnosticSubmission.sequence");
  await cdp.evaluate(`forge3dViewportDiagnostics().setOrbitPose(${JSON.stringify(eye)},${JSON.stringify(aim)})`);
  await until(cdp, "forge3dViewportDiagnostics().terrainViewport.diagnosticSubmission.sequence > " + before);
}

// View the isolated peak from the south with the lens level with its tip.
// Align the tip with a pixel column's centre so the first covered pixel in
// that column measures the actual peak independently of terrain telemetry.
async function peakSilhouette(cdp, until, points, data, path) {
  const peak = points[4].position;
  const distance = 6;
  const studioUnitsPerPixel = 2 * distance * Math.tan(data.camera.fovYDegrees * Math.PI / 360) / data.size.height;
  const x = peak[0] - (data.size.width % 2 === 0 ? studioUnitsPerPixel / 2 : 0);
  await setPose(cdp, until, [x, peak[1], peak[2] + distance], [x, peak[1], peak[2]]);
  try {
    const capture = await cdp.evaluate(`(${sampleStudio})(${JSON.stringify(points)})`);
    const { width, height } = capture.size;
    const expected = projector(capture.camera, width, height)(peak);
    const col = Math.floor(expected[0]);
    const mask = Buffer.from(capture.mask, "base64");
    await writeFile(path, mask);
    assert.equal(mask.length, width * height);
    assert.ok(col >= 0 && col < width && expected[1] > 0 && expected[1] < height);
    let row = 0;
    while (row < height && !mask[row * width + col]) row++;
    assert.ok(row > 0 && row < height, "Sky and terrain must both be visible along the peak column");
    const pixel = [col + 0.5, row + 0.5];
    return { size: capture.size, camera: capture.camera, expected, pixel, errorPx: Math.hypot(pixel[0]-expected[0], pixel[1]-expected[1]) };
  } finally { await setPose(cdp, until, data.camera.eye, data.camera.aim.orbitTarget); }
}

function checkPeakSilhouette(peak) {
  assert.ok(peak.errorPx <= 1, `Rendered peak error ${peak.errorPx} px`);
}

export async function checkExaggeration(cdp, until, points, correct, out) {
  const goodPeak = await peakSilhouette(cdp, until, points, correct, join(out, "peak-scale3.mask"));
  checkPeakSilhouette(goodPeak);
  await setVerticalScale(cdp, until, 1);
  const sample = () => cdp.evaluate(`(${sampleStudio})(${JSON.stringify(points)})`);
  const scaleOne = await sample();
  assert.equal(scaleOne.exaggeration, 1);
  assert.notEqual(scaleOne.rgbaSha256, correct.rgbaSha256, "Changing exaggeration must change the rendered frame");
  await cdp.evaluate(`(async () => {
    const {Forge3DRuntime} = await import("/forge3d-web/forge3d_web.js");
    const p = Forge3DRuntime.prototype, original = p.setTerrain;
    window.vp04RestoreTerrain = () => { p.setTerrain = original; delete window.vp04RestoreTerrain; };
    p.setTerrain = function (terrain) { return original.call(this, {...terrain, exaggeration: 1}); };
  })()`);
  try {
    await setVerticalScale(cdp, until, 3);
    const bad = await sample();
    assert.equal(bad.exaggeration, 1);
    assert.deepEqual(bad.size, scaleOne.size);
    assert.equal(bad.rgbaSha256, scaleOne.rgbaSha256, "The injected frame must reproduce the scale-1 framebuffer");
    assert.equal(bad.heightSha256, correct.heightSha256);
    assert.throws(() => checkPlacement("stale exaggeration", bad, points), /projection error/);
    assert.ok(bad.landmarks[4].errorPx > 1);
    const badPeak = await peakSilhouette(cdp, until, points, correct, join(out, "peak-native-scale1.mask"));
    assert.throws(() => checkPeakSilhouette(badPeak), /Rendered peak error/);
    return { requested: 3, submitted: bad.exaggeration, scaleOneRgba: scaleOne.rgbaSha256, injectedRgba: bad.rgbaSha256,
      scaleThreeRgba: correct.rgbaSha256, covered: bad.count, landmarks: bad.landmarks, correctPeak: goodPeak, injectedPeak: badPeak };
  } finally { await cdp.evaluate("vp04RestoreTerrain()"); }
}
