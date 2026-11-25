export function instrument() {
  window.probe = { calls: [], trace: [] };
  const fetch = window.fetch;
  window.fetch = function(resource, init) {
    const url = new URL(resource instanceof Request ? resource.url : resource, location.href);
    if (url.hostname === "ipc.localhost") {
      const cmd = decodeURIComponent(url.pathname.slice(1));
      if (cmd === "plugin:dialog|save" || cmd === "plugin:dialog|open") {
        return Promise.resolve(new Response(JSON.stringify(probe.path), {
          headers: { "Content-Type": "application/json", "Tauri-Response": "ok" },
        }));
      }
      if (["apply_command", "undo", "redo", "set_selection", "save_project", "open_project", "close_project"].includes(cmd)) {
        probe.calls.push({ cmd, args: JSON.parse(init.body) });
      }
    }
    return fetch.apply(this, arguments);
  };
  for (const type of ["pointerdown", "pointermove", "pointerup", "pointercancel", "gotpointercapture", "lostpointercapture"]) {
    window.addEventListener(type, e => {
      if (type === "pointerdown") probe.pointer = e.pointerId;
      const r = document.querySelector(".viewport-canvas--terrain")?.getBoundingClientRect();
      if (r) probe.trace.push({ type, trusted: e.isTrusted, id: e.pointerId, device: e.pointerType, buttons: e.buttons,
        captured: document.querySelector(".world-x-grip")?.hasPointerCapture(e.pointerId),
        x: e.clientX - r.left, y: e.clientY - r.top, grip: e.target.matches?.(".world-x-grip") });
    }, true);
  }
  window.confirm = () => true;
}

// The cube mask is the difference from a real terrain-only draw at this pose.
// Its centroid and hash exclude the DOM grip, toolbars and Scene Tree.
export async function pixels(terrainOnly) {
  const runtime = forge3dViewportDiagnostics().terrainViewport.diagnosticRuntime;
  const rgba = await runtime.readRgba();
  const values = new Uint32Array(rgba.buffer, rgba.byteOffset, rgba.length / 4);
  if (terrainOnly) { probe.ground = values.slice(); return; }
  let n = 0, sumX = 0;
  for (let i = 0; i < values.length; ++i) {
    if (values[i] === probe.ground[i]) continue;
    n++;
    sumX += i % runtime.width;
  }
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", rgba));
  return { cubePixels: n, meanX: sumX / n, sha256: Array.from(hash, v => v.toString(16).padStart(2, "0")).join("") };
}
