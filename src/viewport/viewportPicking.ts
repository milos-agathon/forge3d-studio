import type { Camera, ScreenPoint, TerrainDataset } from "@forge3d/web";
import { Box3, Frustum, Line, LineBasicMaterial, LineLoop, LineSegments, Matrix4, Mesh, Plane, Points, PointsMaterial, Ray, Raycaster, Vector2, Vector3,
  type BufferGeometry, type Group, type Intersection, type Material, type PerspectiveCamera } from "three";
import { intersectEditorObject, isEditorTriangleMesh, terrainHitElevation } from "./editorTrianglePicking.ts";
import { sampleHeight } from "./cartography.ts";
import { runtimeToStudio, studioUnitsPerGroundUnit, terrainGroundSpan, type TerrainTransform, type Triple, type UniformTransform } from "./forge3dWebMapping.ts";
import type { ViewportObject, ViewportTerrain } from "./viewportState.ts";

export type Pixel = [number, number];
type Size = { width: number; height: number; pixelRatio?: number };

export function canvasPixel(clientX: number, clientY: number, rect: DOMRectReadOnly, size: Size): Pixel | undefined {
  const x = Math.floor((clientX - rect.left) * size.width / rect.width);
  const y = Math.floor((clientY - rect.top) * size.height / rect.height);
  if (x >= 0 && x < size.width && y >= 0 && y < size.height) return [x, y];
}

export interface StudioHit {
  id: string;
  kind: "cube" | ViewportObject["kind"]["type"];
  worldPosition: Triple;
  distance: number;
  frameRevision: number;
  elevation?: number;
}

// Interpolated depth can differ by several depth-buffer increments across
// adjacent triangles. Within this window the rendering backend decides.
export function depthTieWindow(bits: number) {
  return 8 / (2 ** Math.min(bits, 24) - 1);
}

type TriangleVisitor = (a: Vector3, b: Vector3, c: Vector3) => void;

// Clip the XZ projection of the ray to each grid row. Test only the cells it
// crosses, including both neighbours when the ray lies exactly on a grid edge.
function visitTerrainCells(width: number, height: number, dx: number, dz: number, ray: Ray, far: number,
  visit: TriangleVisitor, vertexY: (index: number) => number, skirts: boolean, margin = 0, unitPlane = false, around?: Vector3) {
  const cx = (width - 1) / 2, cz = (height - 1) / 2;
  const column = (x: number) => unitPlane ? Math.fround(x * dx - .5) : (x - cx) * dx;
  const row = (z: number) => unitPlane ? Math.fround(z * dz - .5) : (z - cz) * dz;
  const vertex = (p: Vector3, x: number, z: number) =>
    p.set(column(x), vertexY(z * width + x), row(z));
  const nw = new Vector3(), ne = new Vector3(), sw = new Vector3(), se = new Vector3();
  // The pinned dense mesh appends a 0.24-ground-unit skirt to its perimeter.
  const bottomA = new Vector3(), bottomB = new Vector3();
  const skirt = (a: Vector3, b: Vector3) => {
    bottomA.copy(a).y -= 0.24;
    bottomB.copy(b).y -= 0.24;
    visit(a, b, bottomA);
    visit(b, bottomB, bottomA);
  };
  const { origin, direction } = ray;
  const ix = around && Math.floor(around.x / dx + cx), iz = around && Math.floor(around.z / dz + cz);
  const firstRow = iz === undefined ? 0 : Math.max(0, iz - 1);
  const lastRow = iz === undefined ? height - 2 : Math.min(height - 2, iz + 1);
  for (let z = firstRow; z <= lastRow; z++) {
    const north = row(z) - margin, south = row(z + 1) + margin;
    let enter = 0, exit = far;
    if (direction.z === 0) {
      if (origin.z < north || origin.z > south) continue;
    } else {
      const a = (north - origin.z) / direction.z, b = (south - origin.z) / direction.z;
      enter = Math.max(enter, Math.min(a, b));
      exit = Math.min(exit, Math.max(a, b));
      if (enter > exit) continue;
    }
    const x0 = cx + (origin.x + enter * direction.x) / dx;
    const x1 = direction.x === 0 ? x0 : cx + (origin.x + exit * direction.x) / dx;
    const start = Math.max(0, ix === undefined ? 0 : ix - 1, Math.ceil(Math.min(x0, x1) - margin / dx) - 1);
    const end = Math.min(width - 2, ix === undefined ? width - 2 : ix + 1, Math.floor(Math.max(x0, x1) + margin / dx));
    for (let x = start; x <= end; x++) {
      vertex(nw, x, z); vertex(ne, x + 1, z); vertex(sw, x, z + 1); vertex(se, x + 1, z + 1);
      if (unitPlane) {
        visit(nw, sw, ne);
        visit(sw, se, ne);
      } else {
        visit(nw, ne, sw);
        visit(ne, se, sw);
      }
      if (!skirts) continue;
      if (x === 0) skirt(nw, sw);
      if (x === width - 2) skirt(ne, se);
      if (z === 0) skirt(nw, ne);
      if (z === height - 2) skirt(sw, se);
    }
  }
}

function visitTerrain(grid: TerrainDataset, ray: Ray, far: number, visit: TriangleVisitor, margin = 0) {
  const datum = Math.fround(grid.domain[0]);
  visitTerrainCells(grid.width, grid.height, ...grid.spacing, ray, far, visit,
    i => (grid.heights[i] - datum) * grid.exaggeration, true, margin);
}

/** The submitted ray selects the surface. Measure its face with Field's mesh
 * arithmetic before rounding a raw elevation at a half-metre boundary. */
export function terrainRayMetres(submittedRay: Ray, measurementRay: Ray,
  grid: TerrainDataset, terrain: ViewportTerrain, placement: Pick<TerrainTransform, "objectScale" | "translation">) {
  const { preview, zScale } = terrain;
  const horizontal = studioUnitsPerGroundUnit(preview), s = zScale * horizontal;
  const [width, depth] = terrainGroundSpan(preview);
  const scale = placement.objectScale;
  const world = new Matrix4().makeScale(scale * (width * horizontal), scale, scale * (depth * horizontal))
    .setPosition(...placement.translation);
  const inverse = world.clone().invert();
  const ray = submittedRay.clone().applyMatrix4(inverse);
  const measurement = measurementRay.clone().applyMatrix4(inverse);
  const point = new Vector3(), nearest = new Vector3();
  let distance = Infinity, faceMeasured = false;
  const dx = 1 / (grid.width - 1), dz = 1 / (grid.height - 1);
  const vertexY = (i: number) => Math.fround((preview.heights[i] - preview.minElevation) * s);
  // Only the coarse search is padded for Float32 grid coordinates. The
  // triangle test and the world-to-local conversion use Field's arithmetic.
  visitTerrainCells(grid.width, grid.height, dx, dz,
    ray, Infinity, (a, b, c) => {
      if (!ray.intersectTriangle(a, b, c, false, point)) return;
      point.applyMatrix4(world);
      const d = submittedRay.origin.distanceTo(point);
      if (d < distance) {
        distance = d;
        nearest.copy(point);
        faceMeasured = measurement.intersectTriangle(a, b, c, false, point) !== null;
        if (faceMeasured) nearest.copy(point.applyMatrix4(world));
      }
    }, vertexY, false, 2 ** -25, true);
  if (distance === Infinity) return null;
  if (!faceMeasured) {
    // At a shared vertex the float view matrix can put the submitted hit on
    // the adjoining face. Resolve the measurement on the same local patch.
    const hit = nearest.clone(), local = hit.clone().applyMatrix4(inverse);
    let separation = Infinity;
    visitTerrainCells(grid.width, grid.height, dx, dz, measurement, Infinity, (a, b, c) => {
      if (!measurement.intersectTriangle(a, b, c, false, point)) return;
      const delta = point.applyMatrix4(world).distanceToSquared(hit);
      if (delta < separation) { separation = delta; nearest.copy(point); }
    }, vertexY, false, 2 ** -25, true, local);
  }
  return preview.minElevation + nearest.applyMatrix4(inverse).y / Math.max(1e-9, s);
}

export interface PickSurfaces {
  mesh?: { id: string; geometry: BufferGeometry; kind?: StudioHit["kind"] };
  terrain?: { id: string; grid: TerrainDataset };
}

export interface PixelDepthHints {
  minimum: number;
  maximum: number;
  hints: number[];
}

type SurfacePick = { hit: StudioHit | null } | {
  terrain: StudioHit | null; mesh: StudioHit | null;
  terrainDepths?: PixelDepthHints; meshDepths?: PixelDepthHints;
};

function clipFace(vertices: Vector3[], distance: (point: Vector3) => number) {
  const clipped: Vector3[] = [];
  let previous = vertices[vertices.length - 1];
  for (const vertex of vertices) {
    const a = distance(previous), b = distance(vertex);
    if ((a < 0) !== (b < 0)) clipped.push(previous.clone().lerp(vertex, a / (a - b)));
    if (b >= 0) clipped.push(vertex);
    previous = vertex;
  }
  return clipped;
}

type ScreenEdge = [ScreenPoint, ScreenPoint];

export function projectMeshFaces(camera: Camera, size: Size, geometry: BufferGeometry) {
  if (geometry.type !== "BoxGeometry" || !geometry.groups.length) {
    const faces: ScreenPoint[][] = [];
    const index = geometry.index!, positions = geometry.attributes.position;
    for (let i = 0; i < index.count; i += 3) {
      const corners = [0,1,2].map(k => new Vector3().fromBufferAttribute(positions, index.getX(i+k)));
      const face = projectFace(camera, size, corners);
      if (face.length >= 3) faces.push(face);
    }
    return faces;
  }
  return geometry.groups.map(({ start }) => {
    // BoxGeometry indexes the two triangles (a,b,d), (b,c,d) of each face.
    const corners = [0, 1, 4, 2].map(i => new Vector3().fromBufferAttribute(
      geometry.getAttribute("position"), geometry.index!.getX(start + i)));
    return projectFace(camera, size, corners);
  });
}

// At raster precision an edge can snap across the sample centre. When the
// centre ray misses, interpolate NDC depth along the nearest projected edge.
function nearestEdge(edges: ScreenEdge[], x: number, y: number) {
  let closestSq = 0.5; // squared distance from the centre to a physical pixel corner
  let depth: number | undefined;
  for (const [a, b] of edges) {
    const dx = b.x - a.x, dy = b.y - a.y, lengthSq = dx * dx + dy * dy;
    const t = lengthSq ? Math.min(1, Math.max(0, ((x - a.x) * dx + (y - a.y) * dy) / lengthSq)) : 0;
    const distanceSq = (a.x + t * dx - x) ** 2 + (a.y + t * dy - y) ** 2;
    const z = a.depth + t * (b.depth - a.depth);
    if (distanceSq < closestSq || (distanceSq === closestSq && z < (depth ?? Infinity))) {
      closestSq = distanceSq;
      depth = z;
    }
  }
  return depth === undefined ? undefined : { depth, distanceSq: closestSq };
}

// Use the clipped triangle boundary at a silhouette or clipping plane. The
// depth along a projected edge is linear in screen space.
function projectFace(camera: Camera, size: Size, face: Vector3[]) {
  const forward = camera.forward, eye = camera.position;
  const depth = (p: Vector3) => (p.x - eye[0]) * forward[0] + (p.y - eye[1]) * forward[1] + (p.z - eye[2]) * forward[2];
  const clipped = clipFace(clipFace(face, p => depth(p) - camera.near), p => camera.far - depth(p));
  return clipped.map(v => camera.worldToScreen(v.toArray(), size)!);
}

/** Conservative screen-space test before requesting a one-pixel GPU wire ID. */
export function strokeNearPixel(camera: Camera, size: Size, segment: [Triple, Triple], pixel: Pixel) {
  const [start,end] = segment.map(v => new Vector3(...v));
  const delta = end.clone().sub(start);
  const forward = new Vector3(...camera.forward);
  const z = start.clone().sub(new Vector3(...camera.position)).dot(forward);
  const dz = delta.dot(forward);
  let enter = 0, leave = 1;
  if (dz === 0) {
    if (z < camera.near || z > camera.far) return false;
  } else {
    const near = (camera.near-z)/dz, far = (camera.far-z)/dz;
    enter = Math.max(0,Math.min(near,far));
    leave = Math.min(1,Math.max(near,far));
    if (enter > leave) return false;
  }
  const project = (t: number) => camera.worldToScreen(start.clone().addScaledVector(delta,t).toArray(),size);
  const a = project(enter), b = project(leave);
  if (!a || !b) return true; // Defer a numerically marginal endpoint to the GPU.
  const dx = b.x-a.x, dy = b.y-a.y, lengthSq = dx*dx + dy*dy;
  const x = pixel[0]+.5-a.x, y = pixel[1]+.5-a.y;
  const t = lengthSq ? Math.min(1,Math.max(0,(x*dx + y*dy)/lengthSq)) : 0;
  return (x-t*dx)**2 + (y-t*dy)**2 <= 4;
}

function faceEdge(screen: ScreenPoint[], x: number, y: number) {
  return nearestEdge(screen.map((p, i) => [p, screen[(i + 1) % screen.length]]), x, y);
}

// Linear NDC depth extrema over the clipped footprint bound a steep face
// even when its closest projected edge is deeper than the centre-ray hit.
function pixelDepthRange(screen: ScreenPoint[], x: number, y: number) {
  const radius = Math.SQRT1_2;
  let footprint = screen.map(p => new Vector3(p.x - x, p.y - y, p.depth));
  footprint = clipFace(footprint, p => radius + p.x);
  footprint = clipFace(footprint, p => radius - p.x);
  footprint = clipFace(footprint, p => radius + p.y);
  footprint = clipFace(footprint, p => radius - p.y);
  if (!footprint.length) return;
  const zs = footprint.map(p => p.z);
  return { min: Math.min(...zs), max: Math.max(...zs) };
}

// An edge can change which face covers the sample. Even inside a grazing face,
// snapping by a fraction of a pixel can noticeably change its interpolated depth.
function meshPixelDepths(faces: ScreenPoint[][], x: number, y: number, rayDepth?: number) {
  const depths: PixelDepthHints = { minimum: 1, maximum: 0, hints: rayDepth === undefined ? [] : [rayDepth] };
  const tolerance = depthTieWindow(24);
  let nearest: ReturnType<typeof nearestEdge>;
  let steep = false;
  for (const face of faces) {
    const range = pixelDepthRange(face, x, y);
    if (!range) continue;
    depths.minimum = Math.min(depths.minimum, range.min);
    depths.maximum = Math.max(depths.maximum, range.max);
    const edge = faceEdge(face, x, y);
    if (edge) {
      depths.hints.push(edge.depth);
      if (!nearest || edge.distanceSq < nearest.distanceSq ||
        (edge.distanceSq === nearest.distanceSq && edge.depth < nearest.depth)) nearest = edge;
    }
    // Request a measurement if one raster subpixel (1/256 px in WebView2)
    // on a candidate face can exceed the same tolerance as an object depth tie.
    const atRayDepth = rayDepth !== undefined && range.min <= rayDepth + tolerance && range.max >= rayDepth - tolerance;
    if (atRayDepth && range.max - range.min > 256 * tolerance) steep = true;
  }
  return { edge: nearest, depths: nearest || steep ? depths : undefined };
}

// A shared edge inside a consistently facing terrain patch has coverage on
// both sides after rasterization. Only the patch boundary (including folds,
// DEM borders and clipped faces) needs the framebuffer to settle ownership.
function insideTerrainPatch(camera: Camera, size: Size, grid: TerrainDataset, face: Vector3[], x: number, y: number) {
  const signedArea = (a: ScreenPoint, b: ScreenPoint, c: ScreenPoint) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  const [a, b, c] = face;
  if ((b.x - a.x) * (c.z - a.z) === (b.z - a.z) * (c.x - a.x)) return false; // skirt
  const project = (v: Vector3) => {
    const s = camera.worldToScreen(v.toArray(), size);
    return s && s.depth >= 0 && s.depth <= 1 ? s : undefined;
  };
  const pa = project(a), pb = project(b), pc = project(c);
  if (!pa || !pb || !pc) return false;
  const winding = Math.sign(signedArea(pa, pb, pc));
  if (!winding) return false;
  const [dx, dz] = grid.spacing, cx = (grid.width - 1) / 2, cz = (grid.height - 1) / 2;
  const col = Math.round(Math.min(a.x, b.x, c.x) / dx + cx);
  const row = Math.round(Math.min(a.z, b.z, c.z) / dz + cz);
  const left = Math.max(0, col - 1), right = Math.min(grid.width - 1, col + 2);
  const top = Math.max(0, row - 1), bottom = Math.min(grid.height - 1, row + 2);
  const width = right - left + 1, projected: (ScreenPoint | undefined)[] = [];
  const datum = Math.fround(grid.domain[0]), point = new Vector3();
  for (let j = top; j <= bottom; j++) {
    for (let i = left; i <= right; i++) {
      projected.push(project(point.set((i - cx) * dx, (grid.heights[j * grid.width + i] - datum) * grid.exaggeration, (j - cz) * dz)));
    }
  }
  const boundary = new Set<number>();
  function triangle(i: number, j: number, k: number) {
    const p = projected[i], q = projected[j], r = projected[k];
    if (!p || !q || !r || Math.sign(signedArea(p,q,r)) !== winding) return;
    for (const [u,v] of [[i,j], [j,k], [k,i]]) {
      const key = Math.min(u,v) * projected.length + Math.max(u,v);
      if (!boundary.delete(key)) boundary.add(key);
    }
  }
  for (let j = 0; j < bottom - top; j++) {
    for (let i = 0; i < width - 1; i++) {
      const nw = j * width + i, ne = nw + 1, sw = nw + width;
      triangle(nw, ne, sw);
      triangle(ne, sw + 1, sw);
    }
  }
  const edges: ScreenEdge[] = Array.from(boundary, key =>
    [projected[Math.floor(key / projected.length)]!, projected[key % projected.length]!]);
  return !nearestEdge(edges, x, y);
}

// A folded or clipped triangle can cover the sample ahead of a deeper ray hit.
// Widen the grid walk by the pixel's half diagonal at the farthest terrain
// depth, then find the closest projected triangle edge within the pixel.
function terrainRasterEdge(camera: Camera, size: Size, grid: TerrainDataset, ray: Ray, far: number,
  x: number, y: number, depths: PixelDepthHints, knownEdge: ReturnType<typeof nearestEdge>, groundDepth?: number) {
  const forward = new Vector3(...camera.forward);
  const halfWidth = (grid.width - 1) * grid.spacing[0] / 2;
  const halfDepth = (grid.height - 1) * grid.spacing[1] / 2;
  const datum = Math.fround(grid.domain[0]);
  const low = (grid.statistics.min - datum) * grid.exaggeration - .24;
  const high = (grid.statistics.max - datum) * grid.exaggeration;
  const maxDepth = Math.abs(forward.x) * halfWidth + Math.abs(forward.z) * halfDepth
    + Math.max(forward.y * low, forward.y * high) - forward.dot(new Vector3(...camera.position));
  if (maxDepth < camera.near) return;
  const margin = Math.SQRT2 * Math.min(camera.far, maxDepth) * Math.tan(camera.fovYDegrees * Math.PI / 360) / size.height;
  const bounds = new Box3(new Vector3(-halfWidth, low, -halfDepth), new Vector3(halfWidth, high, halfDepth));
  if (!ray.intersectsBox(bounds.expandByScalar(margin))) return;
  let best = knownEdge;
  const plane = new Plane(), hint = new Vector3();
  visitTerrain(grid, ray, far, (a, b, c) => {
    bounds.makeEmpty().expandByPoint(a).expandByPoint(b).expandByPoint(c).expandByScalar(margin);
    if (!ray.intersectsBox(bounds)) return;
    const face = [a, b, c];
    const screen = projectFace(camera, size, face);
    const range = pixelDepthRange(screen, x, y);
    if (!range) return;
    depths.minimum = Math.min(depths.minimum, range.min);
    depths.maximum = Math.max(depths.maximum, range.max);
    const projected = ray.intersectPlane(plane.setFromCoplanarPoints(a,b,c), hint)
      && camera.worldToScreen(hint.toArray(), size);
    if (projected) depths.hints.push(Math.max(range.min, Math.min(range.max, projected.depth)));
    const edge = faceEdge(screen, x, y);
    if (!edge || knownEdge) return;
    if (groundDepth !== undefined) {
      // Look for alternative foreground geometry close enough to change the
      // submitted sample's depth. Interior edges of a continuous patch keep
      // their coverage when the endpoints snap to the raster grid.
      if (range.min > groundDepth + depthTieWindow(24) || insideTerrainPatch(camera, size, grid, face, x, y)) return;
    }
    if (!best || edge.distanceSq < best.distanceSq || (edge.distanceSq === best.distanceSq && edge.depth < best.depth)) best = edge;
  }, margin);
  return best;
}

// Hints choose tests; only the renderer moves a search bound. If the
// true depth lies outside the predicted footprint, bisection still finds it.
export async function measurePixelDepth(depths: PixelDepthHints, markerInFront: (depth: number) => Promise<boolean>) {
  const steps = 2 ** 24;
  let lo = 0, hi = steps;
  async function probe(code: number) {
    if (code <= lo) return true;
    if (code >= hi) return false;
    const front = await markerInFront(code / steps);
    if (front) lo = code;
    else hi = code;
    return front;
  }
  const codes = [...new Set(depths.hints.map(z => Math.round(z * steps)))].sort((a,b) => a-b);
  if (codes.length) {
    let first = 0, last = codes.length - 1;
    while (first < last) {
      const mid = Math.floor((first + last) / 2);
      if (await probe(Math.floor((codes[mid] + codes[mid + 1]) / 2))) first = mid + 1;
      else last = mid;
    }
    const hint = codes[first], front = await probe(hint);
    for (const delta of [1, 4, 16]) {
      if (await probe(hint + (front ? delta : -delta)) !== front) break;
    }
  }
  if (hi - lo > 16 && depths.minimum <= depths.maximum) {
    // Use the extrema only on the slow path. Test their ordering against
    // the real sample before narrowing the interval.
    await probe(Math.floor(depths.minimum * steps) - 8);
    await probe(Math.ceil(depths.maximum * steps) + 8);
  }
  while (hi - lo > 1) await probe(Math.floor((lo + hi) / 2));
  return (lo + hi) / (2 * steps);
}

export function pickSurfaces(camera: Camera, size: Size, pixel: Pixel,
  placement: UniformTransform | TerrainTransform, surfaces: PickSurfaces, frameRevision: number,
  meshFaces = surfaces.mesh ? projectMeshFaces(camera, size, surfaces.mesh.geometry) : []): SurfacePick {
  const x = pixel[0] + 0.5, y = pixel[1] + 0.5;
  const { origin, direction } = camera.screenRay(x, y, size);
  const ray = new Ray(new Vector3(...origin), new Vector3(...direction));
  const far = ray.origin.distanceTo(new Vector3(...camera.screenToWorld(x, y, 1, size)));
  const point = new Vector3(), eye = new Vector3(...camera.position);
  function hitAt(id: string, kind: StudioHit["kind"], position: Vector3): StudioHit {
    return { id, kind, worldPosition: runtimeToStudio(position.toArray(), placement),
      distance: eye.distanceTo(position) * placement.scale, frameRevision };
  }
  function intersect(id: string, kind: StudioHit["kind"], visit: (triangle: TriangleVisitor) => void, face?: Vector3[]) {
    const nearest = new Vector3();
    let t = Infinity;
    visit((a, b, c) => {
      if (!ray.intersectTriangle(a, b, c, false, point)) return;
      const distance = point.distanceTo(ray.origin);
      if (distance > far || distance >= t) return;
      t = distance;
      nearest.copy(point);
      if (face) { face[0].copy(a); face[1].copy(b); face[2].copy(c); }
    });
    if (!Number.isFinite(t)) return;
    return { hit: hitAt(id, kind, nearest), position: nearest.toArray() };
  }
  const { terrain, mesh } = surfaces;
  const face = [new Vector3(), new Vector3(), new Vector3()];
  const ground = terrain && intersect(terrain.id, "terrain", visit => visitTerrain(terrain.grid, ray, far, visit), face);
  const meshHit = mesh && intersect(mesh.id, mesh.kind ?? "mesh", visit => {
    const position = mesh.geometry.getAttribute("position"), index = mesh.geometry.index!;
    const a = new Vector3(), b = new Vector3(), c = new Vector3();
    for (let i = 0; i < index.count; i += 3) {
      visit(a.fromBufferAttribute(position, index.getX(i)), b.fromBufferAttribute(position, index.getX(i + 1)),
        c.fromBufferAttribute(position, index.getX(i + 2)));
    }
  });
  const meshDepth = meshHit && camera.worldToScreen(meshHit.position, size)!.depth;
  const { edge: meshEdge, depths: meshDepths } = meshPixelDepths(meshFaces, x, y, meshDepth);
  const groundDepth = ground && camera.worldToScreen(ground.position, size)!.depth;
  const depths: PixelDepthHints = { minimum: 1, maximum: 0, hints: [] };
  let terrainEdge = ground && faceEdge(projectFace(camera, size, face), x, y);
  if (terrain && terrainEdge && insideTerrainPatch(camera, size, terrain.grid, face, x, y)) terrainEdge = undefined;
  if (terrain) terrainEdge = terrainRasterEdge(camera, size, terrain.grid, ray, far, x, y, depths, terrainEdge, groundDepth) ?? terrainEdge;
  if (meshDepths || terrainEdge) {
    const atDepth = (id: string, kind: StudioHit["kind"], depth: number) => hitAt(id, kind,
      point.fromArray(camera.screenToWorld(x, y, Math.max(0, Math.min(1, depth)), size)));
    return {
      mesh: meshHit?.hit ?? (mesh && meshEdge ? atDepth(mesh.id, mesh.kind ?? "mesh", meshEdge.depth) : null),
      terrain: ground?.hit ?? (terrain && terrainEdge ? atDepth(terrain.id, "terrain", terrainEdge.depth) : null),
      terrainDepths: terrainEdge ? depths : undefined, meshDepths,
    };
  }
  if (!ground || !meshHit) return { hit: ground?.hit ?? meshHit?.hit ?? null };
  // Near a Depth24Plus tie, fragment interpolation and rounding are device
  // dependent. Hand both intersections to the submitted frame's GPU ID pass.
  if (Math.abs(groundDepth! - meshDepth!) <= depthTieWindow(24)) return { terrain: ground.hit, mesh: meshHit.hit };
  return { hit: ground.hit.distance < meshHit.hit.distance ? ground.hit : meshHit.hit };
}

// Three's vertex-position reader applies the object's current relative or
// absolute morph weights in local space. Lines and points use the same inputs.
function thinVertexWorld(object: Line | Points, drawOffset: number, target: Vector3) {
  const vertex = object.geometry.index?.getX(drawOffset) ?? drawOffset;
  return Mesh.prototype.getVertexPosition.call(object, vertex, target).applyMatrix4(object.matrixWorld);
}

// Clip the centreline to the candidate pixel footprint before estimating depth.
function intersectWire(line: Line, frustum: Frustum, ray: Ray, forward: Vector3, cosine: number,
  visit: (offset: number, distance: number) => void) {
  const { index, attributes, drawRange } = line.geometry;
  const position = attributes.position;
  if (!position) return;
  const end = Math.min(index?.count ?? position.count, drawRange.start + drawRange.count);
  const step = line instanceof LineSegments ? 2 : 1;
  const a = new Vector3(), b = new Vector3(), start = new Vector3(), finish = new Vector3(), point = new Vector3();
  function segment(i: number, j: number) {
    thinVertexWorld(line, i, a);
    thinVertexWorld(line, j, b);
    let enter = 0, exit = 1;
    for (const plane of frustum.planes) {
      const da = plane.distanceToPoint(a), db = plane.distanceToPoint(b);
      if (da < 0 && db < 0) return;
      if (da < 0) enter = Math.max(enter, da / (da - db));
      if (db < 0) exit = Math.min(exit, da / (da - db));
      if (enter > exit) return;
    }
    start.lerpVectors(a, b, enter);
    finish.lerpVectors(a, b, exit);
    ray.distanceSqToSegment(start, finish, undefined, point);
    // The line covers the pixel at the clipped segment's camera-space depth.
    visit(i, point.sub(ray.origin).dot(forward) / cosine);
  }
  for (let i = drawRange.start; i + 1 < end; i += step) segment(i, i + 1);
  if (line instanceof LineLoop && end > drawRange.start + 1) segment(end - 1, drawRange.start);
}

// Three's point shader sizes the sprite in drawing-buffer pixels. Attenuated
// points use half the framebuffer height divided by camera-space depth.
function intersectPoints(points: Points, camera: PerspectiveCamera, size: Size, pixel: Pixel,
  cosine: number, limits: ArrayLike<number>, sampleMargin: number, visit: (offset: number, distance: number) => void) {
  const material = points.material;
  if (!(material instanceof PointsMaterial) || !material.visible) return;
  const { index, attributes, drawRange } = points.geometry;
  const position = attributes.position;
  const end = Math.min(index?.count ?? position.count, drawRange.start + drawRange.count);
  const world = new Vector3(), view = new Vector3();
  for (let i = drawRange.start; i < end; i++) {
    thinVertexWorld(points, i, world);
    view.copy(world).applyMatrix4(camera.matrixWorldInverse);
    const depth = -view.z;
    if (depth < camera.near || depth > camera.far) continue;
    view.applyMatrix4(camera.projectionMatrix);
    if (Math.abs(view.x) > 1 || Math.abs(view.y) > 1) continue;
    const diameter = material.size * (material.sizeAttenuation ? size.height / (2 * depth) : size.pixelRatio ?? 1);
    const half = Math.min(limits[1], Math.max(limits[0], diameter)) / 2 + sampleMargin;
    const dx = pixel[0] + .5 - (1 + view.x) * size.width / 2;
    const dy = pixel[1] + .5 - (1 - view.y) * size.height / 2;
    if (dx >= -half && dx < half && dy >= -half && dy < half) visit(i, depth / cosine);
  }
}

function requiresCoverage(material: Material) {
  return material.transparent || material.alphaTest > 0 || material.alphaHash;
}

export interface RasterCandidate {
  object: Mesh | Line | Points;
  rayDepths: () => number[];
}

interface EditorPickOptions {
  pointSizeRange?: ArrayLike<number>;
  maxLineWidth?: number;
  gpuHit?: StudioHit | null;
  /** Offset in the indexed or non-indexed draw, before vertex lookup. */
  primitiveVisible?: (object: Mesh | Line | Points, offset: number, instanceId?: number) => boolean;
  rasterDepths?: (candidates: readonly RasterCandidate[]) => (number | undefined)[];
  resolveDepth?: (candidates: StudioHit[]) => StudioHit | null;
}

export function pickEditor(camera: PerspectiveCamera, size: Size, pixel: Pixel, objects: readonly ViewportObject[],
  groups: ReadonlyMap<string, Group>, owned: readonly string[], frameRevision: number,
  { pointSizeRange = [1, Infinity], maxLineWidth = Infinity, gpuHit, primitiveVisible, rasterDepths, resolveDepth }: EditorPickOptions = {}): StudioHit | null {
  const raycaster = new Raycaster();
  raycaster.setFromCamera(new Vector2(2 * (pixel[0] + 0.5) / size.width - 1,
    1 - 2 * (pixel[1] + 0.5) / size.height), camera);
  const forward = camera.getWorldDirection(new Vector3());
  const cosine = raycaster.ray.direction.dot(forward);
  raycaster.near = camera.near / cosine;
  raycaster.far = camera.far / cosine;
  const viewProjection = new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  const cameraFrustum = new Frustum().setFromProjectionMatrix(viewProjection);
  const strokeFrusta = new Map<number, Frustum>();
  function strokeFrustum(line: Line) {
    // A stroke centred outside the pixel can cover its samples. Include the
    // pixel and the stroke width, then ask the renderer about actual coverage.
    const materials = Array.isArray(line.material) ? line.material : [line.material];
    const cssWidth = materials.reduce((width, m) => Math.max(width, m instanceof LineBasicMaterial ? m.linewidth : 1), 0);
    const width = rasterDepths || primitiveVisible ? Math.min(maxLineWidth, Math.max(1, cssWidth * (size.pixelRatio ?? 1))) : 0;
    let frustum = strokeFrusta.get(width);
    if (!frustum) {
      const span = 1 + width;
      const crop = new Matrix4().makeScale(size.width / span, size.height / span, 1)
        .setPosition((size.width - 2 * pixel[0] - 1) / span, (2 * pixel[1] + 1 - size.height) / span, 0);
      frustum = new Frustum().setFromProjectionMatrix(crop.multiply(viewProjection));
      strokeFrusta.set(width, frustum);
    }
    return frustum;
  }
  const hits: { hit: StudioHit; coversPixel?: () => boolean }[] = gpuHit ? [{ hit: gpuHit }] : [];
  const draws: (RasterCandidate & { addHit: (depth: number) => void })[] = [];
  for (const { id, visible, kind } of objects) {
    if (!visible || owned.includes(id)) continue;
    groups.get(id)?.traverseVisible(child => {
      if (!child.layers.test(raycaster.layers)) return;
      const wire = child instanceof Line && child.raycast === Line.prototype.raycast;
      const points = child instanceof Points && child.raycast === Points.prototype.raycast;
      const cube = kind.type === "mesh" && kind.source.type === "primitive" && kind.source.primitive.type === "cube";
      const lineFrustum = wire ? strokeFrustum(child) : undefined;
      if (rasterDepths && (isEditorTriangleMesh(child) || wire || points)) {
        if (child.frustumCulled && !cameraFrustum.intersectsObject(child)) return;
        let surfaces: Intersection[] = [];
        draws.push({ object: child, rayDepths: () => {
          if (child instanceof Mesh) {
            surfaces = intersectEditorObject(child, raycaster, cameraFrustum);
            return surfaces.map(surface => surface.distance * cosine);
          }
          // A thin primitive's CPU projection can miss a covered sample.
          // Its intersections only accelerate the depth query after coverage.
          const hints: number[] = [];
          const visit = (_offset: number, distance: number) => { hints.push(distance * cosine); };
          if (child instanceof Line) intersectWire(child, lineFrustum!, raycaster.ray, forward, cosine, visit);
          else intersectPoints(child, camera, size, pixel, cosine, pointSizeRange, .5, visit);
          return hints.sort((a, b) => a - b);
        }, addHit: depth => {
          const distance = depth / cosine;
          const point = raycaster.ray.at(distance, new Vector3());
          const hit: StudioHit = { id, kind: cube ? "cube" : kind.type, frameRevision, distance, worldPosition: point.toArray() };
          const terrain: ViewportTerrain | undefined = child.userData.forgeTerrain;
          if (terrain && child instanceof Mesh) {
            hit.elevation = terrainHitElevation(child, terrain, point, surfaces.find(s => s.distance * cosine === depth));
          }
          hits.push({ hit });
        } });
        return;
      }
      if (wire || points) {
        // A combination of morph targets can extend beyond the geometry's
        // static sphere. Apply the renderer's camera cull, then test posed edges.
        const posed = child.geometry.morphAttributes.position && child.morphTargetInfluences?.some(weight => weight !== 0);
        const bounds = lineFrustum && !posed ? lineFrustum : cameraFrustum;
        if (child.frustumCulled && !bounds.intersectsObject(child)) return;
        const material = child.material;
        if (Array.isArray(material) ? !material.some(m => m.visible) : !material.visible) return;
        const add = (distance: number, coversPixel?: () => boolean) => {
          const worldPosition = raycaster.ray.at(distance, new Vector3()).toArray();
          hits.push({ hit: { id, kind: kind.type, distance, frameRevision, worldPosition }, coversPixel });
        };
        let nearest = Infinity;
        const visit = (offset: number, distance: number) => {
          if (primitiveVisible) add(distance, () => primitiveVisible(child, offset));
          else nearest = Math.min(nearest, distance);
        };
        if (child instanceof Line) intersectWire(child, lineFrustum!, raycaster.ray, forward, cosine, visit);
        else intersectPoints(child, camera, size, pixel, cosine, pointSizeRange, primitiveVisible ? .5 : 0, visit);
        if (nearest < Infinity) add(nearest);
        return;
      }
      for (const surface of intersectEditorObject(child, raycaster, cameraFrustum)) {
        let coversPixel: (() => boolean) | undefined;
        const face = surface.faceIndex;
        if (child instanceof Mesh && face != null) {
          const material = Array.isArray(child.material) ? child.material[surface.face?.materialIndex ?? 0] : child.material;
          if (!material?.visible) continue;
          if (primitiveVisible && requiresCoverage(material)) {
            coversPixel = () => primitiveVisible(child, 3 * face, surface.instanceId);
          }
        }
        const hit: StudioHit = { id, kind: cube ? "cube" : kind.type, worldPosition: surface.point.toArray(),
          distance: surface.distance, frameRevision };
        const terrain: ViewportTerrain | undefined = child.userData.forgeTerrain;
        if (kind.type === "terrain" && terrain && surface.uv) {
          hit.elevation = sampleHeight(terrain.preview, surface.uv.x, 1 - surface.uv.y, terrain.heightOrigin);
        }
        hits.push({ hit, coversPixel });
        if (!coversPixel) break;
      }
    });
  }
  if (rasterDepths && draws.length) {
    rasterDepths(draws).forEach((depth, index) => {
      if (depth !== undefined) draws[index].addHit(depth);
    });
  }

  // Test coverage front to back. A discarded fragment leaves deeper
  // candidates eligible, including other primitives in the same draw.
  hits.sort((a, b) => a.hit.distance - b.hit.distance);
  const candidates = new Map<string, StudioHit>();
  for (const { hit, coversPixel } of hits) {
    if (candidates.has(hit.id)) continue;
    if (coversPixel && !coversPixel()) continue;
    if (!resolveDepth) return hit;
    candidates.set(hit.id, hit);
  }
  const visible = [...candidates.values()];
  // A sloping face can lose every covered sample to a surface whose centre
  // depth is farther away. Replay competing owners with their shared depth.
  if (resolveDepth && (visible.length > 1 || (visible.length === 1 && owned.length > 0 && !gpuHit))) {
    return resolveDepth(visible);
  }
  return visible[0] ?? null;
}
