// Open Bryce in Solid or Material mode in a Studio dev build. Turn off Sun shadows and
// Terrain sun shadows so Auto activates forge3d-web. Run at the display scale under test.
// node scripts/viewport-parity.mjs http://127.0.0.1:9222
import { once } from "node:events";
const endpoint = new URL(process.argv[2] ?? "http://127.0.0.1:9222");
if (!["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname)) throw Error("Expected local Studio");
const pages = await (await fetch(new URL("/json/list", endpoint))).json();
const page = pages.find(p => p.type === "page" && p.title.includes("Forge3D Studio") && new URL(p.url).port === "1420");
if (!page) throw Error("Studio dev page unavailable");
const socket = new WebSocket(page.webSocketDebuggerUrl);
await once(socket, "open");
try {
  const response = once(socket, "message");
  socket.send(JSON.stringify({ id: 1, method: "Runtime.evaluate",
    params: { expression: `(${measure.toString()})()`, awaitPromise: true, returnByValue: true } }));
  const [event] = await response;
  const reply = JSON.parse(event.data);
  if (reply.error || reply.result.exceptionDetails)
    throw Error(JSON.stringify(reply.error ?? reply.result.exceptionDetails));
  const result = reply.result.result.value;
  console.log(JSON.stringify(result, null, 2));
  if (result.poses.some(p => p.iou < 0.995 || p.maxPointError > 1)) process.exitCode = 1;
} finally { socket.close(); }

async function measure() {
  const { Camera } = await import(new URL("forge3d-web/index.js", document.baseURI));
  const { runtime, terrainViewport } = window.forge3dViewportDiagnostics();
  const web = terrainViewport.diagnosticRuntime;
  if (!web) throw Error("Activate forge3d-web with both shadow settings off first");
  const next = () => new Promise(requestAnimationFrame);
  const { renderer, camera, orbit } = runtime;
  const mesh = [...runtime.objects.values()].flatMap(g => g.children).find(m => m.userData.forgeTerrain);
  const { preview, zScale } = mesh.userData.forgeTerrain;
  const size = { width: renderer.domElement.width, height: renderer.domElement.height };
  if (web.width !== size.width || web.height !== size.height) {
    throw Error(`WebGPU ${web.width}×${web.height} differs from three.js ${size.width}×${size.height}`);
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
  const originalResize = web.resize;
  let resizes = 0;
  web.resize = function(input) { resizes++; return originalResize.call(this, input); };
  let webCamera, webTerrain;
  web.setCamera = function(input) { webCamera = input; return originalSetCamera.call(this, input); };
  web.setTerrain = function(input) { webTerrain = input; return originalSetTerrain.call(this, input); };
  const results = [];
  try {
    // Recommit through the viewport once, capturing its actual public API input.
    terrainViewport.uploaded = undefined;
    runtime.needsRender = true;
    await next();
    if (!webTerrain || !webCamera) throw Error("Viewport did not submit a terrain and camera");
    const heights = await web.readTerrainHeights();
    if (heights.length !== preview.heights.length) throw Error("Height readback length mismatch");
    const poses = [["default", initial], ["low oblique", new THREE.Vector3(1, 0.24, 1).normalize().multiplyScalar(radius).add(aim)],
      ["near nadir", new THREE.Vector3(0, 1, 0.035).normalize().multiplyScalar(radius).add(aim)]];
    for (const [name, eye] of poses) {
      camera.position.copy(eye);
      orbit.update();
      runtime.needsRender = true;
      await next();
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
      const n = preview.resolution;
      const peak = heights.reduce((best, v, i) => v > heights[best] ? i : best, 0);
      const nativeCamera = Camera.fromInput(webCamera);
      const errors = [0, n - 1, n * (n - 1), n * n - 1, peak].map(i => {
        const local = [((i % n) - (n - 1) / 2) * webTerrain.spacing[0],
          (heights[i] - webTerrain.domain[0]) * webTerrain.exaggeration,
          (Math.floor(i / n) - (n - 1) / 2) * webTerrain.spacing[1]];
        const p = nativeCamera.worldToScreen(local, size);
        if (!p) throw Error("Point behind camera");
        const q = new THREE.Vector3().fromBufferAttribute(mesh.geometry.attributes.position, i)
          .applyMatrix4(mesh.matrixWorld).project(camera);
        return Math.hypot(p.x - (q.x + 1) * size.width / 2, p.y - (1 - q.y) * size.height / 2);
      });
      results.push({ name, iou: both / either, webCoverage, referenceCoverage, maxPointError: Math.max(...errors), errors });
    }
    if (resizes) throw Error(`WebGPU resized ${resizes} times with a fixed drawing buffer`);
    return { ...size, pixelRatio: renderer.getPixelRatio(), resizes, resolution: preview.resolution, zScale, spacing: webTerrain.spacing, exaggeration: webTerrain.exaggeration, adapter: web.getCapabilities().adapterInfo, poses: results };
  } finally {
    web.resize = originalResize;
    web.setCamera = originalSetCamera;
    web.setTerrain = originalSetTerrain;
    renderer.setRenderTarget(null); renderer.setClearAlpha(beforeAlpha); target.dispose();
    camera.position.copy(initial); orbit.target.copy(aim); orbit.update(); runtime.needsRender = true;
  }
}
