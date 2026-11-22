// Functions below run in the desktop WebView.
export async function packagedControl(override = {}) {
  const { Forge3DRuntime, TerrainDataset } = await import("/forge3d-web/index.js");
  const input = { width: 5, height: 3, spacing: [2, 1], domain: [10, 12],
    heights: Float32Array.from({ length: 15 }, (_, i) => 10 + i / 10), exaggeration: 1, renderMode: "perspective" };
  const web = await Forge3DRuntime.create(document.createElement("canvas"), {
    width: 192, height: 128, devicePixelRatio: 1, clearColor: [0, 0, 0, 0] });
  try {
    web.setTerrain({ ...input, ...override });
    web.setCamera({ position: [5, 6, 8], target: [0, 0, 0], up: [0, 1, 0], fovYDegrees: 45, near: 0.1, far: 100 });
    if (!web.render()) throw Error("Packaged control did not submit a frame");
    const rgba = await web.readRgba();
    // Directly overhead, the perimeter skirts project inside the top face.
    web.setCamera({ position: [0, 12, 0], target: [0, 0, 0], up: [0, 0, -1], fovYDegrees: 45, near: 0.1, far: 100 });
    if (!web.render()) throw Error("Packaged footprint did not render");
    const pixels = await web.readRgba();
    const mask = Uint8Array.from({length: 192*128}, (_, i) => Number(pixels[4*i+3] > 0));
    const dataset = TerrainDataset.fromArray(input);
    return { coverage: rgba.filter((v, i) => i % 4 === 3 && v).length, dimensions: [web.width, web.height], footprintMask: btoa(String.fromCharCode(...mask)),
      spacing: input.spacing, domain: input.domain, heights: [...await web.readTerrainHeights()],
      hit: dataset.query(4, 1), outside: dataset.query(4.1, 1) ?? null, adapter: web.getCapabilities().adapterInfo };
  } finally { web.dispose(); }
}

export async function observeUpload() {
  const { Forge3DRuntime } = await import("/forge3d-web/index.js");
  const prototype = Forge3DRuntime.prototype;
  const calls = window.vp04Calls = { resizes: 0 };
  // Associate the camera and terrain with the exact WASM instance and successful draw.
  // Packaged controls in this document use unrelated canvases and runtimes.
  const { Forge3DRuntime: Native } = await import("/forge3d-web/forge3d_web.js");
  const cameras = new WeakMap();
  const terrains = new WeakMap();
  let submitted;
  const setCamera = Native.prototype.setCamera;
  Native.prototype.setCamera = function (camera) {
    setCamera.call(this, camera);
    cameras.set(this, structuredClone(camera));
  };
  const setTerrain = Native.prototype.setTerrain;
  Native.prototype.setTerrain = function (terrain) {
    setTerrain.call(this, terrain);
    const { width, height, heights, domain, spacing, exaggeration, material } = terrain;
    terrains.set(this, structuredClone({ width, height, heights, domain, spacing, exaggeration, material: { clamp: material?.clamp } }));
  };
  const render = Native.prototype.render;
  Native.prototype.render = function () {
    const drawn = render.call(this);
    if (drawn) submitted = { camera: cameras.get(this), terrain: terrains.get(this) };
    return drawn;
  };
  const present = prototype.render;
  prototype.render = function () {
    submitted = undefined;
    const drawn = present.call(this);
    if (drawn && window.forge3dViewportDiagnostics?.().terrainViewport.owns(this)) {
      calls.submittedCamera = submitted?.camera;
      calls.setTerrain = submitted?.terrain;
    }
    return drawn;
  };
  const resize = prototype.resize;
  prototype.resize = function (input) {
    const result = resize.call(this, input);
    if (window.forge3dViewportDiagnostics?.().terrainViewport.owns(this)) calls.resizes++;
    return result;
  };
}

export async function sampleStudio(points) {
  const d = window.forge3dViewportDiagnostics();
  const { frame, terrainViewport } = d;
  const web = terrainViewport.diagnosticRuntime;
  const object = frame.objects.find(o => o.kind.type === "terrain" && o.visible);
  const { preview } = frame.terrains.get(object.id);
  const { setTerrain: input, submittedCamera } = window.vp04Calls;
  const heights = await web.readTerrainHeights();
  const heightOrigin = preview.minElevation - input.domain[0];
  if (heights.length !== preview.heights.length || input.heights.length !== heights.length ||
    heights.some((v, i) => v !== input.heights[i] || v !== Math.fround(preview.heights[i] - heightOrigin))) {
    throw Error("Accepted, uploaded and GPU-read-back heights differ");
  }
  const { terrainTransform, runtimeToStudio } = await import("/src/viewport/forge3dWebMapping.ts");
  const { Camera } = await import("/forge3d-web/index.js");
  const camera = Camera.fromInput(submittedCamera);
  const size = { width: web.width, height: web.height };
  const transform = terrainTransform(preview, object.translation, object.scale[0]);
  const n = preview.resolution;
  const [minHeight, maxHeight] = (input.material.clamp?.heightRange ?? input.domain).map(Math.fround);
  const peak = heights.reduce((best, v, i) => v > heights[best] ? i : best, 0);
  const landmarks = [0, n - 1, n * (n - 1), n * n - 1, points ? points[4].index : peak].map((index, j) => {
    const row = Math.floor(index / n), col = index % n;
    const drawnHeight = Math.max(minHeight, Math.min(maxHeight, heights[index]));
    const submitted = [(col - (input.width - 1) / 2) * input.spacing[0],
      (drawnHeight - Math.fround(input.domain[0])) * input.exaggeration, (row - (input.height - 1) / 2) * input.spacing[1]];
    const studio = runtimeToStudio(submitted, transform);
    const [x,,z] = points ? points[j].position : studio;
    const hit = d.queryTerrain(x, z);
    let edgeChecks;
    if (points && j < 4) {
      const outsideX = x + (col === 0 ? -1e-6 : 1e-6);
      const outsideZ = z + (row === 0 ? -1e-6 : 1e-6);
      const inward = d.queryTerrain(2*x-outsideX, 2*z-outsideZ);
      edgeChecks = { inward: inward?.elevation, outsideX: d.queryTerrain(outsideX,z) ?? null,
        outsideZ: d.queryTerrain(x,outsideZ) ?? null };
      if (!inward) throw Error("Query inside corner " + index + " missed");
      if (edgeChecks.outsideX || edgeChecks.outsideZ) throw Error("Query outside corner " + index + " hit");
    }
    const pixel = camera.worldToScreen(submitted, size);
    if (!pixel) throw Error("Landmark behind camera");
    return { index, height: heights[index] + heightOrigin, textureHeight: heights[index], studio, runtime: submitted, edgeChecks, hit: hit && { elevation: hit.elevation, position: hit.worldPosition },
      pixel: [pixel.x, pixel.y] };
  });
  const rgba = await web.readRgba();
  if (rgba.length !== size.width * size.height * 4) throw Error("Unexpected WebGPU readback dimensions");
  const mask = Uint8Array.from({ length: rgba.length / 4 }, (_, i) => Number(rgba[i * 4 + 3] > 0));
  let bytes = "";
  for (let i = 0; i < mask.length; i += 32768) bytes += String.fromCharCode(...mask.subarray(i, i + 32768));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", heights));
  const rgbaDigest = new Uint8Array(await crypto.subtle.digest("SHA-256", rgba));
  return { backend: document.querySelector("[data-viewport-backend]")?.textContent.trim(), editor: !!d.runtime,
    heightSha256: Array.from(digest, v => v.toString(16).padStart(2, "0")).join(""),
    rgbaSha256: Array.from(rgbaDigest, v => v.toString(16).padStart(2, "0")).join(""),
    visible: !document.querySelector(".viewport-canvas--terrain").hidden, adapter: web.getCapabilities().adapterInfo,
    size, dpr: devicePixelRatio, mode: frame.settings.mode, shadows: [frame.settings.sunShadows, frame.settings.terrainSunShadows],
    grid: [input.width, input.height], source: [preview.width, preview.height], span: preview.spanXz,
    rawDomain: [preview.minElevation, preview.maxElevation], heightOrigin, domain: input.domain, spacing: input.spacing,
    exaggeration: input.exaggeration, peak, landmarks, count: mask.reduce((a, b) => a+b, 0),
    mask: btoa(bytes), camera: frame.camera, submittedCamera, resizes: window.vp04Calls.resizes };
}
