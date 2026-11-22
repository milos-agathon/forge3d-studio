import type { Asset, Project, SceneObject, TerrainPreview, ViewportMode } from "../bridge/types";
import { topImagery, topRamp } from "../state/cartography.ts";
import { isRemoteDemPath } from "../state/terrainLadder.ts";
import { chooseViewportBackend, studioToRuntime, supportsTransform, terrainGroundSpan, type BackendState, type RendererPreference, type Triple } from "./forge3dWebMapping.ts";
import { lightingRig, type LightingSun } from "./lighting.ts";
import { computeRenderView } from "./viewMath.ts";

export interface ViewportObject {
  id: string;
  visible: boolean;
  kind: SceneObject["kind"];
  translation: Triple;
  rotationDeg: Triple;
  scale: Triple;
  terrainRevision: string | null;
}

export interface ViewportTerrainPreview extends Omit<TerrainPreview, "spanMetresPerUnit"> {
  spanMetresPerUnit: number | null;
}

export interface TerrainPreviewRequest {
  projectGeneration: number;
  objectId: string;
  terrainRevision: string;
  resolution: number;
  zScale: number;
}

export interface ViewportTerrain {
  request: TerrainPreviewRequest;
  preview: ViewportTerrainPreview;
  zScale: number;
  admission?: { owner: object; requestedResolution: number };
}

export interface ViewportCamera {
  eye: Triple;
  aim: { orbitTarget: Triple } | { forward: Triple };
  up: Triple;
  fovYDegrees: number;
  near: number;
  far: number;
}

export interface ViewportDimensions {
  cssWidth: number;
  cssHeight: number;
  width: number;
  height: number;
  pixelRatio: number;
}

export interface ViewportFrame {
  projectId: string | null;
  projectGeneration: number;
  objects: readonly ViewportObject[];
  assets: readonly Asset[];
  settings: ViewportProjectSettings;
  terrains: ReadonlyMap<string, ViewportTerrain>;
  camera: ViewportCamera | null;
  dimensions: ViewportDimensions | null;
}

interface ViewportProjectSettings {
  mode: ViewportMode;
  hasHdri: boolean;
  hillshade: boolean;
  sunShadows: boolean;
  terrainSunShadows: boolean;
  imageryAsset: string | null;
  elevationRamp: boolean;
  drapedLayers: boolean;
  studioSkyIntensity: number;
  sun: LightingSun | null;
  exposure: number;
}

function viewportProjectSettings(project: Project | null): ViewportProjectSettings {
  const hasHdri = project?.render.environment != null;
  const rig = project && lightingRig(project);
  return { mode: project?.viewport.mode ?? "solid", hasHdri, hillshade: project?.viewport.hillshade ?? true,
    sunShadows: project?.render.shadows ?? false, terrainSunShadows: project?.render.sunVisibility ?? false,
    imageryAsset: topImagery(project)?.asset ?? null,
    elevationRamp: !!topRamp(project),
    drapedLayers: project?.cartography?.some(layer => layer.visible &&
      (layer.type === "vector" || layer.type === "polygon" || layer.type === "graticule" || layer.type === "labels")) ?? false,
    studioSkyIntensity: hasHdri ? 0 : project?.render.iblIntensity ?? 0,
    sun: rig?.sun ?? null, exposure: rig?.exposure ?? 1.35 };
}

export function viewportTerrainBackend(frame: ViewportFrame, preference: RendererPreference,
  device: Pick<BackendState, "gpu" | "failure"> & { sunShadowsDisabled?: boolean; editorAvailable?: boolean }) {
  const terrains = frame.objects.filter(object => object.visible && object.kind.type === "terrain");
  const object = terrains[0];
  const terrain = object && frame.terrains.get(object.id);
  const { mode, hasHdri, sunShadows, terrainSunShadows } = frame.settings;
  const { sunShadowsDisabled, editorAvailable, ...capabilities } = device;
  const choice = chooseViewportBackend({ ...capabilities, preference, mode, hasHdri,
    terrainCount: terrains.length,
    transformSupported: !object || supportsTransform(object.rotationDeg, object.scale),
    terrainShadows: terrainSunShadows || (sunShadows && !sunShadowsDisabled) });
  if (choice.backend === "forge3d-web" && editorAvailable === false) {
    const editorReason = frame.objects.some(item => item.visible && item.kind.type === "mesh") ? "Mesh objects"
      : object && frame.settings.drapedLayers ? "Cartographic layers"
      : object && mode === "material" && (frame.settings.imageryAsset || frame.settings.elevationRamp) ? "Terrain material layers"
      : null;
    if (editorReason) return { backend: "three" as const, reason: editorReason + " require three.js", object, terrain };
  }
  return { ...choice, object, terrain };
}

// The shell's local and COG samplers both clamp requests to this range.
export function boundedTerrainResolution(requested: number, limit = 256): number | undefined {
  const resolution = Math.min(256, Math.floor(limit), Math.max(8, Math.floor(requested)));
  return Number.isFinite(resolution) && resolution >= 8 ? resolution : undefined;
}

export function validateTerrainPreview(preview: TerrainPreview, limit = 256, expectedResolution?: number) {
  const { resolution, heights, spanXz, spanMetresPerUnit, minElevation, maxElevation } = preview;
  if (resolution > limit) throw new Error(`Terrain preview ${resolution} × ${resolution} exceeds the GPU texture limit of ${limit}`);
  // width/height are from the source or COG overview. The upload is the
  // sampler's square grid, whose dimensions come from resolution.
  if (!preview.ok || !Number.isInteger(resolution) || resolution < 8 || resolution > 256 ||
      !Array.isArray(heights) || heights.length !== resolution ** 2 || !heights.every(Number.isFinite)) {
    throw new Error("The DEM sampler returned an invalid height grid");
  }
  if (expectedResolution !== undefined && resolution !== expectedResolution) {
    throw new Error(`The DEM sampler returned ${resolution} × ${resolution} for a ${expectedResolution} × ${expectedResolution} request`);
  }
  if (!Array.isArray(spanXz) || spanXz.length !== 2 || !spanXz.every(value => Number.isFinite(value) && value > 0) ||
      (spanMetresPerUnit != null && (!Number.isFinite(spanMetresPerUnit) || spanMetresPerUnit <= 0)) ||
      !Number.isFinite(minElevation) || !Number.isFinite(maxElevation) || maxElevation < minElevation) {
    throw new Error("The DEM sampler returned an invalid footprint or elevation range");
  }
}

export function viewportDimensions(cssWidth: number, cssHeight: number, displayDpr: number): ViewportDimensions {
  const pixelRatio = Math.min(2, displayDpr || 1);
  return { cssWidth, cssHeight, pixelRatio,
    width: Math.floor(cssWidth * pixelRatio), height: Math.floor(cssHeight * pixelRatio) };
}

export function cameraTarget(camera: ViewportCamera, distance = 1): Triple {
  if ("orbitTarget" in camera.aim) return camera.aim.orbitTarget;
  const [x, y, z] = camera.eye;
  const [dx, dy, dz] = camera.aim.forward;
  return [x + dx * distance, y + dy * distance, z + dz * distance];
}

export function firstVisibleTerrain<T extends Pick<SceneObject, "visible" | "kind">>(frame: { objects: readonly T[] }) {
  return frame.objects.find(object => object.visible && object.kind.type === "terrain");
}

export function nativeRenderView(frame: ViewportFrame, preview?: TerrainPreview) {
  const object = firstVisibleTerrain(frame);
  const terrain = object?.kind;
  const camera = frame.camera;
  if (!camera || !object || terrain?.type !== "terrain") return null;
  const legacyRemote = !terrain.worldSpanXz && isRemoteDemPath(frame.assets.find(asset => asset.id === terrain.asset)?.path);
  const measured = preview ?? frame.terrains.get(object.id)?.preview;
  // Legacy COG projects recorded source pixels without a world footprint.
  if (legacyRemote && !measured) return null;
  const span = terrain.worldSpanXz;
  const unit = terrain.spanMetresPerUnit ?? 1;
  const placement = supportsTransform(object.rotationDeg, object.scale)
    ? { translation: object.translation, scale: object.scale[0] } : null;
  const aim = cameraTarget(camera, 10);
  return computeRenderView({
    camera: placement ? studioToRuntime(camera.eye, placement) : camera.eye,
    aim: placement ? studioToRuntime(aim, placement) : aim,
    fovDeg: camera.fovYDegrees, spanXz: measured ? terrainGroundSpan(measured) : span && [span[0] * unit, span[1] * unit],
    dimensions: terrain.dimensions,
    elevationRange: measured ? [measured.minElevation, measured.maxElevation] : terrain.elevationRange, zScale: terrain.zScale });
}

export function assetRevision(asset: Asset, generation = 0): string {
  return JSON.stringify([asset.id, asset.path, asset.byteSize, generation]);
}

export function terrainSampleRevision(object: SceneObject, asset: Asset | undefined, generation?: number): string | null {
  if (object.kind.type !== "terrain" || !asset) return null;
  const { dimensions, worldOriginXz, worldSpanXz, elevationRange, spanMetresPerUnit } = object.kind;
  return JSON.stringify([assetRevision(asset, generation), dimensions, worldOriginXz, worldSpanXz, elevationRange,
    ...(spanMetresPerUnit == null ? [] : [spanMetresPerUnit])]);
}

/** Project previews have their own lifetime. Camera updates share the same
 * object list and accepted grids. A request token can only be completed once
 * for the terrain revision and project generation that issued it. */
export class ViewportModel {
  private requests = new Map<string, TerrainPreviewRequest>();
  private frame: ViewportFrame = { projectId: null, projectGeneration: 0, objects: [], assets: [],
    settings: viewportProjectSettings(null), terrains: new Map(), camera: null, dimensions: null };

  constructor(project: Project | null = null, generation = 0) {
    this.setProject(project, generation, false);
  }

  get current(): ViewportFrame { return this.frame; }

  setProject(project: Project | null, projectGeneration: number, cameraView: boolean, assetGenerations?: ReadonlyMap<string, number>) {
    const projectId = project?.id ?? null;
    const assets = project?.assets ?? [];
    const byId = new Map(assets.map(asset => [asset.id, asset]));
    const objects = project?.scene.objects.map((object): ViewportObject => {
      const { translation, rotationDeg, scale } = object.transform;
      const asset = object.kind.type === "terrain" ? byId.get(object.kind.asset) : undefined;
      return { id: object.id, kind: object.kind,
        visible: object.visible && !(cameraView && object.id === project.scene.activeCamera),
        translation: [translation.x, translation.y, translation.z],
        rotationDeg: [rotationDeg.x, rotationDeg.y, rotationDeg.z],
        scale: [scale.x, scale.y, scale.z],
        terrainRevision: terrainSampleRevision(object, asset, asset && assetGenerations?.get(asset.id)) };
    }) ?? [];
    if (projectGeneration !== this.frame.projectGeneration || projectId !== this.frame.projectId) this.requests.clear();
    const liveTerrains = new Map(objects.map(object => [object.id, object]));
    for (const [id, request] of this.requests) {
      const object = liveTerrains.get(id);
      if (!object?.visible || object.kind.type !== "terrain" || object.terrainRevision !== request.terrainRevision || object.kind.zScale !== request.zScale) {
        this.requests.delete(id);
      }
    }
    const terrains = new Map([...this.frame.terrains].filter(([id]) => this.requests.has(id)));
    this.frame = { ...this.frame, projectId, projectGeneration, objects, assets, settings: viewportProjectSettings(project), terrains };
  }

  setCamera(camera: ViewportCamera) {
    this.frame = { ...this.frame, camera };
  }

  setDimensions(dimensions: ViewportDimensions) {
    this.frame = { ...this.frame, dimensions };
  }

  beginTerrain(objectId: string, resolution: number): TerrainPreviewRequest | undefined {
    const object = this.frame.objects.find(object => object.id === objectId);
    if (!object?.visible || object.kind.type !== "terrain" || object.terrainRevision === null) return;
    const request = { projectGeneration: this.frame.projectGeneration, objectId, terrainRevision: object.terrainRevision,
      resolution, zScale: object.kind.zScale };
    this.discardTerrain(objectId);
    this.requests.set(objectId, request);
    return request;
  }

  discardTerrain(objectId: string): boolean {
    this.requests.delete(objectId);
    if (!this.frame.terrains.has(objectId)) return false;
    const terrains = new Map(this.frame.terrains);
    terrains.delete(objectId);
    this.frame = { ...this.frame, terrains };
    return true;
  }

  isCurrent(request: TerrainPreviewRequest): boolean {
    return this.requests.get(request.objectId) === request;
  }

  /** Adopt the actual height texture without changing the project or its sampling preference. */
  admitTerrain(source: ViewportTerrain, resolution: number, heights: Float32Array, owner: object) {
    const { objectId } = source.request;
    if (this.frame.terrains.get(objectId) !== source || !this.isCurrent(source.request)) return;
    const preview = { ...source.preview, resolution, heights: Array.from(heights) };
    validateTerrainPreview(preview, source.preview.resolution - 1, resolution);
    const request = this.beginTerrain(objectId, resolution);
    if (request) return this.acceptTerrain(request, preview, {
      owner, requestedResolution: source.admission?.requestedResolution ?? source.request.resolution,
    });
  }

  acceptTerrain(request: TerrainPreviewRequest, preview: TerrainPreview, admission?: ViewportTerrain["admission"]): ViewportTerrain | undefined {
    if (!this.isCurrent(request)) return;
    if (this.frame.terrains.get(request.objectId)?.request === request) return;
    const terrain = { request, preview: { ...preview, spanMetresPerUnit: preview.spanMetresPerUnit ?? null }, zScale: request.zScale, admission };
    const terrains = new Map(this.frame.terrains);
    terrains.set(request.objectId, terrain);
    this.frame = { ...this.frame, terrains };
    return terrain;
  }
}
