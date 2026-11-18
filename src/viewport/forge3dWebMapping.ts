import type { CameraInput, TerrainHeightmapInput, TerrainMaterialImage, TerrainOverlayLayerInput, TerrainOverlaysInput } from "@forge3d/web";
import type { TerrainPreview, ViewportMode } from "../bridge/types";
import { TERRAIN_VIEW_SIZE } from "./viewMath.ts";

export type RendererPreference = "auto" | "forge3d-web" | "three";
export type Triple = [number, number, number];

export interface BackendState {
  preference: RendererPreference;
  mode: ViewportMode;
  gpu: boolean;
  terrainCount: number;
  transformSupported: boolean;
  hasHdri: boolean;
  terrainShadows: boolean;
  resolution: number;
  maxTextureDimension2D?: number;
  failure?: string;
}

export function chooseViewportBackend(s: BackendState) {
  const three = (reason: string) => ({ backend: "three" as const, reason });
  if (s.mode === "rendered") return { backend: "native" as const, reason: "Rendered mode" };
  if (s.preference === "three") return three("View menu override");
  if (!s.gpu) return three("WebGPU unavailable");
  if (s.mode === "material" && s.hasHdri) return three("Material HDRI");
  if (!s.terrainCount) return three("No visible terrain");
  if (s.terrainCount !== 1) return three("Multiple visible terrains");
  if (!s.transformSupported) return three("Terrain transform");
  if (!s.resolution) return three("Loading terrain");
  if (s.terrainShadows) return three("Terrain shadows");
  if (s.maxTextureDimension2D !== undefined && s.resolution > s.maxTextureDimension2D)
    return three("Terrain exceeds GPU texture limit");
  if (s.failure) return three(s.failure);
  return { backend: "forge3d-web" as const, reason: "WebGPU available" };
}

export function supportsTransform(rotation: Triple, scale: Triple): boolean {
  return rotation.every(v => v === 0) && scale[0] > 0 && scale.every(v => v === scale[0]);
}

// Dense WebGPU terrain has a fixed 0.24-world-unit edge skirt. Render in
// ground units and transform the Studio camera into that same coordinate system.
export function studioUnitsPerGroundUnit(preview: TerrainPreview): number {
  return TERRAIN_VIEW_SIZE / Math.max(...preview.spanXz) / (preview.spanMetresPerUnit ?? 1);
}

function linearToSrgb(v: number): number {
  return v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
}

const hillshadeSrgb = Uint8Array.from({ length: 256 }, (_, v) => Math.round(255 * linearToSrgb(v / 255)));

interface TerrainAppearance {
  drape?: TerrainMaterialImage;
  vertexColors?: ArrayLike<number>;
}

export function imageryOverlays(image: TerrainMaterialImage): TerrainOverlaysInput {
  return { outputSize: [image.width, image.height],
    layers: [{ name: "Imagery", image, extent: [0, 0, 1, 1], blendMode: "normal" }] };
}

// Columns of the projected texture-to-screen Jacobian, in pixels per source texel.
// Its inverse gives texels per screen pixel, the usual texture LOD calculation.
export function imageryMipLevel(dxX: number, dxY: number, dyX: number, dyY: number, maxDimension: number) {
  const area = Math.abs(dxX * dyY - dxY * dyX);
  if (!area || !Number.isFinite(area)) return 0;
  const density = Math.max(Math.hypot(dxY, dyY), Math.hypot(dxX, dyX)) / area;
  return Math.max(0, Math.min(Math.floor(Math.log2(density)), Math.floor(Math.log2(maxDimension))));
}

function terrainLayers(resolution: number, hillshade: Uint8Array | undefined,
  vertexColors?: ArrayLike<number>): TerrainOverlayLayerInput[] {
  const layers: TerrainOverlayLayerInput[] = [];
  if (vertexColors) {
    // The runtime ramp accepts eight stops. Studio vertex colours already include
    // all 32 engine stops and the project's blend with clay, in linear RGB.
    const data = new Uint8Array(resolution * resolution * 4);
    for (let i = 0; i < resolution * resolution; i++) {
      for (let c = 0; c < 3; c++) data[i * 4 + c] = Math.round(255 * linearToSrgb(vertexColors[i * 3 + c]));
      data[i * 4 + 3] = 255;
    }
    // Put the centres of the outer texels on the outer terrain vertices.
    const edge = 0.5 / (resolution - 1);
    layers.push({ name: "Elevation ramp", image: { width: resolution, height: resolution, data },
      extent: [-edge, -edge, 1 + edge, 1 + edge], blendMode: "normal" });
  }
  if (hillshade) layers.push({ name: "Hillshade", image: { width: resolution, height: resolution,
    data: hillshade.map((v, i) => i % 4 === 3 ? v : hillshadeSrgb[v]) },
    extent: [0, 0, 1, 1], blendMode: "multiply", zOrder: layers.length });
  return layers;
}

export function terrainInput(preview: TerrainPreview, zScale: number, clay: Triple,
  hillshade?: Uint8Array, appearance: TerrainAppearance = {}): TerrainHeightmapInput {
  const { resolution, spanXz: [width, depth], minElevation, maxElevation } = preview;
  const layers = appearance.drape ? undefined : terrainLayers(resolution, hillshade, appearance.vertexColors);
  const groundUnits = preview.spanMetresPerUnit ?? 1;
  const span = resolution - 1;
  // A constant DEM has zero height in the Studio. Use a nonempty domain
  // for the runtime and retain its lower endpoint so every vertex stays flat.
  const domainMax = maxElevation > minElevation ? maxElevation : minElevation + Math.max(1, Math.abs(minElevation));
  return {
    width: resolution, height: resolution, heights: Float32Array.from(preview.heights),
    domain: [minElevation, domainMax], exaggeration: zScale * groundUnits,
    spacing: [width * groundUnits / span, depth * groundUnits / span],
    renderMode: "perspective",
    material: {
      albedoMode: "material", materialSet: [{ baseColor: [linearToSrgb(clay[0]), linearToSrgb(clay[1]), linearToSrgb(clay[2])], roughness: 0.95, metallic: 0 }],
      hueVariation: 0, pom: { enabled: false }, detail: { enabled: false },
    },
    overlays: appearance.drape ? imageryOverlays(appearance.drape) : layers?.length ? { layers } : undefined,
  };
}

export function cameraInput(position: Triple, target: Triple, up: Triple, fov: number,
  near: number, far: number, translation: Triple, scale: number): CameraInput {
  const local = (v: Triple): Triple => [(v[0] - translation[0]) / scale,
    (v[1] - translation[1]) / scale, (v[2] - translation[2]) / scale];
  return { position: local(position), target: local(target), up,
    fovYDegrees: fov, near: near / scale, far: far / scale };
}
