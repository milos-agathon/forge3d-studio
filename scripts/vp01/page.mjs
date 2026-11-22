// Serialized by the CDP driver. Keep the probe self-contained in the page.
export function installProbe({ role, cubeId }) {
  const auto = role === "candidate";
  const diagnostics = () => role === "field"
    ? window.__vp01FieldDiagnostics?.()
    : window.forge3dViewportDiagnostics?.();
  const runtime = () => diagnostics()?.runtime;
  const terrain = () => [...(runtime()?.objects.values() ?? [])]
    .flatMap(group => group.children).find(mesh => mesh.userData.elevation);
  const cubeGroup = () => runtime()?.objects.get(cubeId);
  const web = () => diagnostics()?.terrainViewport?.diagnosticRuntime;
  const backend = () => document.querySelector("[data-viewport-backend]")?.textContent.trim() ?? null;
  const lowerCanvas = () => document.querySelector("canvas.viewport-canvas--terrain");
  const projectState = () => window.__TAURI_INTERNALS__.invoke("project_state");
  const next = () => new Promise(resolve => requestAnimationFrame(resolve));
  const require = (value, reason) => { if (!value) throw new Error(reason); };

  function viewport() {
    const renderer = runtime().renderer;
    const canvas = renderer.domElement;
    const { x, y, width, height } = canvas.getBoundingClientRect();
    return { css: { x, y, width, height }, physical: { width: canvas.width, height: canvas.height },
      dpr: devicePixelRatio, drawingDpr: renderer.getPixelRatio(), origin: "top-left" };
  }

  function displayChrome() {
    const { css } = viewport();
    const div = runtime().renderer.domElement.parentElement;
    const elements = div.querySelectorAll(".viewport-instruments,.viewport-toolbar,.viewport-attribution,.viewport-hint,.viewport-camera,.map-grid-label");
    return [...elements].flatMap(element => {
      const { visibility, opacity } = getComputedStyle(element);
      const { x, y, width, height } = element.getBoundingClientRect();
      if (!width || !height || visibility !== "visible" || Number(opacity) === 0) return [];
      return [{ x: x - css.x, y: y - css.y, width, height }];
    });
  }

  function pose() {
    const { camera, orbit } = runtime();
    return { position: camera.position.toArray(), target: orbit.target.toArray(), up: camera.up.toArray(),
      quaternion: camera.quaternion.toArray(), fov: camera.fov, near: camera.near, far: camera.far };
  }

  function ready() {
    const mesh = terrain();
    if (!mesh?.userData.drape || mesh.material.map !== mesh.userData.drape) return false;
    if (auto) return Boolean(web() && lowerCanvas()?.hidden === false && backend()?.includes("WebGPU available"));
    if (role === "forced-three") return lowerCanvas()?.hidden === true && backend()?.includes("View menu override");
    return role === "field" && !lowerCanvas();
  }

  function webglInfo() {
    const gl = runtime().renderer.getContext();
    const debug = gl.getExtension("WEBGL_debug_renderer_info");
    return { context: gl.constructor.name, version: gl.getParameter(gl.VERSION),
      vendor: gl.getParameter(gl.VENDOR), renderer: gl.getParameter(gl.RENDERER),
      unmaskedVendor: debug ? gl.getParameter(debug.UNMASKED_VENDOR_WEBGL) : null,
      unmaskedRenderer: debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : null };
  }

  async function inspect() {
    const { project } = await projectState();
    const r = runtime();
    const mesh = terrain();
    // Field's elevation metadata predates the forge3d-web TerrainSource hook.
    const resolution = Math.sqrt(mesh.geometry.attributes.position.count);
    const terrainNode = project.scene.objects.find(node => node.id === mesh.parent.userData.studioId);
    const cubeNode = project.scene.objects.find(node => node.id === cubeId);
    const cube = cubeGroup()?.children.find(node => node.isMesh);
    // Field stores the terrain's ground-to-Studio scale in the elevation
    // metadata. Invert that scale on the rendered mesh's two horizontal spans.
    const groundPerStudioUnit = terrainNode.kind.zScale / mesh.userData.elevation.scale;
    const measuredSpan = [mesh.scale.x, mesh.scale.z].map(value => value * groundPerStudioUnit);
    const { render, viewport: view } = project;
    const canvases = [...r.renderer.domElement.parentElement.querySelectorAll("canvas.viewport-canvas")].map(canvas => ({
      pass: canvas === r.renderer.domElement ? "upper" : "lower",
      hidden: canvas.hidden, width: canvas.width, height: canvas.height,
    }));
    return {
      viewport: viewport(), project,
      loaded: {
        id: project.id,
        terrain: { id: terrainNode.id, resolution, span: terrainNode.kind.worldSpanXz,
          previewSpan: mesh.userData.forgeTerrain?.preview.spanXz ?? measuredSpan.map(value => Number(value.toFixed(9))),
          measuredSpan },
        cube: cubeNode ? { id: cubeNode.id, size: cubeNode.kind.source?.primitive?.size,
          translation: [cubeNode.transform.translation.x, cubeNode.transform.translation.y, cubeNode.transform.translation.z],
          color: cubeNode.kind.material?.baseColor, visible: cubeNode.visible,
          liveVisible: cubeGroup()?.visible ?? false, liveColor: cube?.material.color?.toArray() ?? null,
          liveTranslation: cubeGroup()?.position.toArray() ?? null } : null,
      },
      toggles: {
        mode: view.mode, imagery: Boolean(mesh.userData.drape && mesh.material.map === mesh.userData.drape),
        sky: render.sky, environment: render.environment ?? null, hillshade: view.hillshade,
        gridVisible: view.gridVisible, shadows: render.shadows, sunVisibility: render.sunVisibility,
        builtinSky: Boolean(r.studioEnvironment && r.environment === r.studioEnvironment && r.scene.environment === r.studioEnvironment),
        liveGridVisible: r.grid.visible, liveSunShadow: r.sun.castShadow,
        liveTerrainShadow: Boolean(mesh.userData.sunVisibility), liveHillshade: mesh.material.map === mesh.userData.hillshade,
      },
      stock: { pose: pose(), backend: backend(), canvases, webgl: webglInfo(),
        webgpu: web() ? { adapter: web().getCapabilities().adapterInfo, width: web().width, height: web().height } : null },
    };
  }

  const magenta = (rgba, i) => rgba[i] > rgba[i + 1] + 24 && rgba[i + 2] > rgba[i + 1] + 24 && rgba[i + 3] > 200;
  const hasAlpha = (rgba, i) => rgba[i + 3] > 0;

  function maskOf(rgba, size, predicate, bottomLeft = false) {
    const { width, height } = size;
    require(rgba.length === width * height * 4, "readback-dimensions-mismatch");
    const mask = new Uint8Array(width * height);
    let count = 0;
    for (let y = 0; y < height; y++) {
      const sourceRow = bottomLeft ? height - 1 - y : y;
      for (let x = 0; x < width; x++) {
        const on = predicate(rgba, 4 * (sourceRow * width + x));
        mask[y * width + x] = Number(on);
        count += Number(on);
      }
    }
    return { mask, count };
  }

  function encode(mask) {
    let bytes = "";
    for (let start = 0; start < mask.length; start += 32768) {
      bytes += String.fromCharCode(...mask.subarray(start, start + 32768));
    }
    return btoa(bytes);
  }

  // Read the real default framebuffer before Chromium can discard its contents.
  // This also lets us observe an actual application draw after every pose change.
  function liveFrame(sample) {
    const r = runtime();
    const original = r.renderer.render;
    return new Promise((resolve, reject) => {
      const deadline = setTimeout(() => {
        r.renderer.render = original;
        reject(new Error("viewport-render-timeout"));
      }, 5000);
      r.renderer.render = function (...args) {
        if (args[0] !== r.scene) return original.apply(this, args);
        r.renderer.render = original;
        clearTimeout(deadline);
        try {
          const result = original.apply(this, args);
          resolve(sample?.());
          return result;
        } catch (error) {
          reject(error);
        }
      };
      r.needsRender = true;
    });
  }

  function observeDraws(gl, meshes) {
    const observations = {};
    let drawing;
    const restore = [];
    for (const [label, mesh] of Object.entries(meshes)) {
      observations[label] = [];
      if (!mesh) continue;
      const before = mesh.onBeforeRender;
      const after = mesh.onAfterRender;
      mesh.onBeforeRender = function (...args) {
        before.apply(this, args);
        drawing = { label, material: args[4] };
      };
      mesh.onAfterRender = function (...args) {
        drawing = undefined;
        after.apply(this, args);
      };
      restore.push(() => { mesh.onBeforeRender = before; mesh.onAfterRender = after; });
    }
    for (const method of ["drawElements", "drawArrays"]) {
      const original = gl[method];
      gl[method] = function (...args) {
        if (drawing) {
          const { label, material } = drawing;
          observations[label].push({ method, elements: args[method === "drawElements" ? 1 : 2],
            colorWrite: material.colorWrite, colorMask: Array.from(gl.getParameter(gl.COLOR_WRITEMASK)),
            depthWrite: gl.getParameter(gl.DEPTH_WRITEMASK), depthTest: gl.isEnabled(gl.DEPTH_TEST) });
        }
        return original.apply(this, args);
      };
      restore.push(() => { gl[method] = original; });
    }
    return { observations, stop: () => restore.reverse().forEach(undo => undo()) };
  }

  async function upperFrame(size) {
    const { renderer } = runtime();
    const gl = renderer.getContext();
    const { width, height } = size;
    const { observations, stop } = observeDraws(gl, {
      terrainDraw: terrain(), cubeDraw: cubeGroup()?.children.find(node => node.isMesh),
    });
    try {
      const frame = await liveFrame(() => {
        require(gl.drawingBufferWidth === width && gl.drawingBufferHeight === height, "upper-dimensions-mismatch");
        const rgba = new Uint8Array(width * height * 4);
        gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, rgba);
        return { ...maskOf(rgba, size, magenta, true), clearAlpha: renderer.getClearAlpha() };
      });
      return { ...frame, ...observations };
    } finally {
      stop();
    }
  }

  async function lowerFrame(size) {
    const renderer = web();
    require(renderer?.width === size.width && renderer.height === size.height, "lower-dimensions-mismatch");
    const rgba = await renderer.readRgba();
    const coverage = maskOf(rgba, size, hasAlpha);
    let colorPixels = 0;
    for (let pixel = 0; pixel < coverage.mask.length; pixel++) {
      const i = pixel * 4;
      if (coverage.mask[pixel] && (rgba[i] || rgba[i + 1] || rgba[i + 2])) colorPixels++;
    }
    return { rgba, ...coverage, colorPixels, magentaPixels: maskOf(rgba, size, magenta).count,
      adapter: renderer.getCapabilities().adapterInfo,
      material: renderer.getTerrainMaterialReport(), imagery: renderer.getTerrainOverlayReport() };
  }

  function interiorPixel(mask, width, height, canvas) {
    let count = 0;
    let averageX = 0;
    let averageY = 0;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      if (!mask[y * width + x]) continue;
      count++;
      averageX += x;
      averageY += y;
    }
    if (!count) return null;
    averageX /= count;
    averageY /= count;
    const { css, drawingDpr } = viewport();
    let best = null;
    let closest = Infinity;
    const margin = 2;
    for (let y = margin; y < height - margin; y++) for (let x = margin; x < width - margin; x++) {
      const distance = Math.hypot(x - averageX, y - averageY);
      if (!mask[y * width + x] || distance >= closest) continue;
      let interior = true;
      for (let dy = -margin; dy <= margin && interior; dy++) {
        const row = (y + dy) * width;
        for (let dx = -margin; dx <= margin; dx++) if (!mask[row + x + dx]) { interior = false; break; }
      }
      const point = [css.x + (x + 0.5) * css.width / width, css.y + (y + 0.5) * css.height / height];
      if (interior && document.elementFromPoint(...point) === canvas) {
        closest = distance;
        best = { physical: [x, y], css: point, drawingDpr, interiorMargin: margin };
      }
    }
    return best;
  }

  let threePromise;
  function three() {
    const injected = diagnostics()?.three;
    if (injected) return Promise.resolve(injected);
    const url = performance.getEntriesByType("resource").find(entry => /\/three\.js\?v=/.test(entry.name))?.name;
    require(url, "three-module-unavailable");
    return threePromise ??= import(url);
  }

  let clickEvidence;
  let stopClickObserver;
  function observeClick(THREE) {
    stopClickObserver?.();
    clickEvidence = {};
    const r = runtime();
    const canvas = r.renderer.domElement;
    const prototype = THREE.Raycaster.prototype;
    const fromCamera = prototype.setFromCamera;
    const intersectObjects = prototype.intersectObjects;
    const ndc = new WeakMap();
    let pointerEvent;
    const onPointerUp = event => {
      if (event.target !== canvas || !event.isTrusted) return;
      pointerEvent = event;
      clickEvidence.pointer = { trusted: event.isTrusted, css: [event.clientX, event.clientY],
        button: event.button, pointerId: event.pointerId };
    };
    canvas.addEventListener("pointerup", onPointerUp, true);
    prototype.setFromCamera = function (coords, camera, ...args) {
      if (pointerEvent?.eventPhase && camera === r.camera) ndc.set(this, coords.toArray());
      return fromCamera.call(this, coords, camera, ...args);
    };
    prototype.intersectObjects = function (objects, recursive, ...args) {
      const hits = intersectObjects.call(this, objects, recursive, ...args);
      if (pointerEvent?.eventPhase && recursive && ndc.has(this) && objects.length === r.objects.size
        && objects.every(object => r.objects.get(object.userData.studioId) === object)) {
        let node = hits[0]?.object;
        while (node && !node.userData.studioId) node = node.parent;
        const stack = new Error().stack;
        const handler = stack?.split("\n").find(line => /\bonPointerUp\b/.test(line) && line.includes("Viewport3D.tsx"));
        clickEvidence.raycast = { handler: handler ? "onPointerUp" : null, source: "three.js Raycaster.intersectObjects",
          uuid: node?.userData.studioId ?? null, recursive, ndc: ndc.get(this), stack };
      }
      return hits;
    };
    stopClickObserver = () => {
      canvas.removeEventListener("pointerup", onPointerUp, true);
      prototype.setFromCamera = fromCamera;
      prototype.intersectObjects = intersectObjects;
      stopClickObserver = undefined;
    };
  }

  async function captureObject() {
    const size = viewport().physical;
    const group = cubeGroup();
    const wasVisible = group?.visible;
    const visible = await upperFrame(size);
    const lowerVisible = auto ? await lowerFrame(size) : null;
    let hidden;
    let lowerHidden;
    try {
      if (group) group.visible = false;
      hidden = await upperFrame(size);
      if (auto) lowerHidden = await lowerFrame(size);
    } finally {
      if (group) group.visible = wasVisible;
      runtime().needsRender = true;
    }
    // Keep the lower WebGPU draw eligible and remove only the upper terrain
    // mesh. The cube gains pixels when that draw is supplying its occlusion.
    const mesh = terrain();
    const terrainVisibility = mesh.visible;
    let terrainHidden;
    try {
      mesh.visible = false;
      terrainHidden = await upperFrame(size);
    } finally {
      mesh.visible = terrainVisibility;
      runtime().needsRender = true;
    }
    const restored = await upperFrame(size);
    const click = interiorPixel(restored.mask, size.width, size.height, runtime().renderer.domElement);
    if (click) observeClick(await three());
    const save = ({ mask, rgba, ...data }) => ({ ...data, mask: encode(mask) });
    let lower = null;
    if (lowerVisible) {
      let changedPixels = 0;
      const { rgba } = lowerVisible;
      for (let i = 0; i < rgba.length; i += 4) {
        if (rgba[i] !== lowerHidden.rgba[i] || rgba[i + 1] !== lowerHidden.rgba[i + 1]
          || rgba[i + 2] !== lowerHidden.rgba[i + 2] || rgba[i + 3] !== lowerHidden.rgba[i + 3]) changedPixels++;
      }
      let clickRgba = null;
      if (click) {
        const [x, y] = click.physical;
        const i = (y * size.width + x) * 4;
        clickRgba = Array.from(rgba.subarray(i, i + 4));
      }
      lower = { visible: save(lowerVisible), hidden: save(lowerHidden), changedPixels,
        magentaPixels: lowerVisible.magentaPixels, clickRgba };
    }
    return { upper: { visible: save(visible), hidden: save(hidden), terrainHidden: save(terrainHidden),
      restored: save(restored) }, lower, click };
  }

  async function captureSelection() {
    stopClickObserver?.();
    const deadline = performance.now() + 4000;
    let selection;
    let tree;
    do {
      selection = (await projectState()).project.selection;
      tree = document.querySelector('.tree-row[aria-selected="true"]')?.textContent ?? null;
      if (!clickEvidence?.pointer || (selection.includes(cubeId) && tree)) break;
      await next();
    } while (performance.now() < deadline);
    return { selectedUuid: selection[0] ?? null, selection, tree,
      pointer: clickEvidence?.pointer ?? null, raycast: clickEvidence?.raycast ?? null };
  }

  async function* captureTerrain() {
    const THREE = await three();
    const r = runtime();
    const { renderer, camera, orbit } = r;
    const mesh = terrain();
    const group = cubeGroup();
    const originalVisibility = group?.visible;
    const initial = camera.position.clone();
    const aim = orbit.target.clone();
    const radius = initial.distanceTo(aim);
    const size = viewport().physical;
    const api = auto ? await import(new URL("forge3d-web/index.js", document.baseURI)) : null;
    const ApiCamera = api?.Camera;
    const rendererWeb = web();
    const terrainViewport = diagnostics().terrainViewport;
    const resizeCalls = [];
    let terrainInput;
    let cameraInput;
    let cameraSubmissions = 0;
    const undo = [];
    const watch = (method, track) => {
      const prototype = api.Forge3DRuntime.prototype;
      const original = prototype[method];
      prototype[method] = function (input) {
        if (terrainViewport.owns ? terrainViewport.owns(this) : this === rendererWeb) track(input);
        return original.call(this, input);
      };
      undo.push(() => { prototype[method] = original; });
    };

    const color = renderer.getClearColor(new THREE.Color()).clone();
    const alpha = renderer.getClearAlpha();
    const target = auto ? null : new THREE.WebGLRenderTarget(size.width, size.height);
    const scene = auto ? null : new THREE.Scene();
    if (scene) {
      const clone = mesh.clone(false);
      mesh.updateWorldMatrix(true, false);
      clone.matrixAutoUpdate = false;
      clone.matrix.copy(mesh.matrixWorld);
      scene.add(clone, r.sun.clone(), r.hemi.clone());
      scene.environment = r.scene.environment;
      scene.environmentIntensity = r.scene.environmentIntensity;
    }

    const poses = {};
    let heights;
    try {
      if (auto) {
        watch("resize", input => resizeCalls.push(input));
        watch("setTerrain", input => { terrainInput = input; });
        watch("setCamera", input => { cameraInput = input; cameraSubmissions++; });
        // Ask the existing viewport path to submit its input again after the stock capture.
        terrainViewport.uploaded = undefined;
        await liveFrame();
        require(cameraInput && terrainInput, "webgpu-inputs-unavailable");
        heights = await rendererWeb.readTerrainHeights();
        require(heights.length === terrainInput.width * terrainInput.height, "terrain-height-readback-length-mismatch");
      }
      const points = mesh.geometry.attributes.position;
      const n = Math.sqrt(points.count);
      let peak = 0;
      const elevation = index => auto ? heights[index] : points.getY(index);
      for (let i = 1; i < points.count; i++) if (elevation(i) > elevation(peak)) peak = i;
      const indices = [0, n - 1, n * (n - 1), n * n - 1, peak];
      const names = ["cornerNW", "cornerNE", "cornerSW", "cornerSE", "peak"];
      const eyes = {
        default: initial,
        "low-oblique": new THREE.Vector3(1, 0.24, 1).normalize().multiplyScalar(radius).add(aim),
        "near-nadir": new THREE.Vector3(0, 1, 0.035).normalize().multiplyScalar(radius).add(aim),
      };
      if (group) group.visible = false;
      for (const [name, eye] of Object.entries(eyes)) {
        camera.position.copy(eye);
        orbit.update();
        const before = cameraSubmissions;
        // Exercise fixed-size application redraws, not just a one-shot readback.
        for (let i = 0; i < 3; i++) await liveFrame();
        require(viewport().physical.width === size.width && viewport().physical.height === size.height,
          "physical-dimensions-changed-during-capture");
        const submissions = cameraSubmissions - before;
        if (auto) require(submissions === 3 && web() === rendererWeb && !lowerCanvas()?.hidden, "webgpu-live-frame-unavailable");
        await next();
        await next();
        // Hold the camera for CDP to capture the presented frame before the
        // diagnostic render/readback can produce a fresh offscreen image.
        yield { name, frame: "screen", displayChrome: displayChrome() };
        const restore = hideTerrainColour();
        try {
          if (!auto) await liveFrame();
          await next();
          await next();
          yield { name, frame: "noTerrain" };
        } finally {
          restore();
        }
        let rgba;
        let landmarks;
        if (auto) {
          rgba = await rendererWeb.readRgba();
          const native = ApiCamera.fromInput(cameraInput);
          landmarks = indices.map((index, i) => {
            const local = [((index % n) - (n - 1) / 2) * terrainInput.spacing[0],
              (heights[index] - terrainInput.domain[0]) * terrainInput.exaggeration,
              (Math.floor(index / n) - (n - 1) / 2) * terrainInput.spacing[1]];
            const p = native.worldToScreen(local, size);
            require(p, "terrain-landmark-behind-camera");
            return { name: names[i], index, pixel: [p.x, p.y] };
          });
        } else {
          camera.updateMatrixWorld();
          renderer.setClearColor(0, 0);
          renderer.setRenderTarget(target);
          try {
            renderer.render(scene, camera);
            rgba = new Uint8Array(size.width * size.height * 4);
            renderer.readRenderTargetPixels(target, 0, 0, size.width, size.height, rgba);
          } finally {
            renderer.setRenderTarget(null);
            renderer.setClearColor(color, alpha);
          }
          landmarks = indices.map((index, i) => {
            const p = new THREE.Vector3().fromBufferAttribute(points, index).applyMatrix4(mesh.matrixWorld).project(camera);
            return { name: names[i], index, pixel: [(p.x + 1) * size.width / 2, (1 - p.y) * size.height / 2] };
          });
        }
        const { mask, count } = maskOf(rgba, size, hasAlpha, !auto);
        poses[name] = { pose: pose(), mask: encode(mask), count, landmarks,
          renderer: auto ? "forge3d-web / WebGPU" : "three.js / WebGL2", cameraSubmissions: auto ? submissions : null };
      }
      return { poses, resizes: auto ? resizeCalls.length : null, resizeCalls };
    } finally {
      for (const restore of undo.reverse()) restore();
      if (group) group.visible = originalVisibility;
      target?.dispose();
      camera.position.copy(initial);
      orbit.target.copy(aim);
      orbit.update();
      r.needsRender = true;
    }
  }

  function hideTerrainColour() {
    if (auto) {
      const { style } = lowerCanvas();
      const visibility = style.getPropertyValue("visibility");
      const priority = style.getPropertyPriority("visibility");
      style.setProperty("visibility", "hidden", "important");
      return () => style.setProperty("visibility", visibility, priority);
    }
    const mesh = terrain();
    const visible = mesh.visible;
    mesh.visible = false;
    return () => { mesh.visible = visible; };
  }

  let restoreComposition;
  let restoreTerrainColour;
  async function composition(state) {
    if (state === "stock") {
      restoreTerrainColour?.();
      restoreTerrainColour = undefined;
      restoreComposition?.();
    } else if (state === "noCube") {
      require(!restoreComposition, "composition-probe-already-active");
      const cube = cubeGroup();
      const cubeVisible = cube?.visible;
      restoreComposition = () => {
        if (cube) cube.visible = cubeVisible;
        restoreComposition = undefined;
      };
      if (cube) cube.visible = false;
    } else if (state === "noTerrain") {
      require(restoreComposition, "composition-probe-not-active");
      restoreTerrainColour = hideTerrainColour();
    } else {
      throw Error("unknown-composition-probe");
    }
    await liveFrame();
    await next();
    await next();
  }

  window.__vp01Probe = { ready, viewport, displayChrome, inspect, composition, captureObject, captureSelection, captureTerrain };
}
