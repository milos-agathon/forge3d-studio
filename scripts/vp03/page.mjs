// Runs before the application in the desktop WebView. All fault injection
// lives here so the same Studio and runtime files are served for every run.
export function installProbe(config, observeStartup, observeContexts) {
  observeStartup(config, observeContexts);
  if (window.top !== window) return;
  performance.setResourceTimingBufferSize(2000);
  localStorage.setItem("studio.viewport.mapGrid", "0");
  const probe = window.__vp03 = { runId: config.runId, ground: config.ground, runtimes: [], ipc: [], pickers: [] };
  const diagnostic = () => window.forge3dViewportDiagnostics?.();
  const records = new WeakMap();
  const liveFacades = new Map();
  const canvasIds = new WeakMap();
  let canvases = 0;
  const activeRecord = () => {
    const viewport = diagnostic()?.terrainViewport;
    for (const [runtime, record] of liveFacades) if (viewport?.owns(runtime)) return record;
  };
  const contextIds = new WeakMap();
  const byCanvas = new WeakMap();
  const viewportContexts = new Map();
  const creatingOnCanvas = new WeakMap();
  const uploadDigests = new WeakMap();
  const datasets = new WeakMap();
  const datasetOwners = new WeakMap();
  const aliases = new Set(["webgl", "webgl2", "experimental-webgl"]);
  let contexts = 0;
  let eventId = 0;
  let datasetId = 0;
  let queriedDataset;
  const event = () => ++eventId;
  const heightDigest = heights => crypto.subtle.digest("SHA-256", Float32Array.from(heights)).then(bytes =>
    [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, "0")).join(""));
  const gridGeometry = ({ width, height, spacing, exaggeration, domain }) =>
    ({ width, height, spacing: [...spacing], exaggeration, domain: [...domain] });

  // Freeze only the viewport callback that received the skipped render. Other
  // animation callbacks must still run so Chromium can present the frame.
  const requestFrame = window.requestAnimationFrame.bind(window);
  let runningCallback;
  let pausedCallback;
  window.requestAnimationFrame = callback => requestFrame(time => {
    if (callback === pausedCallback) {
      probe.retryHeld = true;
      probe.releaseTerrainRetry = () => {
        pausedCallback = undefined;
        delete probe.retryHeld;
        delete probe.releaseTerrainRetry;
        window.requestAnimationFrame(callback);
      };
      return;
    }
    runningCallback = callback;
    try { callback(time); }
    finally { runningCallback = undefined; }
  });

  const getContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, ...options) {
    const context = getContext.call(this, type, ...options);
    if (type === "webgpu" && context) {
      if (!contextIds.has(context)) contextIds.set(context, ++contexts);
      const id = contextIds.get(context);
      byCanvas.set(this, id);
      if (this.classList.contains("viewport-canvas--terrain")) viewportContexts.set(id, new WeakRef(context));
    }
    return context;
  };

  // Substitute only the selected path from the OS dialog. All project edits,
  // preview generation, renders, and disk writes go through native IPC.
  const fetch = window.fetch;
  window.fetch = async function (resource, init) {
    const url = new URL(resource instanceof Request ? resource.url : resource, location.href);
    if (url.hostname !== "ipc.localhost" || init?.method !== "POST") return fetch.apply(this, arguments);
    const command = decodeURIComponent(url.pathname.slice(1));
    if (/^plugin:dialog\|(open|save)$/.test(command) && probe.picker) {
      const { action, path } = probe.picker;
      if (command !== "plugin:dialog|" + action) throw Error(`Unexpected dialog: ${command}`);
      delete probe.picker;
      probe.pickers.push({ action, path });
      return new Response(JSON.stringify(path), { headers: { "Content-Type": "application/json", "Tauri-Response": "ok" } });
    }
    if (!["terrain_preview", "remote_cog_info", "remote_cog_preview", "create_project", "import_terrain_dem", "apply_command", "open_project", "close_project",
      "save_project", "render_frame", "render_still"].includes(command)) return fetch.apply(this, arguments);
    const call = { command, args: JSON.parse(init.body), started: event() };
    probe.ipc.push(call);
    let releaseKey;
    if (command === "terrain_preview" && probe.holdPreview) {
      delete probe.holdPreview;
      releaseKey = "releasePreview";
    } else if (probe.holdGallery?.command === command && probe.holdGallery?.url === call.args.url) {
      delete probe.holdGallery;
      releaseKey = "releaseGallery";
    }
    if (releaseKey) call.held = true;
    let response = await fetch.apply(this, arguments);
    call.ok = response.headers.get("Tauri-Response") === "ok";
    if ((command === "terrain_preview" || command === "remote_cog_preview") && call.ok) {
      let reply = await response.clone().json();
      if (command === "terrain_preview" && probe.replayPreview?.path === call.args.path && call.args.path) {
        const previous = probe.replayPreview.preview;
        delete probe.replayPreview;
        call.replayedSource = { original: await heightDigest(reply.heights), delivered: await heightDigest(previous.heights) };
        reply = previous;
        response = new Response(JSON.stringify(reply), { headers: response.headers });
      }
      if (command === "terrain_preview" && call.args.resolution === probe.wrongPreviewRequest) {
        delete probe.wrongPreviewRequest;
        reply.resolution = 8;
        reply.heights = reply.heights.slice(0, 64);
        call.replacedGrid = true;
        response = new Response(JSON.stringify(reply), { headers: response.headers });
      }
      const { width, height, resolution, heights, level, levelWidth, levelHeight } = reply;
      call.preview = { source: [width, height], grid: [resolution, resolution], samples: heights.length,
        ...(level !== undefined && { level, overview: [levelWidth, levelHeight] }) };
    }
    if ((command === "render_frame" || command === "render_still") && call.ok) {
      const { width, height, renderPath, path } = await response.clone().json();
      call.render = { width, height, renderPath, path };
    }
    if (releaseKey) await new Promise(resolve => {
      probe[releaseKey] = () => { delete probe[releaseKey]; resolve(); };
    });
    call.completed = event();
    return response;
  };

  const moduleUrl = file => new URL("forge3d-web/" + file, document.baseURI).href;
  void Promise.all([import(moduleUrl("index.js")), import(moduleUrl("forge3d_web.js"))])
    .then(([{ Forge3DRuntime, TerrainDataset }, { Forge3DRuntime: NativeRuntime }]) => {
    const nativeCreate = NativeRuntime.create;
    NativeRuntime.create = async function (canvas, options) {
      const record = creatingOnCanvas.get(canvas);
      const budget = probe.memoryOptions;
      if (record && budget) record.memoryOptions = { ...budget };
      const runtime = await nativeCreate.call(this, canvas, budget ? { ...options, ...budget } : options);
      if (record) {
        records.set(runtime, record);
        record.nativeReady = event();
        record.context = byCanvas.get(canvas);
      }
      return runtime;
    };
    const nativeDispose = NativeRuntime.prototype.dispose;
    NativeRuntime.prototype.dispose = function () {
      const result = nativeDispose.call(this);
      const record = records.get(this);
      if (record && !record.disposed) record.disposed = event();
      return result;
    };
    const create = Forge3DRuntime.create;
    Forge3DRuntime.create = async function (canvas, options) {
      const record = { id: probe.runtimes.length + 1, create: event(), options, uploads: [], frames: [], resizes: [] };
      if (!canvasIds.has(canvas)) canvasIds.set(canvas, ++canvases);
      record.canvas = canvasIds.get(canvas);
      probe.runtimes.push(record);
      creatingOnCanvas.set(canvas, record);
      const hold = probe.holdCreation;
      delete probe.holdCreation;
      try {
        if (probe.createFailure) throw Error(probe.createFailure);
        const runtime = await create.call(this, canvas, options);
        records.set(runtime, record);
        liveFacades.set(runtime, record);
        record.ready = event();
        record.context = byCanvas.get(canvas);
        if (hold) await new Promise(resolve => {
          probe.releaseCreation = () => { delete probe.releaseCreation; resolve(); };
        });
        return runtime;
      } catch (error) {
        record.error = String(error);
        throw error;
      } finally {
        creatingOnCanvas.delete(canvas);
      }
    };
    const capabilities = Forge3DRuntime.prototype.getCapabilities;
    Forge3DRuntime.prototype.getCapabilities = function () {
      const real = capabilities.call(this);
      const record = records.get(this);
      if (!record) return real;
      record.realTextureLimit = real.maxTextureDimension2D;
      return probe.terrainLimit === undefined ? real : { ...real, maxTextureDimension2D: probe.terrainLimit };
    };
    // Observe the actual WASM input, downstream of facade hooks and any
    // queued upload. Comparing the facade's arguments can miss substitutions.
    const setTerrain = NativeRuntime.prototype.setTerrain;
    NativeRuntime.prototype.setTerrain = function (terrain) {
      const record = records.get(this);
      if (record && terrain.width === probe.rejectUploadWidth) {
        delete probe.rejectUploadWidth;
        try { return setTerrain.call(this, { ...terrain, width: terrain.width - 1 }); }
        catch (error) {
          record.rejectedUpload = { at: event(), width: terrain.width, height: terrain.height, reason: error.message };
          throw error;
        }
      }
      const digest = record && heightDigest(terrain.heights);
      try { setTerrain.call(this, terrain); }
      catch (error) {
        if (record) record.rejectedUpload = { at: event(), width: terrain.width, height: terrain.height,
          code: error.code, reason: error.message };
        throw error;
      }
      if (record) {
        const upload = { at: event(), ...gridGeometry(terrain) };
        // The input is upstream of the native memory budget. Observe the actual
        // committed geometry separately, including transient downscaled grids.
        const geometry = this.getTerrainGeometryReport();
        upload.committedGrid = [...geometry.shadowCasterResolution];
        record.uploads.push(upload);
        uploadDigests.set(upload, digest.then(sha256 => { upload.heightSha256 = sha256; }));
      }
    };
    const setCamera = NativeRuntime.prototype.setCamera;
    NativeRuntime.prototype.setCamera = function (camera) {
      setCamera.call(this, camera);
      const record = records.get(this);
      if (record) record.camera = structuredClone(camera);
    };
    const setShadows = NativeRuntime.prototype.setShadows;
    NativeRuntime.prototype.setShadows = function (snapshot) {
      setShadows.call(this, snapshot);
      const record = records.get(this);
      if (record) record.shadows = { enabled: snapshot.config.enabled, csm: snapshot.csm };
    };
    const fromArray = TerrainDataset.fromArray;
    TerrainDataset.fromArray = function (input) {
      const dataset = fromArray.call(this, input);
      const record = activeRecord();
      if (record) {
        const request = diagnostic()?.frame.terrains.values().next().value?.request;
        const owner = { id: ++datasetId, runtime: record.id, request };
        datasetOwners.set(dataset, owner);
        datasets.set(record, dataset);
        record.dataset = owner;
      }
      return dataset;
    };
    const queryTerrain = TerrainDataset.prototype.query;
    TerrainDataset.prototype.query = function (x, z) {
      queriedDataset = this;
      return queryTerrain.call(this, x, z);
    };
    const resize = Forge3DRuntime.prototype.resize;
    Forge3DRuntime.prototype.resize = function (dimensions) {
      resize.call(this, dimensions);
      records.get(this)?.resizes.push(dimensions);
    };
    const render = Forge3DRuntime.prototype.render;
    Forge3DRuntime.prototype.render = function () {
      const record = records.get(this);
      const skip = record?.uploads.length > 0 && probe.skipTerrainFrame;
      if (skip) {
        if (skip === "hold-retry") pausedCallback = runningCallback;
        delete probe.skipTerrainFrame;
      }
      const submitted = skip ? false : render.call(this);
      record?.frames.push({ at: event(), submitted, uploads: record.uploads.length, dataset: record.dataset?.id, camera: record.camera,
        ...(skip && { skippedByProbe: true }) });
      return submitted;
    };
    const dispose = Forge3DRuntime.prototype.dispose;
    Forge3DRuntime.prototype.dispose = function () {
      const record = records.get(this);
      if (record && !record.disposeRequested) {
        record.queryAtDisposal = diagnostic()?.queryTerrain(...config.ground) ?? null;
        record.disposeRequested = event();
        liveFacades.delete(this);
        datasets.delete(record);
      }
      return dispose.call(this);
    };
    probe.instrumented = true;
  }).catch(error => { probe.instrumentationError = String(error); });

  const lowerCanvas = () => document.querySelector("canvas.viewport-canvas--terrain");
  const activeRuntime = () => diagnostic()?.terrainViewport.diagnosticRuntime;
  // Independently encode accepted metre samples in the accepted grid's datum.
  // Neither the WASM submission nor the query dataset supplies this oracle.
  function encoding(terrain) {
    const { minElevation, maxElevation } = terrain.preview;
    const origin = terrain.heightOrigin;
    if (origin !== 0 && origin !== minElevation) throw Error("Unexpected terrain height origin");
    const low = minElevation - origin, high = maxElevation - origin;
    const flat = Math.fround(low) === Math.fround(high);
    return { origin, flat, domain: [low, flat ? low + Math.max(1, Math.abs(low)) : high],
      sample: raw => Math.fround(raw - origin) };
  }

  function gridQuery(node, terrain, point) {
    if (!node?.visible || !terrain) return null;
    const { resolution, heights, minElevation } = terrain.preview;
    const spanXz = groundSpan(terrain.preview);
    const intervals = resolution - 1;
    const scale = 12 * node.scale[0] / Math.max(...spanXz);
    const [x, z] = point.map((value, axis) =>
      intervals / 2 + (value - node.translation[axis * 2]) * intervals / (scale * spanXz[axis]));
    if (x < 0 || z < 0 || x > intervals || z > intervals) return null;
    const i = Math.min(Math.floor(x), intervals - 1);
    const j = Math.min(Math.floor(z), intervals - 1);
    const fx = x - i;
    const fz = z - j;
    const encoded = encoding(terrain);
    const samples = [0, 1, resolution, resolution + 1].map(offset => encoded.sample(heights[j * resolution + i + offset]));
    const [nw, ne, sw, se] = samples;
    const bilinear = (nw * (1 - fx) + ne * fx) * (1 - fz) + (sw * (1 - fx) + se * fx) * fz;
    const elevation = encoded.flat && encoded.origin === 0 && minElevation !== 0 ? minElevation : encoded.origin + bilinear;
    // Raw query attributes follow bilinear interpolation. The drawn triangle
    // uses each accepted vertex's signed difference from the encoded datum.
    const low = Math.fround(encoded.domain[0]);
    const [a,b,c,d] = samples.map(v => v - low);
    const relief = fx + fz <= 1 ? a*(1-fx-fz) + b*fx + c*fz : d*(fx+fz-1) + b*(1-fz) + c*(1-fx);
    const derivativeX = ((ne - nw) * (1 - fz) + (se - sw) * fz) * terrain.zScale * intervals / spanXz[0];
    const derivativeZ = ((sw - nw) * (1 - fx) + (se - ne) * fx) * terrain.zScale * intervals / spanXz[1];
    const length = Math.hypot(derivativeX, 1, derivativeZ);
    const aspect = derivativeX || derivativeZ ? Math.atan2(-derivativeX, -derivativeZ) : 0;
    return { elevation, gridPosition: [x, z], samples, resolution,
      worldPosition: [point[0], node.translation[1] + relief * terrain.zScale * scale, point[1]],
      normal: [-derivativeX / length, 1 / length, -derivativeZ / length],
      slopeRadians: Math.atan(Math.hypot(derivativeX, derivativeZ)), aspectRadians: (aspect + 2 * Math.PI) % (2 * Math.PI) };
  }
  const groundSpan = preview => preview.spanXz.map(side => side * (preview.spanMetresPerUnit ?? 1));
  function expectedCamera(camera, node, terrain) {
    if (!camera || !node || !terrain) return null;
    const scale = 12 * node.scale[0] / Math.max(...groundSpan(terrain.preview));
    const toGround = point => point.map((value, axis) => (value - node.translation[axis]) / scale);
    const aim = camera.aim.orbitTarget ?? camera.eye.map((value, axis) => value + camera.aim.forward[axis]);
    return { position: toGround(camera.eye), target: toGround(aim), up: camera.up,
      fovYDegrees: camera.fovYDegrees, near: camera.near / scale, far: camera.far / scale };
  }
  function sampleQuery(d, point) {
    queriedDataset = undefined;
    const hit = d?.queryTerrain(...point) ?? null;
    return { hit, owner: datasetOwners.get(queriedDataset) };
  }

  probe.uploadEvidence = async () => {
    const d = diagnostic();
    const submission = d.terrainViewport.diagnosticSubmission;
    const terrain = d.frame.terrains.get(submission.terrain.objectId);
    const record = activeRecord();
    const frame = record.frames.findLast(frame => frame.submitted);
    const upload = record.uploads[frame.uploads - 1];
    if (!upload) throw Error("No WASM terrain upload for the submitted frame");
    const { resolution, heights } = terrain.preview;
    const encoded = encoding(terrain);
    const acceptedGeometry = { width: resolution, height: resolution,
      spacing: groundSpan(terrain.preview).map(side => side / (resolution - 1)), exaggeration: terrain.zScale,
      domain: encoded.domain };
    const queries = [config.ground, config.offCenter].flatMap(point => {
      const { hit, owner } = sampleQuery(d, point);
      if (!hit) return [];
      if (!owner) throw Error("The active hit did not use an observed query dataset");
      // Hash the actual dataset's storage at query time, even when construction
      // used the current request token with different values.
      return [{ point, owner, geometry: gridGeometry(queriedDataset), digest: heightDigest(queriedDataset.heights) }];
    });
    const runtime = activeRuntime();
    const dimensions = runtime.getTerrainGeometryReport().shadowCasterResolution;
    const heightsOnGpu = await runtime.readTerrainHeights();
    if (activeRuntime() !== runtime || d.terrainViewport.diagnosticSubmission?.sequence !== submission.sequence) {
      throw Error("Viewport changed during terrain height verification");
    }
    const [acceptedSha256, gpuSha256, , ...queryDigests] = await Promise.all([
      heightDigest(Float32Array.from(heights, encoded.sample)), heightDigest(heightsOnGpu), uploadDigests.get(upload), ...queries.map(query => query.digest),
    ]);
    return { acceptedSha256, acceptedGeometry, heightOrigin:encoded.origin, upload, frame: frame.at, submission: submission.sequence,
      gpu: { dimensions, count: heightsOnGpu.length, sha256: gpuSha256 },
      queries: queries.map(({ point, owner, geometry }, index) => ({ point, owner, geometry, heightSha256: queryDigests[index] })) };
  };
  probe.retainTerrain = async () => {
    const { queryTerrainDataset } = await import("/src/viewport/forge3dWebViewport.ts");
    const { terrainTransform } = await import("/src/viewport/forge3dWebMapping.ts");
    const d = diagnostic();
    const request = d.terrainViewport.diagnosticSubmission.terrain;
    const node = d.frame.objects.find(object => object.id === request.objectId);
    const terrain = d.frame.terrains.get(request.objectId);
    const dataset = datasets.get(activeRecord());
    const transform = terrainTransform(terrain.preview, node.translation, node.scale[0]);
    probe.retainedHeights = Float32Array.from(terrain.preview.heights, encoding(terrain).sample);
    probe.retainedQuery = (x, z) => queryTerrainDataset(dataset, terrain, transform, x, z);
  };

  probe.snapshot = () => {
    const d = diagnostic();
    const live = probe.runtimes.filter(record => record.nativeReady && !record.disposed);
    const contextState = [...viewportContexts].map(([id, ref]) => {
      const context = ref.deref();
      return { id, connected: !!context?.canvas.isConnected, configured: !!context?.getConfiguration() };
    });
    const runtime = activeRuntime();
    const record = activeRecord();
    const submission = d?.terrainViewport.diagnosticSubmission;
    const submitted = submission?.terrain;
    const terrains = d?.frame.objects.filter(object => object.kind.type === "terrain") ?? [];
    const submittedNode = submitted && terrains.find(object => object.id === submitted.objectId && object.visible &&
      object.terrainRevision === submitted.terrainRevision && submission.projectId === d.frame.projectId &&
      submitted.projectGeneration === d.frame.projectGeneration);
    const accepted = submittedNode && d.frame.terrains.get(submittedNode.id);
    const submittedGrid = accepted && accepted.request.resolution === submitted.resolution &&
      accepted.request.zScale === submitted.zScale && accepted.request.terrainRevision === submitted.terrainRevision &&
      accepted.request.projectGeneration === submitted.projectGeneration ? accepted : undefined;
    const node = submittedNode || terrains.find(object => object.visible) || terrains[0];
    const terrain = d?.frame.terrains.get(node?.id);
    const successfulFrame = record?.frames.findLast(frame => frame.submitted);
    const center = sampleQuery(d, config.ground);
    const offCenter = sampleQuery(d, config.offCenter);
    const canvas = lowerCanvas();
    const shownCanvas = canvas?.hidden ? d?.runtime?.renderer.domElement : canvas;
    const rect = shownCanvas?.getBoundingClientRect();
    const chrome = rect && [...document.querySelectorAll(
      ".viewport-toolbar,.viewport-instruments,.viewport-attribution,.viewport-overlay--bottom,.axis-gizmo,.viewport-problem",
    )].flatMap(element => {
      const box = element.getBoundingClientRect();
      return box.width && box.height ? [{ x: box.x - rect.x, y: box.y - rect.y, width: box.width, height: box.height }] : [];
    });
    return {
      backend: document.querySelector("[data-viewport-backend]")?.textContent.trim(),
      problem: document.querySelector(".viewport-problem")?.textContent,
      projectId: d?.frame.projectId,
      projectGeneration: d?.frame.projectGeneration,
      object: node && { id: node.id, visible: node.visible, revision: node.terrainRevision, sourceDimensions: node.kind.dimensions },
      accepted: terrain?.request ?? null,
      submission,
      query: center.hit,
      queryOwner: center.owner,
      gridQuery: gridQuery(submittedNode, submittedGrid, config.ground),
      offCenter: { point: config.offCenter, ...offCenter, gridQuery: gridQuery(submittedNode, submittedGrid, config.offCenter) },
      lastUpload: record?.uploads.at(-1),
      runtimeCamera: successfulFrame?.camera,
      expectedCamera: expectedCamera(d?.frame.camera, submittedNode, submittedGrid),
      runtimeShadows: record?.shadows,
      runtime: record?.id,
      context: record?.context,
      successfulFrame,
      runtimeDimensions: runtime && [runtime.width, runtime.height],
      dimensions: d?.frame.dimensions,
      canvasVisible: canvas && !canvas.hidden && getComputedStyle(canvas).display !== "none",
      css: rect && { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      displayDpr: window.devicePixelRatio,
      chrome,
      liveRuntimes: live.map(entry => entry.id),
      contextState,
      liveContexts: contextState.filter(context => context.connected && context.configured).map(context => context.id),
      successfulWebGL: window.__vp01Startup.contexts.filter(entry => aliases.has(entry.requested) && entry.result).length,
      editor: !!d?.runtime,
      terrainGroupVisible: d?.runtime?.objects.get(node?.id)?.visible,
      nativeView: d?.nativeView,
      camera: d?.frame.camera,
    };
  };
  probe.mask = async (includePixels = false) => {
    const runtime = activeRuntime();
    const snapshot = probe.snapshot();
    const rgba = await runtime.readRgba();
    if (runtime !== activeRuntime() || snapshot.submission.sequence !== probe.snapshot().submission?.sequence) {
      throw Error("Viewport changed during readRgba()");
    }
    if (runtime.clearColor().some(channel => channel !== 0) || rgba.length !== runtime.width * runtime.height * 4) {
      throw Error("Expected a transparent clear and a full physical viewport readback");
    }
    let data = "";
    let count = 0;
    for (let i = 3; i < rgba.length; i += 4) {
      const covered = rgba[i] !== 0;
      data += covered ? "\x01" : "\x00";
      count += Number(covered);
    }
    const result = { count, mask: btoa(data) };
    if (!includePixels) return result;
    if (typeof rgba.toBase64 === "function") return { ...result, rgba: rgba.toBase64() };
    let colors = "";
    for (let start = 0; start < rgba.length; start += 32768) {
      colors += String.fromCharCode(...rgba.subarray(start, start + 32768));
    }
    return { ...result, rgba: btoa(colors) };
  };
}
