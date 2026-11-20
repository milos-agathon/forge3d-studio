import type { Asset, Project, SceneObject, TerrainPreview, ViewportMode } from "../bridge/types";
import { topImagery } from "../state/cartography.ts";
import { chooseViewportBackend, supportsTransform, type BackendState, type RendererPreference, type Triple } from "./forge3dWebMapping.ts";
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
  sunShadows: boolean;
  terrainSunShadows: boolean;
  imageryAsset: string | null;
  studioSkyIntensity: number;
}

function viewportProjectSettings(project: Project | null): ViewportProjectSettings {
  const hasHdri = project?.render.environment != null;
  return { mode: project?.viewport.mode ?? "solid", hasHdri,
    sunShadows: project?.render.shadows ?? false, terrainSunShadows: project?.render.sunVisibility ?? false,
    imageryAsset: topImagery(project)?.asset ?? null,
    studioSkyIntensity: hasHdri ? 0 : project?.render.iblIntensity ?? 0 };
}

export function viewportTerrainBackend(frame: ViewportFrame, preference: RendererPreference,
  device: Pick<BackendState, "gpu" | "maxTextureDimension2D" | "failure"> & { sunShadowsDisabled?: boolean }) {
  const terrains = frame.objects.filter(object => object.visible && object.kind.type === "terrain");
  const object = terrains[0];
  const terrain = object && frame.terrains.get(object.id);
  const { mode, hasHdri, sunShadows, terrainSunShadows } = frame.settings;
  const { sunShadowsDisabled, ...capabilities } = device;
  const choice = chooseViewportBackend({ ...capabilities, preference, mode, hasHdri,
    terrainCount: terrains.length, resolution: terrain?.preview.resolution ?? 0,
    transformSupported: !object || supportsTransform(object.rotationDeg, object.scale),
    terrainShadows: terrainSunShadows || (sunShadows && !sunShadowsDisabled) });
  return { ...choice, object, terrain };
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

export function nativeRenderView(frame: ViewportFrame) {
  const terrain = frame.objects.find(object => object.kind.type === "terrain")?.kind;
  const camera = frame.camera;
  if (!camera || terrain?.type !== "terrain") return null;
  // MapScene frames the project DEM, even before a preview is available.
  return computeRenderView({ camera: camera.eye, aim: cameraTarget(camera, 10),
    fovDeg: camera.fovYDegrees, spanXz: terrain.worldSpanXz, dimensions: terrain.dimensions,
    elevationRange: terrain.elevationRange, zScale: terrain.zScale });
}

export function assetRevision(asset: Asset, generation = 0): string {
  return JSON.stringify([asset.id, asset.path, asset.byteSize, generation]);
}

export function terrainSampleRevision(object: SceneObject, asset: Asset | undefined, generation?: number): string | null {
  if (object.kind.type !== "terrain" || !asset) return null;
  const { dimensions, worldOriginXz, worldSpanXz, elevationRange } = object.kind;
  return JSON.stringify([assetRevision(asset, generation), dimensions, worldOriginXz, worldSpanXz, elevationRange]);
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
      if (object?.kind.type !== "terrain" || object.terrainRevision !== request.terrainRevision || object.kind.zScale !== request.zScale) {
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
    if (object?.kind.type !== "terrain" || object.terrainRevision === null) return;
    const request = { projectGeneration: this.frame.projectGeneration, objectId, terrainRevision: object.terrainRevision,
      resolution, zScale: object.kind.zScale };
    this.requests.set(objectId, request);
    if (this.frame.terrains.has(objectId)) {
      const terrains = new Map(this.frame.terrains);
      terrains.delete(objectId);
      this.frame = { ...this.frame, terrains };
    }
    return request;
  }

  isCurrent(request: TerrainPreviewRequest): boolean {
    return this.requests.get(request.objectId) === request;
  }

  acceptTerrain(request: TerrainPreviewRequest, preview: TerrainPreview): ViewportTerrain | undefined {
    if (!this.isCurrent(request)) return;
    if (this.frame.terrains.get(request.objectId)?.request === request) return;
    const terrain = { request, preview: { ...preview, spanMetresPerUnit: preview.spanMetresPerUnit ?? null }, zScale: request.zScale };
    const terrains = new Map(this.frame.terrains);
    terrains.set(request.objectId, terrain);
    this.frame = { ...this.frame, terrains };
    return terrain;
  }
}
