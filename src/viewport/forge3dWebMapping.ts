import type { CameraInput, TerrainDataset, TerrainHeightmapInput, TerrainMaterialImage, TerrainOverlayLayerInput, TerrainOverlaysInput } from "@forge3d/web";
import { type BufferGeometry, Euler, MathUtils, Matrix3, Matrix4, Vector3 } from "three";
import type { ViewportDimensions, ViewportObject, ViewportTerrain } from "./viewportState.ts";
import type { SceneObject, TerrainPreview, ViewportMode } from "../bridge/types";
import { TERRAIN_VIEW_SIZE } from "./viewMath.ts";

export type RendererPreference = "auto" | "forge3d-web" | "three";
export type Triple = [number, number, number];
export interface UniformTransform {
  translation: Triple;
  scale: number;
}

export interface TerrainTransform extends UniformTransform {
  objectScale: number;
  halfSpanXz: [number, number];
  gridHalfSpanXz: [number, number];
  boundsXz: [[number, number], [number, number]];
}

export interface BackendState {
  preference: RendererPreference;
  mode: ViewportMode;
  gpu: boolean;
  terrainCount: number;
  transformSupported: boolean;
  hasHdri: boolean;
  terrainShadows: boolean;
  failure?: string;
}

export function chooseViewportBackend(s: BackendState) {
  const three = (reason: string) => ({ backend: "three" as const, reason });
  if (s.mode === "rendered") return { backend: "native" as const, reason: "Rendered mode" };
  if (s.preference === "three") return three("View menu override");
  if (!s.gpu) return three("WebGPU unavailable");
  if (s.mode === "material" && s.hasHdri) return three("Material HDRI");
  if (s.terrainCount > 1) return three("Multiple visible terrains");
  if (s.terrainCount && !s.transformSupported) return three("Terrain transform");
  if (s.terrainCount && s.terrainShadows) return three("Terrain shadows");
  if (s.failure) return three(s.failure);
  return { backend: "forge3d-web" as const, reason: "WebGPU available" };
}

export function supportsTransform(rotation: Triple, scale: Triple): boolean {
  return rotation.every(v => v === 0) && scale[0] > 0 && scale.every(v => v === scale[0]);
}

// Dense WebGPU terrain has a fixed 0.24-world-unit edge skirt. Render in
// ground units and transform the Studio camera into that same coordinate system.
export function studioUnitsPerGroundUnit(preview: TerrainPreview): number {
  return TERRAIN_VIEW_SIZE / Math.max(...terrainGroundSpan(preview));
}

export function terrainGroundSpan(preview: TerrainPreview): [number, number] {
  const [width, depth] = preview.spanXz;
  const units = preview.spanMetresPerUnit ?? 1;
  return [width * units, depth * units];
}

// Every finite binary64 is an integer multiple of 2^-1074. Use those units
// when placing the four inclusive edges: rounding an intermediate radius can
// lose a corner, and a tolerance can admit its nearest exterior neighbour.
const bits = new DataView(new ArrayBuffer(8));
function binary64Units(value: number): bigint {
  bits.setFloat64(0, Math.abs(value));
  const raw = bits.getBigUint64(0);
  const exponent = raw >> 52n;
  const fraction = raw & ((1n << 52n) - 1n);
  const units = exponent === 0n ? fraction : ((1n << 52n) + fraction) << (exponent - 1n);
  return value < 0 ? -units : units;
}

// Round a ratio of integer units once, to the nearest binary64 (ties to even).
function roundedCoordinate(numerator: bigint, denominator: bigint): number {
  const magnitude = numerator < 0n ? -numerator : numerator;
  const whole = magnitude / denominator;
  const shift = Math.max(0, whole.toString(2).length - 53);
  const divisor = denominator << BigInt(shift);
  let significand = magnitude / divisor;
  const twiceRemainder = (magnitude % divisor) * 2n;
  if (twiceRemainder > divisor || (twiceRemainder === divisor && (significand & 1n) === 1n)) significand++;
  const value = Number(significand) * 2 ** (shift - 1074);
  return numerator < 0n ? -value : value;
}

export function terrainTransform(preview: TerrainPreview, translation: Triple, objectScale: number): TerrainTransform {
  const [width, depth] = preview.spanXz;
  const longest = binary64Units(Math.max(width, depth));
  const halfSize = BigInt(TERRAIN_VIEW_SIZE / 2) * binary64Units(objectScale);
  function axis(side: number, centre: number) {
    const extent = halfSize * binary64Units(side);
    const offset = binary64Units(centre) * longest;
    const bounds: [number, number] = [roundedCoordinate(offset - extent, longest), roundedCoordinate(offset + extent, longest)];
    return { half: roundedCoordinate(extent, longest), bounds };
  }
  const x = axis(width, translation[0]), z = axis(depth, translation[2]);
  const { spacing } = terrainGrid(preview, 1);
  const centre = (preview.resolution - 1) / 2;
  return { translation: [...translation], scale: objectScale * studioUnitsPerGroundUnit(preview), objectScale,
    halfSpanXz: [x.half, z.half], gridHalfSpanXz: [centre * spacing[0], centre * spacing[1]], boundsXz: [x.bounds, z.bounds] };
}

export function studioToRuntime([x, y, z]: Triple, { translation: [tx, ty, tz], scale }: UniformTransform): Triple {
  return [(x - tx) / scale, (y - ty) / scale, (z - tz) / scale];
}

export function sceneObjectVisibility(objects: readonly SceneObject[] = []): ReadonlyMap<string, boolean> {
  const scene = new Map(objects.map(object => [object.id, object]));
  const inherited = new Map<string, boolean>();
  const path: string[] = [];
  for (const object of objects) {
    let node: SceneObject | undefined = object;
    while (node && !inherited.has(node.id)) {
      // An unfinished path that reaches itself is a hidden cycle.
      inherited.set(node.id, false);
      path.push(node.id);
      if (!node.visible) break;
      node = node.parent ? scene.get(node.parent) : undefined;
    }
    const visible = !node || inherited.get(node.id) === true;
    for (const id of path) inherited.set(id, visible);
    path.length = 0;
  }
  return inherited;
}

export function viewportPose(object: SceneObject) {
  const tuple = (v: typeof object.transform.translation): Triple => [v.x, v.y, v.z];
  return { translation: tuple(object.transform.translation), rotationDeg: tuple(object.transform.rotationDeg),
    scale: tuple(object.transform.scale) };
}

type TransformNode = Pick<ViewportObject, "id" | "parent" | "translation" | "rotationDeg" | "scale">;

export function localMatrix(object: TransformNode) {
  const [x, y, z] = object.rotationDeg.map(MathUtils.degToRad);
  return new Matrix4().makeRotationFromEuler(new Euler(x, y, z, "ZYX")).scale(new Vector3(...object.scale))
    .setPosition(...object.translation);
}

// Effective visibility has already excluded cycles. Keep the full affine
// product: nonuniform scale followed by rotation can introduce shear.
export function objectParentWorld(parentId: string, byId: ReadonlyMap<string, TransformNode>) {
  const matrix = new Matrix4();
  let parent = byId.get(parentId);
  let singular = false;
  const seen = new Set<string>();
  while (parent && !seen.has(parent.id)) {
    seen.add(parent.id);
    singular ||= parent.scale.includes(0);
    matrix.premultiply(localMatrix(parent));
    parent = parent.parent ? byId.get(parent.parent) : undefined;
  }
  return { matrix, singular };
}

// The inverse is used with f32 storage and scatter matrices. A rotated
// zero-scale ancestor can acquire a nonzero determinant through cancellation.
function stableLinearPart(matrix: Matrix4, epsilon: number) {
  const linear = new Matrix3().setFromMatrix4(matrix);
  const inverse = linear.clone().invert();
  const condition = Math.hypot(...linear.elements) * Math.hypot(...inverse.elements);
  return condition > 0 && condition * epsilon < 0.01 ? { linear, inverse } : undefined;
}

export function worldXAxis(parent: Matrix4) {
  const basis = stableLinearPart(parent, Number.EPSILON);
  if (!basis) return;
  return { linear: basis.linear, local: new Vector3(1, 0, 0).applyMatrix3(basis.inverse).toArray() };
}

export function runtimeMatrix(world: Matrix4, placement: UniformTransform) {
  // Subtract the Studio origin in double precision before packing the ABI's four rows.
  const relative = world.clone();
  for (let i = 0; i < 3; i++) relative.elements[12+i] -= placement.translation[i];
  const s = 1 / placement.scale;
  return relative.premultiply(new Matrix4().makeScale(s,s,s));
}

export function scatterGeometry(geometry: BufferGeometry, relative: Matrix4, singular = false) {
  const world = relative.clone();
  // Match the pinned scatter ABI's determinant check on the packed matrix.
  // Keep the shape of a flattened box, including its two opposing faces.
  const stable = stableLinearPart(world, 2 ** -23);
  world.fromArray(new Float32Array(world.elements));
  const determinant = world.determinant();
  if (singular || !stable || !stableLinearPart(world, 2 ** -23) || Math.abs(determinant) < 1e-12) {
    const origin = new Vector3().setFromMatrixPosition(world);
    world.setPosition(0, 0, 0);
    geometry.attributes.position.applyMatrix4(world);
    // Preserve local front winding when a thin mirrored basis is baked.
    if (!singular && relative.determinant() < 0) {
      const index = geometry.index!;
      for (let i = 0; i < index.count; i += 3) {
        const b = index.getX(i+1);
        index.setX(i+1, index.getX(i+2));
        index.setX(i+2, b);
      }
    }
    geometry.computeVertexNormals();
    world.makeTranslation(origin);
  }
  return { geometry, transforms: new Float32Array(world.transpose().elements) };
}

export function runtimeToStudio([x, y, z]: Triple, transform: UniformTransform | TerrainTransform): Triple {
  const { translation: [tx, ty, tz], scale } = transform;
  function horizontal(value: number, origin: number, axis: 0 | 1) {
    if ("boundsXz" in transform) {
      const edge = transform.gridHalfSpanXz[axis];
      if (value === -edge) return transform.boundsXz[axis][0];
      if (value === edge) return transform.boundsXz[axis][1];
    }
    return origin + scale * value;
  }
  return [horizontal(x, tx, 0), ty + scale * y, horizontal(z, tz, 1)];
}

function terrainGrid(preview: TerrainPreview, zScale: number): { spacing: [number, number]; exaggeration: number } {
  const [width, depth] = terrainGroundSpan(preview);
  const intervals = preview.resolution - 1;
  return { spacing: [width / intervals, depth / intervals], exaggeration: zScale };
}

type HeightGrid = Pick<TerrainPreview, "resolution" | "minElevation" | "maxElevation"> & { heights: ArrayLike<number> };

function domainUpper(min: number, max: number) {
  // The runtime widens coincident Float32 endpoints symmetrically. Widen
  // upwards before upload to keep the accepted lower datum at local Y = 0.
  return Math.fround(max) > Math.fround(min) ? max : min + Math.max(1, Math.abs(min));
}

export function flatTextureDomain(grid: Pick<HeightGrid, "minElevation" | "maxElevation">, origin = 0) {
  return Math.fround(grid.minElevation - origin) === Math.fround(grid.maxElevation - origin);
}

/** The sampler's accepted elevation can round past either source bound. */
export function terrainVertexRelief(grid: HeightGrid, height: number): number {
  return height - grid.minElevation;
}

// Keep raw texture bytes when they meet Studio's placement tolerance across
// the supported exaggeration range. Otherwise upload metres relative to the
// source datum, so subtracting two large Float32 values cannot erase relief.
export function terrainHeightOrigin(preview: TerrainPreview): number {
  if (flatTextureDomain(preview)) {
    return preview.heights.some(h => h !== preview.minElevation) ? preview.minElevation : 0;
  }
  const low = Math.fround(preview.minElevation);
  const maxVerticalScale = 50 * studioUnitsPerGroundUnit(preview);
  const losesPrecision = preview.heights.some(height => {
    const sample = Math.fround(height);
    const reliefError = (sample - low) - terrainVertexRelief(preview, height);
    return Math.max(Math.abs(sample - height), Math.abs(reliefError)) * maxVerticalScale > 1e-4;
  });
  return losesPrecision ? preview.minElevation : 0;
}

/** Interpolate the drawn triangles across the NE/SW diagonal. */
export function terrainSurfaceRelief(grid: HeightGrid, col: number, row: number): number {
  const last = grid.resolution - 1;
  const x = Math.min(last, Math.max(0, col)), z = Math.min(last, Math.max(0, row));
  const i = Math.min(last - 1, Math.floor(x)), j = Math.min(last - 1, Math.floor(z));
  const fx = x - i, fz = z - j;
  const nw = j * grid.resolution + i;
  const at = (index: number) => terrainVertexRelief(grid, grid.heights[index]);
  const ne = at(nw + 1), sw = at(nw + grid.resolution);
  if (fx + fz <= 1) return at(nw) * (1 - fx - fz) + ne * fx + sw * fz;
  return at(nw + grid.resolution + 1) * (fx + fz - 1) + ne * (1 - fz) + sw * (1 - fx);
}

// Classify the inclusive Studio bounds before subtracting a potentially large
// translation. Only accepted points may be moved inward to survive grid division.
function gridQueryCoordinate(value: number, origin: number, scale: number, [lower, upper]: [number, number], spacing: number, count: number) {
  const half = (count - 1) / 2;
  const edge = half * spacing;
  if (value < lower || value > upper) return;
  let ground = (value - origin) / scale;
  if (value <= lower) ground = -edge;
  if (value >= upper) ground = edge;
  ground = Math.min(edge, Math.max(-edge, ground));
  return Math.abs(ground / spacing) > half ? Math.sign(ground) * (1 - Number.EPSILON) * edge : ground;
}

export function queryTerrainDataset(dataset: TerrainDataset, terrain: ViewportTerrain, transform: TerrainTransform, x: number, z: number) {
  const { translation, scale } = transform;
  const groundX = gridQueryCoordinate(x, translation[0], scale, transform.boundsXz[0], dataset.spacing[0], dataset.width);
  const groundZ = gridQueryCoordinate(z, translation[2], scale, transform.boundsXz[1], dataset.spacing[1], dataset.height);
  if (groundX === undefined || groundZ === undefined) return;
  const hit = dataset.query(groundX, groundZ);
  if (!hit) return;
  const { preview, zScale } = terrain;
  const relief = terrainSurfaceRelief({ resolution: dataset.width, heights: dataset.heights,
    minElevation: Math.fround(dataset.domain[0]), maxElevation: Math.fround(dataset.domain[1]) },
    hit.gridPosition[0], hit.gridPosition[1]);
  const worldPosition: [number, number, number] = [x, translation[1] + relief * zScale * scale, z];
  const origin = terrain.heightOrigin;
  // A collapsed absolute texture represents the exact source datum. Grids
  // with sub-Float32 relief instead carry their own relative height origin.
  const elevation = origin === 0 && preview.minElevation !== 0 && flatTextureDomain(preview)
    ? preview.minElevation : hit.elevation + origin;
  return { ...hit, elevation, worldPosition };
}

/** Terrain rows run north to south, with the footprint centred on X/Z and the raw minimum at Y = 0. */
export function terrainSamplePoint(preview: TerrainPreview, zScale: number, row: number, column: number): Triple {
  const { spacing, exaggeration } = terrainGrid(preview, zScale);
  const centre = (preview.resolution - 1) / 2;
  const height = preview.heights[row * preview.resolution + column];
  return [(column - centre) * spacing[0], terrainVertexRelief(preview, height) * exaggeration, (row - centre) * spacing[1]];
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
  hillshade?: Uint8Array, appearance: TerrainAppearance = {}, origin = terrainHeightOrigin(preview)): TerrainHeightmapInput {
  const { resolution, minElevation, maxElevation } = preview;
  const heights = Float32Array.from(preview.heights, height => height - origin);
  const domain: [number, number] = [minElevation - origin, domainUpper(minElevation - origin, maxElevation - origin)];
  // The material shader clamps geometry independently of the datum used for
  // vertex placement. Its clamp must include every accepted height.
  const heightRange: [number, number] = [Math.fround(domain[0]), Math.fround(domain[1])];
  for (const h of heights) {
    heightRange[0] = Math.min(heightRange[0], h);
    heightRange[1] = Math.max(heightRange[1], h);
  }
  // tm_height_geom divides by max(range, 1e-6), even with no height curve.
  if (heightRange[1] - heightRange[0] < 1e-6) heightRange[1] = heightRange[0] + 2e-6;
  const layers = appearance.drape ? undefined : terrainLayers(resolution, hillshade, appearance.vertexColors);
  return {
    width: resolution, height: resolution,
    heights, domain, ...terrainGrid(preview, zScale),
    renderMode: "perspective",
    material: {
      clamp: { heightRange },
      albedoMode: "material", materialSet: [{ baseColor: [linearToSrgb(clay[0]), linearToSrgb(clay[1]), linearToSrgb(clay[2])], roughness: 0.95, metallic: 0 }],
      hueVariation: 0, pom: { enabled: false }, detail: { enabled: false },
    },
    overlays: appearance.drape ? imageryOverlays(appearance.drape) : layers?.length ? { layers } : undefined,
  };
}

/** Fit the complete viewport with uniformly scaled framebuffer pixels.
 * The centre stays fixed and the viewport clips the excess on just one axis. */
export function framebufferProjection({width,height,cssWidth,cssHeight}: ViewportDimensions, verticalFov: number) {
  const aspectRatio = (width * cssHeight) / (height * cssWidth);
  const stretchX = Math.max(1, aspectRatio), stretchY = Math.max(1, 1 / aspectRatio);
  const fovYDegrees = stretchY === 1 ? verticalFov :
    MathUtils.radToDeg(2 * Math.atan(stretchY * Math.tan(MathUtils.degToRad(verticalFov) / 2)));
  return { stretchX, stretchY, fovYDegrees };
}

export function cameraInput(position: Triple, target: Triple, up: Triple, fov: number,
  near: number, far: number, translation: Triple, scale: number): CameraInput {
  const transform = { translation, scale };
  return { position: studioToRuntime(position, transform), target: studioToRuntime(target, transform), up,
    fovYDegrees: fov, near: near / scale, far: far / scale };
}
