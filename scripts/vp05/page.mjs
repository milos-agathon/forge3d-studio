// These functions run inside the desktop WebView.
export function inspect(field, cubeId, terrainId) {
  const d = field ? window.__vp01FieldDiagnostics?.() : window.forge3dViewportDiagnostics?.();
  if (!d) return null;
  const r = d.runtime;
  const host = d.terrainViewport;
  const canvas = field ? r.renderer.domElement : document.querySelector("canvas.viewport-canvas--terrain");
  const rect = canvas.getBoundingClientRect();
  const submission = host?.diagnosticSubmission;
  const camera = field ? r.camera : d.frame.camera;
  if (!camera) return null;
  const dem = r?.objects.get(terrainId)?.children.find(c => c.userData.elevation);
  return {
    viewport: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    physical: [canvas.width, canvas.height], dpr: devicePixelRatio,
    mode: field ? document.querySelector('.viewport-toolbar [aria-label="Viewport mode"] button.is-active')?.textContent?.toLowerCase() : d.frame.settings.mode,
    camera: field ? [camera.position.toArray(), r.orbit.target.toArray(), camera.fov, camera.near, camera.far] :
      [camera.eye, camera.aim.orbitTarget, camera.fovYDegrees, camera.near, camera.far],
    settings: d.frame?.settings, editor: !!r,
    cube: field ? r.objects.get(cubeId)?.visible : d.frame.objects.find(o => o.id === cubeId)?.visible,
    terrain: field ? r.objects.get(terrainId)?.visible : !!submission?.terrain,
    ready: field ? !!r.objects.get(cubeId)?.children.length &&
      (!r.objects.get(terrainId)?.visible || r.objects.get(terrainId).children.some(c => c.userData.elevation))
      : !!submission && !canvas.hidden && !!document.querySelector("[data-viewport-backend]")?.textContent.includes("WebGPU available"),
    stats: host?.diagnosticRuntime?.getScatterStats(),
    resolution: field ? dem && Math.sqrt(dem.geometry.attributes.position.count) : d.frame.terrains.get(terrainId)?.preview.resolution,
    layers: field && dem ? { mapped: !!dem.material.map, vertexColors: dem.material.vertexColors,
      grid: r.grid.visible, sunShadow: r.sun.castShadow, terrainShadow: !!dem.userData.sunVisibility } : undefined,
    preference: localStorage.getItem("studio.viewport.renderer") ?? "auto",
  };
}

export async function readFrame(field) {
  let rgba;
  if (field) {
    const r = window.__vp01FieldDiagnostics().runtime;
    // Sample the application's own draw before Chromium discards the buffer.
    const original = r.renderer.render;
    rgba = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { r.renderer.render = original; reject(Error("Field draw timeout")); }, 5000);
      r.renderer.render = function (...args) {
        const result = original.apply(this, args);
        if (args[0] !== r.scene) return result;
        clearTimeout(timer);
        r.renderer.render = original;
        const gl = this.getContext(), w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
        const pixels = new Uint8Array(w * h * 4), top = new Uint8Array(pixels.length);
        gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        for (let y = 0; y < h; y++) top.set(pixels.subarray(y*w*4, (y+1)*w*4), (h-1-y)*w*4);
        resolve(top);
        return result;
      };
      r.needsRender = true;
    });
  } else rgba = await window.forge3dViewportDiagnostics().terrainViewport.diagnosticRuntime.readRgba();
  let bytes = "";
  for (let start = 0; start < rgba.length; start += 32768) bytes += String.fromCharCode(...rgba.subarray(start, start + 32768));
  return btoa(bytes);
}
