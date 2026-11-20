// Open Bryce in Solid or Material mode in a Studio dev build. Turn off Sun shadows and
// Terrain sun shadows so Auto activates forge3d-web. Run at the display scale under test.
// Add --imagery-and-sky to require the Material fixture with both enabled.
// node scripts/viewport-parity.mjs http://127.0.0.1:9222
import { once } from "node:events";
const endpoint = new URL(process.argv[2] ?? "http://127.0.0.1:9222");
const requireImageryAndSky = process.argv.includes("--imagery-and-sky");
if (!["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname)) throw Error("Expected local Studio");
const pages = await (await fetch(new URL("/json/list", endpoint))).json();
const page = pages.find(p => p.type === "page" && p.title.includes("Forge3D Studio") && new URL(p.url).port === "1420");
if (!page) throw Error("Studio dev page unavailable");
const socket = new WebSocket(page.webSocketDebuggerUrl);
await once(socket, "open");
try {
  const response = once(socket, "message");
  socket.send(JSON.stringify({ id: 1, method: "Runtime.evaluate",
    params: { expression: `(${measure.toString()})(${requireImageryAndSky})`, awaitPromise: true, returnByValue: true } }));
  const [event] = await response;
  const reply = JSON.parse(event.data);
  if (reply.error || reply.result.exceptionDetails)
    throw Error(JSON.stringify(reply.error ?? reply.result.exceptionDetails));
  const result = reply.result.result.value;
  console.log(JSON.stringify(result, null, 2));
  if (result.poses.some(p => p.iou < 0.995 || p.maxPointError > 1)) process.exitCode = 1;
} finally { socket.close(); }

async function measure(requireImageryAndSky) {
  const { Camera } = await import(new URL("forge3d-web/index.js", document.baseURI));
  const diagnostics = window.forge3dViewportDiagnostics;
  const { terrainViewport, frame: initialFrame } = diagnostics();
  const { mode, imageryAsset, studioSkyIntensity } = initialFrame.settings;
  const expectImagery = mode === "material" && imageryAsset !== null;
  const expectedSky = mode === "material" ? studioSkyIntensity : 0;
  if (requireImageryAndSky && (!expectImagery || !(expectedSky > 0))) {
    throw Error("Open the Material fixture with imagery and studio sky lighting enabled");
  }
  const next = () => new Promise(requestAnimationFrame);
  const waitForAppearance = async (label, hasSubmitted = () => true) => {
    const end = performance.now() + 20000;
    do {
      await next();
      const current = terrainViewport.diagnosticAppearance;
      if (!current || current.skyIntensity !== expectedSky || !hasSubmitted()) continue;
      if (!expectImagery) {
        if (!current.drape) return current;
        continue;
      }
      const drape = current.drape;
      if (!drape?.settled) continue;
      const overlay = terrainViewport.diagnosticRuntime?.getTerrainOverlayReport();
      if (overlay?.enabled && overlay.width === drape.width && overlay.height === drape.height) return current;
    } while (performance.now() < end);
    throw Error(`${label}: requested drape and sky did not settle (applied: ${JSON.stringify(terrainViewport.diagnosticAppearance)})`);
  };
  await waitForAppearance("Fixture");
  const { runtime, frame } = diagnostics();
  const web = terrainViewport.diagnosticRuntime;
  if (!web) throw Error("Activate forge3d-web with both shadow settings off first");
  const { renderer, camera, orbit } = runtime;
  const terrainObject = frame.objects.find(object => object.visible && object.kind.type === "terrain");
  const { preview, zScale } = frame.terrains.get(terrainObject.id);
  const mesh = runtime.objects.get(terrainObject.id).children.find(child => child.userData.elevation);
  const size = { width: renderer.domElement.width, height: renderer.domElement.height };
  if ([web, frame.dimensions].some(s => s.width !== size.width || s.height !== size.height)) {
    throw Error("Published, WebGPU and three.js drawing buffers differ");
  }
  const threeUrl = performance.getEntriesByType("resource").find(r => /\/three\.js\?v=/.test(r.name))?.name;
  if (!threeUrl) throw Error("Cannot locate the Studio three.js module");
  const THREE = await import(threeUrl);
  const ref = new THREE.Scene();
  const clone = mesh.clone(false);
  mesh.updateWorldMatrix(true, false);
  clone.matrixAutoUpdate = false;
  clone.matrix.copy(mesh.matrixWorld);
  ref.add(clone, runtime.sun.clone(), runtime.hemi.clone());
  const target = new THREE.WebGLRenderTarget(size.width, size.height);
  const initial = camera.position.clone();
  const aim = orbit.target.clone();
  const radius = initial.distanceTo(aim);
  const beforeAlpha = renderer.getClearAlpha();
  const originalSetCamera = web.setCamera;
  const originalSetTerrain = web.setTerrain;
  const originalSetTerrainOverlays = web.setTerrainOverlays;
  const originalResize = web.resize;
  let resizes = 0;
  web.resize = function(input) { resizes++; return originalResize.call(this, input); };
  let webCamera, webTerrain, requestedOverlay, cameras = 0;
  const submissions = [];
  const overlaySize = overlays => overlays?.layers?.some(layer => layer.name === "Imagery") ?
    overlays.outputSize?.join("x") : undefined;
  const sameGeometry = (a, b) => a.heights === b.heights && a.width === b.width &&
    a.height === b.height && a.exaggeration === b.exaggeration &&
    a.domain.join(",") === b.domain.join(",") && a.spacing.join(",") === b.spacing.join(",");
  web.setCamera = function(input) { cameras++; webCamera = input; return originalSetCamera.call(this, input); };
  web.setTerrainOverlays = function(input) {
    requestedOverlay = overlaySize(input);
    return originalSetTerrainOverlays.call(this, input);
  };
  web.setTerrain = function(input) {
    const imagery = overlaySize(input.overlays);
    // The facade falls back to setTerrain when setTerrainOverlays changes
    // allocation size. It reuses the committed height array and grid.
    const overlayRecommit = webTerrain && imagery && imagery === requestedOverlay &&
      imagery !== overlaySize(webTerrain.overlays) && sameGeometry(input, webTerrain);
    submissions.push({ cause: !webTerrain ? "initial" : overlayRecommit ? "overlay-resize" : "unexpected", imagery });
    if (overlayRecommit) requestedOverlay = undefined;
    webTerrain = input;
    return originalSetTerrain.call(this, input);
  };
  const results = [];
  try {
    // Recommit through the viewport once, capturing its actual public API input.
    terrainViewport.uploaded = undefined;
    runtime.needsRender = true;
    await waitForAppearance("Initial submission", () => Boolean(webTerrain && webCamera));
    if (!webTerrain || !webCamera) throw Error("Viewport did not submit a terrain and camera");
    if (webTerrain.heights.length !== preview.heights.length ||
      webTerrain.heights.some((height, i) => height !== Math.fround(preview.heights[i]))) {
      throw Error("Submitted samples differ from the accepted preview");
    }
    const heights = await web.readTerrainHeights();
    if (heights.length !== preview.heights.length) throw Error("Height readback length mismatch");
    const poses = [["default", initial], ["low oblique", new THREE.Vector3(1, 0.24, 1).normalize().multiplyScalar(radius).add(aim)],
      ["near nadir", new THREE.Vector3(0, 1, 0.035).normalize().multiplyScalar(radius).add(aim)]];
    const n = preview.resolution;
    const peak = heights.reduce((best, v, i) => v > heights[best] ? i : best, 0);
    const landmarks = [0, n - 1, n * (n - 1), n * n - 1, peak];
    for (const [name, eye] of poses) {
      camera.position.copy(eye);
      orbit.update();
      const previousCameras = cameras;
      runtime.needsRender = true;
      const appearance = await waitForAppearance(name, () => cameras > previousCameras);
      const rgba = await web.readRgba();
      if (rgba.length !== size.width * size.height * 4) throw Error("Frame dimensions differ");
      renderer.setClearAlpha(0);
      renderer.setRenderTarget(target);
      renderer.render(ref, camera);
      const refPixels = new Uint8Array(rgba.length);
      renderer.readRenderTargetPixels(target, 0, 0, size.width, size.height, refPixels);
      renderer.setRenderTarget(null);
      renderer.setClearAlpha(beforeAlpha);
      let both = 0, either = 0, webCoverage = 0, referenceCoverage = 0;
      for (let y = 0; y < size.height; y++) for (let x = 0; x < size.width; x++) {
        const i = (y * size.width + x) * 4, j = ((size.height - 1 - y) * size.width + x) * 4;
        // The transparent clear preserves coverage even for black imagery texels.
        const a = rgba[i + 3] !== 0;
        const b = refPixels[j + 3] !== 0;
        if (a) webCoverage++; if (b) referenceCoverage++;
        if (a || b) either++; if (a && b) both++;
      }
      if (!webCoverage || !referenceCoverage) throw Error("Empty silhouette");
      const nativeCamera = Camera.fromInput(webCamera);
      const errors = landmarks.map(i => {
        const local = [((i % n) - (n - 1) / 2) * webTerrain.spacing[0],
          (heights[i] - webTerrain.domain[0]) * webTerrain.exaggeration,
          (Math.floor(i / n) - (n - 1) / 2) * webTerrain.spacing[1]];
        const p = nativeCamera.worldToScreen(local, size);
        if (!p) throw Error("Point behind camera");
        const q = new THREE.Vector3().fromBufferAttribute(mesh.geometry.attributes.position, i)
          .applyMatrix4(mesh.matrixWorld).project(camera);
        return Math.hypot(p.x - (q.x + 1) * size.width / 2, p.y - (1 - q.y) * size.height / 2);
      });
      const current = diagnostics();
      if (current.frame.terrains.get(terrainObject.id)?.preview.heights !== preview.heights ||
        submissions.some(entry => entry.cause === "unexpected")) {
        throw Error(`Camera motion changed the DEM or caused an unrelated submission: ${JSON.stringify(submissions)}`);
      }
      results.push({ name, iou: both / either, webCoverage, referenceCoverage, maxPointError: Math.max(...errors), errors,
        appearance, uploads: submissions.length, viewportCamera: current.frame.camera, webCamera, nativeView: current.nativeView });
    }
    if (resizes) throw Error(`WebGPU resized ${resizes} times with a fixed drawing buffer`);
    return { dimensions: frame.dimensions, resizes, uploads: submissions.length, submissions,
      expectedAppearance: { imagery: expectImagery, skyIntensity: expectedSky }, projectId: frame.projectId,
      projectGeneration: frame.projectGeneration, objectIds: frame.objects.map(object => object.id), terrainObject,
      terrain: { resolution: preview.resolution, spanXz: preview.spanXz, originXz: preview.originXz,
        spanMetresPerUnit: preview.spanMetresPerUnit, rawDomain: [preview.minElevation, preview.maxElevation],
        zScale, spacing: webTerrain.spacing, exaggeration: webTerrain.exaggeration,
        landmarks: landmarks.map(index => ({ index, elevation: heights[index] })) },
      adapter: web.getCapabilities().adapterInfo, poses: results };
  } finally {
    web.resize = originalResize;
    web.setCamera = originalSetCamera;
    web.setTerrain = originalSetTerrain;
    web.setTerrainOverlays = originalSetTerrainOverlays;
    renderer.setRenderTarget(null); renderer.setClearAlpha(beforeAlpha); target.dispose();
    camera.position.copy(initial); orbit.target.copy(aim); orbit.update(); runtime.needsRender = true;
  }
}
