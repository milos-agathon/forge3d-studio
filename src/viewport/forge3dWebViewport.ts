import * as THREE from "three";
import type { Forge3DRuntime, LightCollection, TerrainMaterialImage, IblSnapshot, RgbeImage } from "@forge3d/web";
import { cameraInput, imageryMipLevel, imageryOverlays, terrainInput, terrainTransform,
  type RendererPreference, type Triple } from "./forge3dWebMapping";
import { cameraTarget, viewportTerrainBackend, type ViewportDimensions, type ViewportFrame, type ViewportTerrain } from "./viewportState";

export type TerrainMesh = THREE.Mesh<THREE.BufferGeometry, THREE.MeshPhysicalMaterial>;
interface DrapeLevel { image?: TerrainMaterialImage; error?: string }
interface PresentedAppearance {
  skyIntensity: number;
  drape?: { width: number; height: number; level: number; settled: boolean };
}

type WebModule = typeof import("@forge3d/web");

interface View {
  preference: RendererPreference;
  sunShadowsDisabled: boolean;
  skyIntensity: number;
  background: THREE.Color;
  frame: ViewportFrame;
  objects: Map<string, THREE.Group>;
  projectionCamera: THREE.PerspectiveCamera;
  sun: THREE.DirectionalLight;
  renderer: THREE.WebGLRenderer;
}

function failureReason(error: unknown): string {
  if (error && typeof error === "object" && "code" in error) return String(error.code);
  return error instanceof Error ? error.message : String(error);
}

export class ForgeTerrainViewport {
  private web?: Forge3DRuntime;
  private lights?: LightCollection;
  private pending = false;
  private wanted = false;
  private mounted = true;
  private failure?: string;
  private lastTerrain?: ViewportTerrain;
  private lastPreference?: RendererPreference;
  private uploaded?: TerrainMesh;
  private uploadedMap: THREE.Texture | null = null;
  private uploadedRamp = false;
  private module?: WebModule;
  private sky?: { snapshot?: IblSnapshot; error?: string };
  private appliedSkyIntensity = 0;
  private materialDisplay = false;
  private background?: THREE.Color;
  private drapes = new WeakMap<THREE.Texture, Map<number, DrapeLevel>>();
  private uploadedImage?: TerrainMaterialImage;
  private verifyUpload = false;
  private center = new THREE.Vector3();
  private across = new THREE.Vector3();
  private down = new THREE.Vector3();
  private lightKey = "";
  private maxDimension?: number;
  private status = "";
  private presentedAppearance?: PresentedAppearance;

  constructor(private canvas: HTMLCanvasElement, private skyPixels: RgbeImage, private invalidate: () => void,
    private onStatus: (value: string) => void) {}

  private report(value: string) {
    if (this.status !== value) {
      this.status = value;
      this.onStatus(value);
    }
  }

  private release() {
    this.wanted = false;
    this.canvas.hidden = true;
    this.web?.dispose();
    this.web = undefined;
    this.lights = undefined;
    this.uploaded = undefined;
    this.uploadedMap = null;
    this.uploadedImage = undefined;
    this.presentedAppearance = undefined;
    this.verifyUpload = false;
    this.appliedSkyIntensity = 0;
    this.materialDisplay = false;
    this.lightKey = "";
  }

  dispose() {
    this.mounted = false;
    this.release();
  }

  private start(width: number, height: number) {
    // create() owns this canvas until it settles, even if an override changes.
    this.pending = true;
    const load = async () => {
      const url = new URL("forge3d-web/index.js", document.baseURI).href;
      const module: WebModule = await import(/* @vite-ignore */ url);
      if (!this.wanted) return;
      const web = await module.Forge3DRuntime.create(this.canvas, {
        width, height, devicePixelRatio: 1, powerPreference: "high-performance",
        clearColor: [0, 0, 0, 0], alphaMode: "premultiplied",
      });
      if (!this.wanted) { web.dispose(); return; }
      this.web = web;
      this.lights = new module.LightCollection();
      this.module = module;
      const caps = web.getCapabilities();
      this.maxDimension = caps.maxTextureDimension2D;
      console.info("Forge3D viewport WebGPU capabilities", caps);
    };
    void load().catch(error => {
      if (this.wanted) this.failure = failureReason(error);
    }).finally(() => {
      this.pending = false;
      if (this.mounted) this.invalidate();
    });
  }

  // Check health on idle frames too. Device loss must restore colour even
  // when the user has stopped moving the camera.
  lost(): boolean {
    if (!this.web || this.failure) return false;
    try {
      const state = this.web.getCapabilities().deviceState;
      if (state === "ready") return false;
      this.failure = state === "disposed" ? "RUNTIME_DISPOSED" : "DEVICE_LOST";
    } catch (error) { this.failure = failureReason(error); }
    return true;
  }

  private prepareSky() {
    const entry: { snapshot?: IblSnapshot; error?: string } = {};
    this.sky = entry;
    void this.module!.ImageBasedLighting.fromLinear(this.skyPixels)
      .then(ibl => { entry.snapshot = ibl.snapshot(); })
      .catch(error => { entry.error = `Studio sky unavailable · ${failureReason(error)}`; })
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
    }).catch(error => { entry.error = `Imagery unavailable · ${failureReason(error)}`; })
      .finally(() => { if (this.mounted) this.invalidate(); });
  }

  draw(view: View): TerrainMesh | undefined {
    const { frame } = view;
    const initial = viewportTerrainBackend(frame, view.preference, {
      gpu: !!(navigator as Navigator & { gpu?: unknown }).gpu, maxTextureDimension2D: this.maxDimension,
      sunShadowsDisabled: view.sunShadowsDisabled,
    });
    const { terrain, object } = initial;
    if (terrain !== this.lastTerrain || this.lastPreference !== view.preference) {
      this.failure = undefined;
      this.lastTerrain = terrain;
      this.lastPreference = view.preference;
    }
    const choice = initial.backend === "forge3d-web" && this.failure
      ? { backend: "three", reason: this.failure } : initial;
    if (choice.backend !== "forge3d-web") {
      this.release();
      this.report(choice.backend === "native" ? "Viewport native · Rendered mode" : `Viewport three.js · ${choice.reason}`);
      return;
    }
    const { camera, dimensions } = frame;
    const mesh = terrain && view.objects.get(object.id)?.children.find(
      child => child.userData.forgeTerrain === terrain) as TerrainMesh | undefined;
    if (!mesh || !terrain || !camera || !dimensions) {
      this.release();
      this.report("Viewport three.js · Preparing viewport");
      return;
    }
    const material = frame.settings.mode === "material";
    const drape: THREE.Texture<HTMLImageElement> | undefined = material ? mesh.userData.drape : undefined;
    const level = drape ? this.drapeLevel(view.projectionCamera, dimensions, mesh, drape.image) : 0;
    const decoded = drape ? this.drapes.get(drape)?.get(level) : undefined;
    const skyIntensity = material ? view.skyIntensity : 0;
    const appearanceError = decoded?.error ?? (skyIntensity ? this.sky?.error : undefined);
    if (appearanceError) {
      this.release();
      this.report(`Viewport three.js · ${appearanceError}`);
      return;
    }
    this.wanted = true;
    // Both layers must use the same physical pixels at fractional display scaling.
    const { width, height } = dimensions;
    if (!this.web) {
      if (!this.pending) this.start(width, height);
      this.report("Viewport three.js · Starting WebGPU");
      return;
    }
    try {
      const web = this.web;
      if (web.width !== width || web.height !== height) {
        web.resize({ width, height, devicePixelRatio: 1 });
      }
      if (drape && !decoded) this.prepareDrape(drape, level);
      const image = decoded?.image ?? (drape && this.uploaded === mesh && this.uploadedMap === drape ? this.uploadedImage : undefined);
      if (drape && !image) {
        this.canvas.hidden = true;
        this.report("Viewport three.js · Preparing imagery");
        return;
      }
      if (skyIntensity && !this.sky?.snapshot) {
        if (!this.sky) this.prepareSky();
        this.canvas.hidden = true;
        this.report("Viewport three.js · Preparing studio sky");
        return;
      }
      if (skyIntensity !== this.appliedSkyIntensity) {
        web.setIbl(skyIntensity && this.sky?.snapshot ? { ...this.sky.snapshot, intensity: skyIntensity } : null);
        this.appliedSkyIntensity = skyIntensity;
      }
      if (material !== this.materialDisplay) {
        // Calibrated on the same Bryce imagery with the Studio sky. The two
        // ACES implementations use different exposure conventions.
        web.setPostFx(material ? [{ kind: "tonemap", operator: "aces", exposure: -0.75 }] : null);
        this.materialDisplay = material;
      }
      if (view.background !== this.background) {
        this.canvas.style.backgroundColor = view.background.getStyle();
        this.background = view.background;
      }
      const { map, vertexColors } = mesh.material;
      if (mesh !== this.uploaded || map !== this.uploadedMap || vertexColors !== this.uploadedRamp) {
        const input = terrainInput(terrain.preview, terrain.zScale, [mesh.material.color.r, mesh.material.color.g, mesh.material.color.b],
          !drape && map === mesh.userData.hillshade ? mesh.userData.hillshade.image.data : undefined,
          { drape: image, vertexColors: vertexColors ? mesh.geometry.getAttribute("color").array : undefined });
        web.setTerrain(input);
        this.verifyUpload = true;
        this.uploaded = mesh;
        this.uploadedMap = map;
        this.uploadedRamp = vertexColors;
      } else if (image && image !== this.uploadedImage) {
        web.setTerrainOverlays(imageryOverlays(image));
        this.verifyUpload = true;
      }
      this.uploadedImage = image;
      const sunlight = view.sun.target.position.clone().sub(view.sun.position).normalize();
      const color: Triple = [view.sun.color.r, view.sun.color.g, view.sun.color.b];
      const exposure = view.renderer.toneMappingExposure;
      const key = [...sunlight, ...color, view.sun.intensity, exposure].join(",");
      if (key !== this.lightKey) {
        const lights = this.lights!;
        lights.clear();
        lights.add({ type: "directional", direction: sunlight.toArray(), color, intensity: view.sun.intensity });
        lights.setExposure(exposure);
        web.setLighting(lights.snapshot());
        this.lightKey = key;
      }
      const transform = terrainTransform(terrain.preview, object.translation, object.scale[0]);
      web.setCamera(cameraInput(camera.eye, cameraTarget(camera), camera.up, camera.fovYDegrees,
        camera.near, camera.far, transform.translation, transform.scale));
      if (!web.render()) {
        this.canvas.hidden = true;
        this.report("Viewport three.js · WebGPU frame unavailable");
        this.invalidate();
        return;
      }
      // The facade queues uploads during readback. Its synchronous report
      // getters are safe once render() has accepted the resulting frame.
      if (this.verifyUpload) {
        if (!web.getTerrainMaterialReport().enabled) throw new Error("Material path unavailable");
        if (image) {
          const overlay = web.getTerrainOverlayReport();
          if (!overlay?.enabled || overlay.width !== image.width || overlay.height !== image.height) {
            if (!decoded) throw new Error("Imagery resolution unavailable");
            decoded.error = "Imagery resolution unavailable";
            this.release();
            this.report(`Viewport three.js · ${decoded.error}`);
            return;
          }
        }
        this.verifyUpload = false;
      }
      this.canvas.hidden = false;
      this.presentedAppearance = { skyIntensity: this.appliedSkyIntensity,
        drape: image && { width: image.width, height: image.height, level, settled: image === decoded?.image } };
      this.report("Viewport forge3d-web · WebGPU available");
      return mesh;
    } catch (error) {
      this.failure = failureReason(error);
      this.release();
      this.report(`Viewport three.js · ${this.failure}`);
      return;
    }
  }

  // Only exposed by the development viewport's verification hook.
  get diagnosticRuntime() { return this.web; }
  get diagnosticAppearance() { return this.canvas.hidden ? undefined : this.presentedAppearance; }
}
