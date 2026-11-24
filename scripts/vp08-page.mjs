// Runs inside the two desktop WebViews. Drive the existing RAF callbacks in
// lockstep so compositor timing cannot add damping updates between mouse events.
export async function installReplay(field) {
  const ref = field ? __vp01FieldDiagnostics().runtime : undefined;
  const diagnostics = () => forge3dViewportDiagnostics();
  const canvas = ref?.renderer.domElement ?? document.querySelector(".viewport-canvas--terrain");
  const rect = canvas.getBoundingClientRect();
  let updates = 0;
  const trace = [];
  for (const type of ["pointerdown", "pointermove", "pointerup", "wheel"]) {
    window.addEventListener(type, e => {
      trace.push({ type, updates, x: e.clientX - rect.left, y: e.clientY - rect.top,
        button: e.button, buttons: e.buttons, shift: e.shiftKey, ctrl: e.ctrlKey, meta: e.metaKey,
        deltaMode: e.deltaMode, deltaY: e.deltaY, trusted: e.isTrusted });
    }, true);
  }

  const calls = [];
  const fetch = window.fetch;
  window.fetch = function(resource, init) {
    const url = new URL(resource instanceof Request ? resource.url : resource, location.href);
    if (url.hostname === "ipc.localhost" && url.pathname === "/set_selection") calls.push(JSON.parse(init.body));
    return fetch.apply(this, arguments);
  };
  let draws = 0, renderedCamera, renderedTarget;
  if (field) {
    const render = ref.renderer.render;
    ref.renderer.render = function(scene, camera) {
      const result = render.apply(this, arguments);
      if (scene === ref.scene) {
        draws++;
        renderedCamera = camera.clone();
        renderedTarget = ref.orbit.target.toArray();
      }
      return result;
    };
    ref.needsRender = true;
  }
  function setPose(eye, target) {
    if (field) {
      ref.camera.position.fromArray(eye);
      ref.orbit.target.fromArray(target);
      ref.orbit.update();
      ref.needsRender = true;
    } else {
      diagnostics().setOrbitPose(eye, target);
    }
  }

  const nativeFrame = window.requestAnimationFrame.bind(window);
  let queue = [];
  window.requestAnimationFrame = callback => queue.push(callback);
  await new Promise(nativeFrame);
  let time = performance.now();
  function step(count) {
    for (let i = 0; i < count; i++) {
      updates++;
      time += 1000 / 60;
      const pending = queue;
      queue = [];
      if (!pending.length) throw Error("No viewport animation callback scheduled");
      for (const run of pending) run(time);
    }
  }
  step(2);
  function sample() {
    let eye, target, sequence;
    if (field) {
      eye = renderedCamera.position.toArray();
      target = renderedTarget;
      sequence = draws;
    } else {
      const { placement } = diagnostics().terrainViewport.diagnosticSubmission;
      const native = vp04Calls.submittedCamera;
      const studio = point => point.map((v,i) => v * placement.scale + placement.translation[i]);
      eye = studio(native.position);
      target = studio(native.target);
      sequence = diagnostics().terrainViewport.diagnosticSubmission.sequence;
    }
    return { eye, target, radius: Math.hypot(...eye.map((v,i) => v - target[i])), sequence };
  }
  function livePose() {
    if (field) return { eye: ref.camera.position.toArray(), target: ref.orbit.target.toArray(), radius: ref.orbit.getDistance() };
    const { eye, aim: { orbitTarget: target } } = diagnostics().readCamera();
    return { eye, target, radius: Math.hypot(...eye.map((v,i) => v-target[i])) };
  }
  function fieldLandmarks() {
    const mesh = [...ref.objects.values()].flatMap(g => g.children).find(c => c.userData.elevation);
    const points = mesh.geometry.attributes.position;
    const n = Math.sqrt(points.count);
    let peak = 0;
    for (let i = 1; i < points.count; i++) if (points.getY(i) > points.getY(peak)) peak = i;
    return [0,n-1,n*(n-1),n*n-1,peak].map(index => {
      const p = ref.camera.position.clone().fromBufferAttribute(points, index).applyMatrix4(mesh.matrixWorld).project(renderedCamera);
      return { index, pixel: [(1+p.x)*canvas.width/2, (1-p.y)*canvas.height/2] };
    });
  }
  async function cubePixel() {
    const rgba = await diagnostics().terrainViewport.diagnosticRuntime.readRgba();
    const indices = [];
    for (let i = 0; i < rgba.length; i += 4) {
      if (rgba[i] > rgba[i+1]+24 && rgba[i+2] > rgba[i+1]+24 && rgba[i+3] > 200) indices.push(i/4);
    }
    if (!indices.length) throw Error("No visible magenta cube pixels");
    const i = indices[Math.floor(indices.length/2)];
    return { x: i % canvas.width, y: Math.floor(i/canvas.width), rgba: [...rgba.slice(i*4,i*4+4)] };
  }
  window.replay = { step, trace, calls, sample, livePose, setPose, fieldLandmarks, cubePixel };
  return { x: rect.left, y: rect.top, css: [rect.width,rect.height], physical: [canvas.width,canvas.height], dpr: devicePixelRatio,
    backend: field ? ref.renderer.getContext().constructor.name : document.querySelector("[data-viewport-backend]").textContent };
}
