import assert from "node:assert/strict";
import { until } from "../viewport-desktop.mjs";
import { CUBE_ID } from "../vp01/fixture.mjs";

export async function touchGestures(cdp, { coords, record, resetPose, sky }) {
  const diagnostics = "forge3dViewportDiagnostics()";
  const stableCamera = () => cdp.evaluate(`new Promise(done => {
    let last, stable = 0;
    function tick() {
      const frame = ${diagnostics}.frame;
      stable = frame === last ? stable + 1 : 0;
      last = frame;
      if (stable >= 12) done(); else requestAnimationFrame(tick);
    }
    tick();
  })`);
  const touch = (type, touchPoints) => cdp.send("Input.dispatchTouchEvent", { type, touchPoints });
  const [x, y] = await coords(sky);
  await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 2 });
  await cdp.evaluate(`window.touchReleases = [];
    window.observeTouchRelease = e => { if (e.pointerType === "touch") touchReleases.push(e.isPrimary); };
    document.addEventListener("pointerup", observeTouchRelease, true)`);
  try {
    await cdp.evaluate(`document.querySelector('[data-object-id="${CUBE_ID}"] .tree-name').click()`);
    await until(cdp, `selectionCalls.length === 1 && document.querySelector('[data-object-id="${CUBE_ID}"]').getAttribute("aria-selected") === "true"`);
    await cdp.evaluate("selectionCalls.length = 0");
    for (const primaryFirst of [true, false]) {
      await resetPose();
      await stableCamera();
      const z = await cdp.evaluate(diagnostics + ".runtime.camera.position.z");
      // Chromium releases contacts in ID order when the touch sequence ends.
      const first = { x, y, id: primaryFirst ? 1 : 2 };
      const second = { x: x + 50, y, id: primaryFirst ? 2 : 1 };
      await touch("touchStart", [first]);
      await touch("touchStart", [first, second]);
      await touch("touchMove", [first, { ...second, x: second.x + 64 }]);
      await until(cdp, `Math.abs(${diagnostics}.runtime.camera.position.z - (${z})) > .05`);
      await stableCamera();
      await touch("touchEnd", []);
      await stableCamera();
      assert.deepEqual(await cdp.evaluate("touchReleases.splice(0)"), [primaryFirst, !primaryFirst]);
      await record(`pinch with ${primaryFirst ? "primary" : "secondary"} finger released first`,
        sky, null, [CUBE_ID], [], undefined, "three.js");
    }
    await resetPose();
    await stableCamera();
    await touch("touchStart", [{ x, y, id: 1 }]);
    await touch("touchEnd", []);
    await until(cdp, "selectionCalls.length === 1 && !document.querySelector('[role=treeitem][aria-selected=true]')");
    await record("single tap after pinch", sky, null, [], [[]], undefined, "three.js");
  } finally {
    await cdp.evaluate('document.removeEventListener("pointerup", observeTouchRelease, true)');
    await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: false });
  }
}
