import * as THREE from "three";
import type { Camera, CameraInput, Forge3DRuntime, LightCollection, LightingSnapshot, MaterialCollectionSnapshot, MeshLayer, TerrainDataset, TerrainMaterialImage, IblSnapshot, RgbeImage } from "@forge3d/web";
import { cameraInput, framebufferProjection, worldXAxis, cubeParentWorld, cubeScatterGeometry, imageryMipLevel, imageryOverlays, queryTerrainDataset, runtimeToStudio, terrainInput, terrainTransform,
  type RendererPreference, type TerrainTransform } from "./forge3dWebMapping";
import { measurePixelDepth, pickSurfaces, terrainRayMetres, projectCubeFaces, type PickSurfaces, type Pixel, type StudioHit, type PixelDepthHints } from "./viewportPicking";
import { hillshadePixels } from "./hillshade";
import { cameraTarget, validateTerrainPreview, viewportTerrainBackend,
  type ViewportDimensions, type ViewportFrame, type ViewportObject, type ViewportTerrain } from "./viewportState";

export type TerrainMesh = THREE.Mesh<THREE.BufferGeometry, THREE.MeshPhysicalMaterial>;
export type TerrainPresentation = { submitted: false } | { submitted: true; terrain?: TerrainMesh; cubeId?: string };
interface DrapeLevel { image?: TerrainMaterialImage; error?: string }
interface PresentedAppearance {
  skyIntensity: number;
  drape?: { width: number; height: number; level: number; settled: boolean };
}

type WebModule = typeof import("@forge3d/web");

interface View {
  preference: RendererPreference;
  background: THREE.Color;
  clay: THREE.Color;
  projectionCamera: THREE.PerspectiveCamera;
  frame: ViewportFrame;
  objectPreview?: Pick<ViewportObject, "id" | "translation" | "rotationDeg" | "scale">;
  sampling: { terrainResolution: number; remoteRung: number };
  editor?: {
    objects: Map<string, THREE.Group>;
    sunShadowsDisabled: boolean;
    skyEnabled: boolean;
  };
  editorError?: string;
}

interface UploadedTerrain {
  terrain: ViewportTerrain;
  mesh?: TerrainMesh;
  map?: THREE.Texture | null;
  ramp?: boolean;
  hillshade: boolean;
  dataset: TerrainDataset;
}

interface SubmittedFrame {
  sequence: number;
  source: ViewportFrame;
  camera: Camera;
  placement: typeof emptyTransform;
  surfaces: PickSurfaces;
  pose?: { parent: THREE.Matrix4; object: ViewportObject; axis: ReturnType<typeof worldXAxis> };
  cubeFaces?: ReturnType<typeof projectCubeFaces>;
  objectMask?: Uint8Array | Promise<Uint8Array>;
  coverageMask?: Uint8Array | Promise<Uint8Array>;
  pixelDepths?: Map<number, Promise<number>>;
  visibleIds: string[];
  projectId: string | null;
  projectGeneration: number;
  width: number;
  height: number;
  terrain?: { upload: UploadedTerrain; transform: TerrainTransform };
}

const emptyTransform = { translation: [0, 0, 0] as [number, number, number], scale: 1 };

function samePlacement(transform: TerrainTransform, object: ViewportObject) {
  return transform.objectScale === object.scale[0] &&
    transform.translation.every((value, axis) => value === object.translation[axis]);
}
const defaultSun = { direction: new THREE.Vector3(-6, -9, -4).normalize().toArray(), color: [1, 1, 1] as [number, number, number], intensity: 3 };

export function viewportErrorReason(error: unknown): string {
  const cause = error && typeof error === "object" && "message" in error ? String(error.message) : String(error);
  return error && typeof error === "object" && "code" in error ? `${error.code} · ${cause}` : cause;
}

function visibleSource(frame: ViewportFrame, terrain: ViewportTerrain): ViewportObject | undefined {
  const request = terrain.request;
  if (frame.projectGeneration !== request.projectGeneration) return;
  return frame.objects.find(object => object.id === request.objectId && object.visible &&
    object.kind.type === "terrain" && object.terrainRevision === request.terrainRevision && object.kind.zScale === request.zScale);
}

// The desktop retained-dataset control exercises the same query as the viewport.
export { queryTerrainDataset };

function depthMarker(module: WebModule, slot: string, materials = new module.MaterialCollection()) {
  materials.set(slot, { id: slot, baseColor: [0, 0, 0, 1], textures: { emissive: {
    width: 1, height: 1, format: "rgba8unorm", colorSpace: "linear", data: new Uint8Array([255, 0, 0, 255]),
  } } });
  return materials.snapshot();
}

// Display mutations on the pinned facade are synchronous only outside a capture.
// All Studio GPU reads go through this handle, including development diagnostics.
class ViewportReadback {
  #web: Forge3DRuntime;
  #idle?: Promise<void>;
  get idle() { return this.#idle; }

  constructor(web: Forge3DRuntime) { this.#web = web; }
  get width() { return this.#web.width; }
  get height() { return this.#web.height; }
  get disposed() { return this.#web.disposed; }
  clearColor() { return this.#web.clearColor(); }
  getCapabilities() { return this.#web.getCapabilities(); }
  getTerrainOverlayReport() { return this.#web.getTerrainOverlayReport(); }
  getTerrainGeometryReport() { return this.#web.getTerrainGeometryReport(); }
  getScatterStats() { return this.#web.getScatterStats(); }
  getMemoryReport() { return this.#web.getMemoryReport(); }

  private track<T>(operation: () => Promise<T>) {
    const result = (this.#idle ?? Promise.resolve()).then(operation);
    const idle = result.then(() => {}, () => {});
    this.#idle = idle;
    void idle.then(() => { if (this.#idle === idle) this.#idle = undefined; });
    return result;
  }

  readObjectMask(module: WebModule, cubeId: string, materials: MaterialCollectionSnapshot, lights: LightingSnapshot) {
    return this.track(async () => {
      // Reuse the display depth attachment in one offscreen RGBA8 draw.
      // At zero light exposure Studio terrain is black. Cube emission is
      // added after exposure, so the red channel identifies its fragments.
      const web = this.#web;
      const dark = new module.LightCollection();
      dark.setExposure(0);
      try {
        web.setLighting(dark.snapshot());
        web.setMaterials(depthMarker(module, cubeId));
        const rgba = await web.readRgba();
        const mask = new Uint8Array(rgba.length / 4);
        for (let i = 0; i < mask.length; i++) {
          const p = i * 4;
          mask[i] = rgba[p] > rgba[p + 1] ? 2 : rgba[p + 3] ? 1 : 0;
        }
        return mask;
      } finally {
        if (!web.disposed) {
          web.setMaterials(materials);
          web.setLighting(lights);
        }
      }
    });
  }

  // Compare a constant-depth marker against the original submitted draws.
  // Preserving their geometry, transforms and order includes the face the
  // GPU actually rasterized, even if the centre ray hits a different face.
  readPixelDepth(module: WebModule, submitted: SubmittedFrame, pixel: Pixel, depths: PixelDepthHints,
    cube: { layer: MeshLayer; materials: MaterialCollectionSnapshot; surface: { id: string } } | undefined, lights: LightingSnapshot) {
    return this.track(async () => {
      const web = this.#web, { camera } = submitted;
      const dark = new module.LightCollection();
      dark.setExposure(0);
      const materials = cube?.materials ?? new module.MaterialCollection().snapshot();
      const unlit = module.MaterialCollection.from(materials);
      if (cube) unlit.set(cube.surface.id, { id: cube.surface.id, baseColor: [0, 0, 0, 1] });
      const marker = depthMarker(module, "pick-depth", unlit);
      const materialIndex = marker.materials.find(m => m.slot === "pick-depth")!.index;
      const batches = cube ? [cube.layer.toBatch()] : [];
      const [x, y] = pixel;
      const offset = 4 * (y * submitted.width + x);
      try {
        web.setLighting(dark.snapshot());
        web.setMaterials(marker);
        // The marker spans the entire sample. Its plane moves by one 24-bit
        // depth increment in the last comparison and never reaches the canvas.
        return await measurePixelDepth(depths, async depth => {
          const positions = new Float32Array([[x-4,y-4], [x-4,y+12], [x+12,y-4]]
            .flatMap(([sx,sy]) => camera.screenToWorld(sx, sy, depth, submitted)));
          const triangle = new module.MeshLayer({ positions,
            indices: new Uint32Array([0,1,2,0,2,1]), normals: new Float32Array([0,1,0,0,1,0,0,1,0]),
          }, { name: "pick-depth", materialIndex, color: [1, 1, 1, 1] });
          try {
            web.setScatterBatches([...batches, triangle.toBatch()]);
            const rgba = await web.readRgba();
            return rgba[offset] > rgba[offset + 1];
          } finally { triangle.dispose(); }
        });
      } finally {
        if (!web.disposed) {
          web.setMaterials(materials);
          web.setScatterBatches(batches);
          web.setLighting(lights);
        }
      }
    });
  }

  async readCoverageMask() {
    const rgba = await this.readRgba();
    const mask = new Uint8Array(rgba.length / 4);
    for (let i = 0; i < mask.length; i++) mask[i] = rgba[i * 4 + 3];
    return mask;
  }

  readRgba() { return this.track(() => this.#web.readRgba()); }
  readTerrainHeights() { return this.track(() => this.#web.readTerrainHeights()); }
  screenshot() { return this.track(() => this.#web.screenshot()); }
}

function drawInputs({ frame, sampling }: View) {
  // Capture only inputs to the failed scene. A corrected camera, placement or
  // sampling request may draw again, even when the editor backend is unavailable.
  return JSON.stringify([frame.objects, frame.camera, frame.dimensions, frame.settings, sampling]);
}

// Presence of an entry reserves this document's Studio viewport runtime.
// A new canvas can mount while the previous runtime is still retiring.
const waitingHosts = new WeakMap<Document, Set<() => void>>();

export class ForgeTerrainViewport {
  #web?: Forge3DRuntime;
  private readback?: ViewportReadback;
  private waitingForReads?: Promise<void>;
  private lights?: LightCollection;
  private holdsRuntimeSlot = false;
  private signalRelease?: () => void;
  private owner = 0;
  private mounted = true;
  private failure?: { reason: string; inputs?: string };
  private scope?: { id: string | null; generation: number; preference: RendererPreference };
  private uploaded?: UploadedTerrain;
  private cube?: { key: string; layer: MeshLayer; materials: MaterialCollectionSnapshot;
    pose: NonNullable<SubmittedFrame["pose"]>; surface: NonNullable<PickSurfaces["cube"]> };
  private module?: WebModule;
  private sky?: { snapshot?: IblSnapshot; error?: string };
  private appliedSkyIntensity = 0;
  private materialDisplay = false;
  private background?: THREE.Color;
  private drapes = new WeakMap<THREE.Texture, Map<number, DrapeLevel>>();
  private uploadedImage?: TerrainMaterialImage;
  private verifyUpload = false;
  private admittedRead?: { heights?: Float32Array; error?: Error };
  private center = new THREE.Vector3();
  private across = new THREE.Vector3();
  private down = new THREE.Vector3();
  private lightKey = "";
  private shadowFar?: number;
  private maxDimension?: number;
  private status = "";
  private problem?: string;
  private presentedAppearance?: PresentedAppearance;
  private submitted?: SubmittedFrame;
  private readonly cameraToWorld = new THREE.Matrix4();
  private readonly clipToCamera = new THREE.Matrix4();
  private submissions = 0;

  constructor(private canvas: HTMLCanvasElement, private skyPixels: RgbeImage, private invalidate: () => void,
    private onStatus: (value: string, problem?: string) => void,
    private onAdmittedGrid: (source: ViewportTerrain, resolution: number, heights: Float32Array, owner: ViewportReadback) => void) {}

  private report(value: string, problem?: string) {
    if (this.status !== value || this.problem !== problem) {
      this.status = value;
      this.problem = problem;
      this.onStatus(value, problem);
    }
  }

  private hide() {
    this.canvas.hidden = true;
    this.submitted = undefined;
  }

  private waitForReads() {
    const idle = this.readback?.idle;
    if (!idle) return false;
    if (this.waitingForReads !== idle) {
      this.waitingForReads = idle;
      void idle.then(() => {
        if (this.waitingForReads !== idle) return;
        this.waitingForReads = undefined;
        if (this.mounted) this.invalidate();
      });
    }
    return true;
  }

  private release() {
    this.owner++;
    this.hide();
    const web = this.#web;
    this.#web = undefined;
    this.readback = undefined;
    web?.dispose();
    this.signalRelease?.();
    this.signalRelease = undefined;
    this.lights = undefined;
    this.maxDimension = undefined;
    this.uploaded = undefined;
    this.cube?.layer.dispose();
    this.cube = undefined;
    this.uploadedImage = undefined;
    this.presentedAppearance = undefined;
    this.verifyUpload = false;
    this.admittedRead = undefined;
    this.appliedSkyIntensity = 0;
    this.materialDisplay = false;
    this.lightKey = "";
    this.shadowFar = undefined;
  }

  dispose() {
    this.mounted = false;
    waitingHosts.get(this.canvas.ownerDocument)?.delete(this.invalidate);
    this.release();
  }

  private start(width: number, height: number) {
    const doc = this.canvas.ownerDocument;
    const waiting = waitingHosts.get(doc);
    if (waiting) {
      waiting.add(this.invalidate);
      return;
    }
    const waiters = new Set<() => void>();
    waitingHosts.set(doc, waiters);
    this.holdsRuntimeSlot = true;
    const owner = this.owner;
    const current = () => this.mounted && owner === this.owner;
    const run = async () => {
      const url = new URL("forge3d-web/index.js", doc.baseURI).href;
      const module: WebModule = await import(/* @vite-ignore */ url);
      if (!current()) return;
      const web = await module.Forge3DRuntime.create(this.canvas, {
        width, height, devicePixelRatio: 1, powerPreference: "high-performance",
        clearColor: [0, 0, 0, 0], alphaMode: "premultiplied",
      });
      try {
        if (!current()) return;
        const caps = web.getCapabilities();
        this.lights = new module.LightCollection();
        this.maxDimension = caps.maxTextureDimension2D;
        this.module = module;
        const readback = new ViewportReadback(web);
        const released = new Promise<void>(resolve => { this.signalRelease = resolve; });
        this.#web = web;
        this.readback = readback;
        console.info("Forge3D viewport WebGPU capabilities", caps);
        this.invalidate();
        await released;
        // The facade is revoked synchronously by release(). The native finalizer
        // runs before the last outstanding public read settles.
        await readback.idle;
      } finally {
        // A cancelled creation never reached release() with an adopted runtime.
        if (!web.disposed) web.dispose();
      }
    };
    void run().catch(error => {
      if (current()) this.failure = { reason: `WebGPU startup failed · ${viewportErrorReason(error)}` };
    }).finally(() => {
      this.holdsRuntimeSlot = false;
      waitingHosts.delete(doc);
      for (const invalidate of waiters) invalidate();
      if (this.mounted) this.invalidate();
    });
  }

  // Check health on idle frames too. Device loss must restore colour even
  // when the user has stopped moving the camera.
  lost(): boolean {
    if (!this.#web || this.failure) return false;
    try {
      const state = this.#web.getCapabilities().deviceState;
      if (state === "ready") return false;
      this.failure = { reason: state === "disposed" ? "RUNTIME_DISPOSED" : "DEVICE_LOST" };
    } catch (error) { this.failure = { reason: viewportErrorReason(error) }; }
    return true;
  }

  private prepareSky() {
    const entry: { snapshot?: IblSnapshot; error?: string } = {};
    this.sky = entry;
    void this.module!.ImageBasedLighting.fromLinear(this.skyPixels)
      .then(ibl => { entry.snapshot = ibl.snapshot(); })
      .catch(error => { entry.error = `Studio sky unavailable · ${viewportErrorReason(error)}`; })
      .finally(() => { if (this.mounted) this.invalidate(); });
  }

  private drapeLevel(camera: THREE.PerspectiveCamera, { width, height }: ViewportDimensions,
    mesh: TerrainMesh, image: HTMLImageElement) {
    // The overlay shader samples level zero. Estimate minification at the terrain
    // centre and use a filtered source level, retaining full detail on zoom.
    if (!mesh.geometry.boundingSphere) mesh.geometry.computeBoundingSphere();
    mesh.updateWorldMatrix(true, false);
    camera.updateWorldMatrix(true, false);
    const center = this.center.copy(mesh.geometry.boundingSphere!.center);
    const right = this.across.copy(center);
    const down = this.down.copy(center);
    right.x += 1 / image.naturalWidth;
    down.z += 1 / image.naturalHeight;
    for (const p of [center, right, down]) p.applyMatrix4(mesh.matrixWorld).project(camera);
    return imageryMipLevel((right.x - center.x) * width / 2, (right.y - center.y) * height / 2,
      (down.x - center.x) * width / 2, (down.y - center.y) * height / 2,
      Math.max(image.naturalWidth, image.naturalHeight));
  }

  private prepareDrape(texture: THREE.Texture<HTMLImageElement>, level: number) {
    const entry: DrapeLevel = {};
    let levels = this.drapes.get(texture);
    if (!levels) {
      levels = new Map();
      this.drapes.set(texture, levels);
    }
    levels.set(level, entry);
    const decode = this.module!.decodeOverlayImage;
    const load = async () => {
      const source = texture.image;
      if (!level) return decode(source);
      const bitmap = await createImageBitmap(source, {
        resizeWidth: Math.max(1, Math.floor(source.naturalWidth / 2 ** level)),
        resizeHeight: Math.max(1, Math.floor(source.naturalHeight / 2 ** level)), resizeQuality: "high",
      });
      try { return await decode(bitmap); } finally { bitmap.close(); }
    };
    void load().then(image => {
      // Studio's opaque three.js material uses the PNG's RGB even at nodata
      // texels. A transparent overlay there would reveal the base material.
      for (let i = 3; i < image.data.length; i += 4) image.data[i] = 255;
      entry.image = image;
    }).catch(error => { entry.error = `Imagery unavailable · ${viewportErrorReason(error)}`; })
      .finally(() => { if (this.mounted) this.invalidate(); });
  }

  sync(view: View) {
    const { frame, preference } = view;
    const projectChanged = this.scope?.id !== frame.projectId || this.scope.generation !== frame.projectGeneration;
    if (projectChanged || this.scope?.preference !== preference) {
      this.owner++;
      this.failure = undefined;
      this.scope = { id: frame.projectId, generation: frame.projectGeneration, preference };
      this.hide();
    }
    if (this.failure?.inputs !== undefined && this.failure.inputs !== drawInputs(view)) this.failure = undefined;
    if (this.uploaded && (projectChanged || !visibleSource(frame, this.uploaded.terrain))) {
      // The pinned runtime keeps the heightfield even after setScene(empty).
      // Disposing its owner is what removes it from the next frame.
      this.release();
    } else if (this.submitted?.terrain && !this.visibleSubmission(frame)) {
      this.hide();
    }
  }

  backend(view: View) {
    return viewportTerrainBackend(view.frame, view.preference, {
      gpu: !!(navigator as Navigator & { gpu?: unknown }).gpu,
      failure: this.failure?.reason,
      sunShadowsDisabled: view.editor?.sunShadowsDisabled,
      editorAvailable: !!view.editor,
    });
  }

  prepare(view: View) {
    const { frame } = view;
    this.sync(view);
    const choice = this.backend(view);
    if (choice.backend !== "forge3d-web") {
      this.release();
    } else if (!this.holdsRuntimeSlot && frame.dimensions && frame.camera) {
      this.start(frame.dimensions.width, frame.dimensions.height);
    }
    return { ...choice, runtime: this.readback, maxTextureDimension2D: this.maxDimension };
  }

  owns(runtime: Forge3DRuntime | ViewportReadback): boolean {
    return (runtime === this.readback || runtime === this.#web) && !runtime.disposed;
  }

  private fallback(view: View, reason: string, previewError?: string) {
    if (view.editor) this.report(`Viewport three.js · ${reason}`, previewError);
    else {
      const problem = `${reason} · ${view.editorError ?? "WebGL unavailable"}`;
      this.report(`Viewport unavailable · ${problem}`, problem);
    }
  }

  private setCamera(web: Forge3DRuntime, camera: CameraInput) {
    const module = this.module!;
    this.shadowFar ??= new module.CascadedShadowConfig().snapshot().maxDistance;
    // The pinned runtime validates the cascade range before checking whether
    // shadows are enabled. Keep the range in the same units as the camera.
    if (Math.fround(camera.near) >= this.shadowFar) {
      const maxDistance = Math.fround(Math.min(camera.far, camera.near * 2));
      const scene = module.Forge3DScene.create();
      try {
        scene.setShadows({ enabled: false }, { enabled: false, maxDistance });
        web.setShadows(scene.snapshot().shadows);
        this.shadowFar = maxDistance;
      } finally {
        scene.dispose();
      }
    }
    web.setCamera(camera);
  }

  private gridReady(web: Forge3DRuntime, source: ViewportTerrain) {
    // For the pinned dense grid this is the width and height of the committed
    // height texture. A successful setTerrain can reduce both under its budget.
    const geometry = web.getTerrainGeometryReport();
    const [width, height] = geometry.shadowCasterResolution;
    const requested = source.preview.resolution;
    if (geometry.mode !== "grid" || !Number.isInteger(width) || width !== height || width < 8 ||
        width > requested || geometry.vertexCount !== width * height) {
      throw new Error(`WebGPU committed an unusable ${width} × ${height} terrain grid for ${requested} × ${requested}`);
    }
    if (width === requested) return true;

    this.hide();
    const owner = this.readback!;
    const read = this.admittedRead;
    if (read?.error) throw read.error;
    if (read?.heights) {
      // draw runs after host synchronization. A changed project, object,
      // request or owner cannot publish the completed read into the new scene.
      this.onAdmittedGrid(source, width, read.heights, owner);
      this.admittedRead = undefined;
      this.invalidate();
    } else if (!read) {
      const pending: NonNullable<typeof this.admittedRead> = {};
      this.admittedRead = pending;
      void owner.readTerrainHeights().then(heights => { pending.heights = heights; }, error => {
        pending.error = new Error(`Could not read the committed terrain · ${viewportErrorReason(error)}`);
      }).finally(() => {
        if (this.mounted && this.admittedRead === pending) this.invalidate();
      });
    }
    this.report(`Viewport forge3d-web · Preparing ${width} × ${height} terrain`);
    return false;
  }

  private submitCube(web: Forge3DRuntime, cube: ReturnType<typeof viewportTerrainBackend>["cube"],
    placement: typeof emptyTransform, view: View) {
    if (!cube) {
      if (this.cube) {
        web.setScatterBatches([]);
        this.cube.layer.dispose();
        this.cube = undefined;
      }
      return;
    }
    const { material, size } = cube;
    let object = cube.object;
    if (!view.editor && view.objectPreview?.id === object.id) {
      object = { ...object, ...view.objectPreview };
    }
    const group = view.editor?.objects.get(object.id);
    group?.updateWorldMatrix(true, false);
    const parent = object.parent
      ? cubeParentWorld(object.parent, new Map(view.frame.objects.map(o => [o.id, o])))
      : undefined;
    const solid = view.frame.settings.mode === "solid";
    const baseColor = solid ? view.clay.toArray() : material.baseColor;
    const roughness = solid ? 0.62 : material.roughness, metallic = solid ? 0 : material.metallic;
    const key = JSON.stringify([object.id, size, group?.matrixWorld.elements ?? [object.translation, object.rotationDeg, object.scale],
      parent?.matrix.elements, parent?.singular, placement.translation, placement.scale, baseColor, roughness, metallic]);
    if (this.cube?.key === key) return;

    const module = this.module!;
    const { geometry, transforms } = cubeScatterGeometry(size, object, placement, group?.matrixWorld, parent);
    const materials = new module.MaterialCollection();
    materials.set(object.id, { id: object.id, baseColor: [baseColor[0], baseColor[1], baseColor[2], 1], roughness, metallic });
    const slots = materials.snapshot();
    const layer = new module.MeshLayer({
      positions: new Float32Array(geometry.attributes.position.array),
      normals: new Float32Array(geometry.attributes.normal.array),
      indices: new Uint32Array(geometry.index!.array),
    }, { name: object.id, materialIndex: slots.materials.find(slot => slot.slot === object.id)!.index,
      color: [1, 1, 1, 1], transforms });
    web.setMaterials(slots);
    web.setScatterBatches([layer.toBatch()]);
    this.cube?.layer.dispose();
    // Bake the exact packed instance matrix after the mesh upload has copied its vertices.
    geometry.applyMatrix4(new THREE.Matrix4().fromArray(transforms).transpose());
    const axis = parent?.singular ? undefined : worldXAxis(parent?.matrix ?? new THREE.Matrix4());
    this.cube = { key, layer, materials: slots, pose: { axis, object, parent: parent?.matrix ?? new THREE.Matrix4() }, surface: { id: object.id, geometry } };
  }

  draw(view: View, previewError?: string): TerrainPresentation | undefined {
    const { frame, editor } = view;
    const { backend, reason, terrain, object, cube } = this.backend(view);
    if (backend === "native") {
      this.report("Viewport native · Rendered mode");
      return;
    }
    if (backend === "three") {
      this.fallback(view, reason, previewError);
      return;
    }
    const { camera, dimensions, settings } = frame;
    const web = this.#web;
    if (!web || !camera || !dimensions) {
      this.report("Viewport forge3d-web · Starting WebGPU", previewError);
      return { submitted: false };
    }
    if (previewError && this.uploaded) {
      this.release();
      this.report(`Viewport forge3d-web · ${previewError}`, previewError);
      this.invalidate();
      return { submitted: false };
    }

    if (this.waitForReads()) {
      // An upload queued inside the facade can fail after setTerrain returns.
      // Defer the entire draw so uploads, camera and render share one JS turn.
      this.hide();
      this.report("Viewport forge3d-web · Waiting for WebGPU frame", previewError);
      return { submitted: false };
    }

    const mesh = terrain && editor?.objects.get(object.id)?.children.find(
      child => child.userData.forgeTerrain === terrain) as TerrainMesh | undefined;
    const material = settings.mode === "material";
    const drape: THREE.Texture<HTMLImageElement> | undefined = material ? mesh?.userData.drape : undefined;
    const level = drape && editor && mesh ? this.drapeLevel(view.projectionCamera, dimensions, mesh, drape.image) : 0;
    const decoded = drape ? this.drapes.get(drape)?.get(level) : undefined;
    const skyIntensity = material && (terrain || cube) && (editor?.skyEnabled ?? true) ? settings.studioSkyIntensity : 0;
    try {
      const appearanceError = decoded?.error ?? (skyIntensity ? this.sky?.error : undefined);
      if (appearanceError) throw new Error(appearanceError);
      const { width, height } = dimensions;
      if (web.width !== width || web.height !== height) web.resize({ width, height, devicePixelRatio: 1 });
      if (view.background !== this.background) {
        this.canvas.style.backgroundColor = view.background.getStyle();
        this.background = view.background;
      }
      if (drape && !decoded) this.prepareDrape(drape, level);
      if (skyIntensity && !this.sky) this.prepareSky();
      const image = decoded?.image ??
        (drape && this.uploaded?.mesh === mesh && this.uploaded?.map === drape ? this.uploadedImage : undefined);
      const waiting = object && !terrain ? "Loading terrain" : terrain && editor && !mesh ? "Preparing terrain"
        : drape && !image ? "Preparing imagery" : skyIntensity && !this.sky?.snapshot ? "Preparing studio sky" : undefined;
      const ready = terrain?.admission
        ? `WebGPU available · ${terrain.preview.resolution} × ${terrain.preview.resolution} terrain (${terrain.admission.requestedResolution} × ${terrain.admission.requestedResolution} requested)`
        : "WebGPU available";
      const status = `Viewport forge3d-web · ${previewError ?? waiting ?? ready}`;
      if ((waiting || previewError) && this.uploaded) {
        this.hide();
        this.report(status, previewError);
        return { submitted: false };
      }

      const appliedSky = !waiting && !previewError ? skyIntensity : 0;
      if (appliedSky !== this.appliedSkyIntensity) {
        web.setIbl(appliedSky && this.sky?.snapshot ? { ...this.sky.snapshot, intensity: appliedSky } : null);
        this.appliedSkyIntensity = appliedSky;
      }
      if (material !== this.materialDisplay) {
        // Calibrated on the same Bryce imagery with the Studio sky. The two
        // ACES implementations use different exposure conventions.
        web.setPostFx(material ? [{ kind: "tonemap", operator: "aces", exposure: -0.75 }] : null);
        this.materialDisplay = material;
      }
      // A cube-only frame has Studio units. Keep its origin near the camera
      // before packing either into floats. Snap so orbiting rarely reuploads the mesh.
      const target = cameraTarget(camera);
      let transform = cube && !terrain ? { scale: 1,
        translation: target.map(v => Math.round(v / 1024) * 1024) as typeof camera.eye } : emptyTransform;
      let presentedTerrain: SubmittedFrame["terrain"];
      if (terrain && !waiting && !previewError) {
        const map = mesh?.material.map;
        const ramp = mesh?.material.vertexColors;
        const hillshade = settings.hillshade;
        if (terrain !== this.uploaded?.terrain || mesh !== this.uploaded.mesh || map !== this.uploaded.map ||
            ramp !== this.uploaded.ramp || hillshade !== this.uploaded.hillshade) {
          validateTerrainPreview(terrain.preview, this.maxDimension, terrain.request.resolution);
          const color = mesh?.material.color ?? view.clay;
          const shade = mesh
            ? !drape && map && map === mesh.userData.hillshade ? mesh.userData.hillshade.image.data : undefined
            : hillshade ? hillshadePixels(terrain.preview) : undefined;
          const input = terrainInput(terrain.preview, terrain.zScale, [color.r, color.g, color.b], shade,
            { drape: image, vertexColors: ramp ? mesh?.geometry.getAttribute("color").array : undefined }, terrain.heightOrigin);
          web.setTerrain(input);
          this.admittedRead = undefined;
          const dataset = this.module!.TerrainDataset.fromArray(input);
          this.uploaded = { terrain, mesh, map, ramp, hillshade, dataset };
          this.verifyUpload = true;
        } else if (image && image !== this.uploadedImage) {
          web.setTerrainOverlays(imageryOverlays(image));
          this.admittedRead = undefined;
          this.verifyUpload = true;
        }
        this.uploadedImage = image;
        if (this.verifyUpload && !this.gridReady(web, terrain)) return { submitted: false };
        const previous = this.submitted?.terrain;
        const placement = previous && previous.upload === this.uploaded && samePlacement(previous.transform, object)
          ? previous.transform : terrainTransform(terrain.preview, object.translation, object.scale[0]);
        transform = placement;
        presentedTerrain = { upload: this.uploaded!, transform: placement };
      }

      const sun = settings.sun ?? defaultSun;
      const key = [...sun.direction, ...sun.color, sun.intensity, settings.exposure].join(",");
      if (key !== this.lightKey) {
        const lights = this.lights!;
        lights.clear();
        lights.add({ type: "directional", ...sun });
        lights.setExposure(settings.exposure);
        web.setLighting(lights.snapshot());
        this.lightKey = key;
      }
      const { stretchX, stretchY, fovYDegrees } = framebufferProjection(dimensions, camera.fovYDegrees);
      const input = cameraInput(camera.eye, target, camera.up, fovYDegrees,
        camera.near, camera.far, transform.translation, transform.scale);
      this.setCamera(web, input);
      this.submitCube(web, cube, transform, view);
      if (!web.render()) {
        this.hide();
        this.report("Viewport forge3d-web · Waiting for WebGPU frame", previewError);
        this.invalidate();
        return { submitted: false };
      }
      // Check material and overlay support on the successfully submitted frame.
      if (this.verifyUpload) {
        if (!web.getTerrainMaterialReport().enabled) throw new Error("Material path unavailable");
        if (image) {
          const overlay = web.getTerrainOverlayReport();
          if (!overlay?.enabled || overlay.width !== image.width || overlay.height !== image.height) {
            if (decoded) decoded.error = "Imagery resolution unavailable";
            throw new Error("Imagery resolution unavailable");
          }
        }
        this.verifyUpload = false;
      }
      const surfaces = { cube: this.cube?.surface,
        terrain: presentedTerrain && { id: object.id, grid: presentedTerrain.upload.dataset } };
      this.canvas.style.transform = stretchX === 1 && stretchY === 1 ? "" : `scale(${stretchX}, ${stretchY})`;
      if (presentedTerrain) {
        const lens = view.projectionCamera;
        this.cameraToWorld.compose(lens.position, lens.quaternion, lens.scale);
        this.clipToCamera.copy(lens.projectionMatrixInverse);
      }
      this.submitted = { sequence: ++this.submissions, projectId: frame.projectId,
        projectGeneration: frame.projectGeneration, width, height, source: frame, camera: new this.module!.Camera(input),
        placement: transform, pose: this.cube?.pose, visibleIds: Object.values(surfaces).flatMap(surface => surface ? [surface.id] : []),
        surfaces, terrain: presentedTerrain };
      this.canvas.hidden = false;
      this.presentedAppearance = { skyIntensity: this.appliedSkyIntensity,
        drape: image && { width: image.width, height: image.height, level, settled: image === decoded?.image } };
      this.report(status, previewError);
      return { submitted: true, terrain: presentedTerrain && mesh, cubeId: cube?.object.id };
    } catch (error) {
      const reason = viewportErrorReason(error);
      const deviceFailure = error && typeof error === "object" && "code" in error &&
        (error.code === "DEVICE_LOST" || error.code === "RUNTIME_DISPOSED");
      this.failure = { reason, inputs: deviceFailure ? undefined : drawInputs(view) };
      this.release();
      this.fallback(view, reason);
      this.invalidate();
      return;
    }
  }

  displayedCube(frame: ViewportFrame, id: string, allowPreviousFrame = false) {
    const submitted = this.submitted;
    const cube = submitted?.surfaces.cube;
    const pose = submitted?.pose;
    if (!submitted || (!allowPreviousFrame && submitted.source !== frame) ||
        submitted.projectGeneration !== frame.projectGeneration || submitted.projectId !== frame.projectId ||
        !cube || cube.id !== id || !pose || this.canvas.hidden) return;
    const geometry = cube.geometry;
    if (!geometry.boundingSphere) geometry.computeBoundingSphere();
    if (!geometry.boundingBox) geometry.computeBoundingBox();
    return { ...pose, camera: submitted.camera, center: geometry.boundingSphere!.center.toArray(), bounds: geometry.boundingBox!, localAxis: pose.axis?.local,
      width: submitted.width, height: submitted.height, scale: submitted.placement.scale };
  }

  private visibleSubmission(frame: ViewportFrame) {
    const submitted = this.submitted;
    const terrain = submitted?.terrain;
    if (!terrain || submitted.projectId !== frame.projectId || submitted.projectGeneration !== frame.projectGeneration || this.#web?.disposed !== false) return;
    const object = visibleSource(frame, terrain.upload.terrain);
    if (!object || terrain.upload.terrain !== frame.terrains.get(object.id)) return;
    if (!samePlacement(terrain.transform, object)) return;
    return terrain;
  }

  cursorElevation(frame: ViewportFrame, clientX: number, clientY: number) {
    const submission = this.submitted;
    const terrain = this.visibleSubmission(frame);
    if (!submission || !terrain || this.canvas.hidden) return null;
    const rect = this.canvas.getBoundingClientRect();
    const x = (clientX - rect.left) * submission.width / rect.width;
    const y = (clientY - rect.top) * submission.height / rect.height;
    if (!(x >= 0 && x < submission.width && y >= 0 && y < submission.height)) return null;
    const camera = submission.camera;
    const { direction } = camera.screenRay(x, y, submission);
    // The cursor extends the perspective ray back to its original Studio eye.
    // At the optical centre its direction is exactly forward, including on an inclusive DEM edge.
    const centre = x === submission.width / 2 && y === submission.height / 2;
    const eye = new THREE.Vector3().setFromMatrixPosition(this.cameraToWorld);
    const ray = new THREE.Ray(eye, new THREE.Vector3(...(centre ? camera.forward : direction)));

    // Field measures in the logical canvas before framebuffer presentation
    // scaling. Its layout box retains fractional CSS pixels on both axes.
    const layout = this.canvas.parentElement!.getBoundingClientRect();
    const u = (clientX - layout.left) / layout.width;
    const v = (clientY - layout.top) / layout.height;
    const through = new THREE.Vector3(2*u-1, 1-2*v, .5)
      .applyMatrix4(this.clipToCamera).applyMatrix4(this.cameraToWorld);
    const measurement = new THREE.Ray(eye, through.sub(eye).normalize());
    return terrainRayMetres(ray, measurement, terrain.upload.dataset, terrain.upload.terrain, terrain.transform);
  }

  /** Query the ground plane in Studio world units, against the submitted terrain. */
  queryTerrain(frame: ViewportFrame, x: number, z: number) {
    const terrain = this.visibleSubmission(frame);
    if (!terrain) return;
    return queryTerrainDataset(terrain.upload.dataset, terrain.upload.terrain, terrain.transform, x, z);
  }

  pick(frame: ViewportFrame, pixel: Pixel) {
    const submitted = this.submitted;
    if (!submitted || frame !== submitted.source) return;
    const { camera, placement, surfaces, sequence, visibleIds, terrain } = submitted;
    const result = (hit: StudioHit | null) => {
      if (this.submitted !== submitted) return;
      if (hit?.kind === "terrain" && terrain) {
        // A ray intersection on the outer edge can round just outside the
        // inclusive ground-query footprint. The intersected triangle is inside.
        const [[west, east], [north, south]] = terrain.transform.boundsXz;
        const [x, , z] = hit.worldPosition;
        hit.elevation = this.queryTerrain(frame, Math.max(west, Math.min(east, x)), Math.max(north, Math.min(south, z)))?.elevation;
      }
      return { hit, visibleIds, revision: sequence };
    };
    const faces = submitted.cubeFaces ??= surfaces.cube ? projectCubeFaces(camera, submitted, surfaces.cube.geometry) : [];
    const surface = pickSurfaces(camera, submitted, pixel, placement, surfaces, sequence, faces);
    if ("hit" in surface) return result(surface.hit);

    // With only one candidate at this pixel, display alpha gives its
    // coverage directly. Mark object IDs only when the surfaces can overlap.
    const both = surface.cube && surface.terrain;
    const key = both ? "objectMask" : "coverageMask";
    const resolve = (mask: Uint8Array) => {
      if (this.submitted !== submitted) return;
      const index = pixel[1] * submitted.width + pixel[0], sample = mask[index];
      const hit = both ? (sample === 2 ? surface.cube : sample === 1 ? surface.terrain : null)
        : sample ? surface.terrain ?? surface.cube : null;
      const hints = hit?.kind === "cube" ? surface.cubeDepths : surface.terrainDepths;
      if (!hit || !hints) return result(hit);
      const depths = submitted.pixelDepths ??= new Map<number, Promise<number>>();
      let depth = depths.get(index);
      if (!depth) {
        depth = this.readback!.readPixelDepth(this.module!, submitted, pixel, hints, this.cube, this.lights!.snapshot());
        depths.set(index, depth);
      }
      return depth.then(z => {
        const position = camera.screenToWorld(pixel[0] + .5, pixel[1] + .5, z, submitted);
        const distance = new THREE.Vector3(...position).distanceTo(new THREE.Vector3(...camera.position)) * placement.scale;
        return result({ ...hit, worldPosition: runtimeToStudio(position, placement), distance });
      }, error => {
        depths.delete(index);
        if (this.submitted === submitted) console.warn("Could not resolve viewport depth", error);
        return undefined;
      });
    };
    const mask = submitted[key] ??= (both
      ? this.readback!.readObjectMask(this.module!, surface.cube!.id, this.cube!.materials, this.lights!.snapshot())
      : this.readback!.readCoverageMask()).then(mask => submitted[key] = mask);
    if (mask instanceof Uint8Array) return resolve(mask);
    return mask.then(resolve, error => {
      submitted[key] = undefined;
      if (this.submitted === submitted) console.warn("Could not read viewport object coverage", error);
      return undefined;
    });
  }

  // Exposed by the development viewport's verification hook.
  get diagnosticRuntime() { return this.readback; }
  get diagnosticAppearance() { return this.canvas.hidden ? undefined : this.presentedAppearance; }
  get diagnosticSubmission() {
    if (!this.submitted) return;
    const { sequence, projectId, projectGeneration, width, height, visibleIds, terrain, camera, placement } = this.submitted;
    return { sequence, projectId, projectGeneration, width, height, visibleIds, camera: camera.toInput(), placement,
      terrain: terrain?.upload.terrain.request ?? null,
      requestedTerrainResolution: terrain?.upload.terrain.admission?.requestedResolution };
  }
}
