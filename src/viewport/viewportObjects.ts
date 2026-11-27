import * as THREE from "three";
import type { MaterialInput, VectorLayers } from "@forge3d/web";
import { objectParentWorld, localMatrix, scatterGeometry, runtimeMatrix, worldXAxis, type Triple, type UniformTransform } from "./forge3dWebMapping.ts";
import { buildCameraGizmo, buildLightGizmo, primitiveGeometry } from "./viewportGeometry.ts";
import type { ViewportFrame, ViewportObject } from "./viewportState";

type WebModule = typeof import("@forge3d/web");
type Segment = [Triple, Triple];
export interface DisplayedObject {
  object: ViewportObject;
  parent: THREE.Matrix4;
  world: THREE.Matrix4;
  axis: ReturnType<typeof worldXAxis>;
  center: Triple;
  bounds: THREE.Box3;
  segments: Segment[];
  helperColor: Triple;
  opacity: number;
  surface?: { id: string; geometry: THREE.BufferGeometry; kind: "cube" | "mesh" | "light" };
  scatter?: { local: THREE.BufferGeometry; transforms: Float32Array; inverse: THREE.Matrix4;
    doubleSided: boolean; backFacing?: boolean; material: MaterialInput; tint: [number,number,number,number] };
}

// The pinned scatter pipeline draws both windings. Test outward faces against
// the object-local eye before upload so mirroring preserves Field's front faces.
// Flattened geometry already has its linear part baked.
function frontIndices(geometry: THREE.BufferGeometry, eye: THREE.Vector3) {
  const index = geometry.index!, positions = geometry.attributes.position;
  const a = new THREE.Vector3(), ab = new THREE.Vector3(), ac = new THREE.Vector3(), toEye = new THREE.Vector3();
  const visible: number[] = [];
  for (let i = 0; i < index.count; i += 3) {
    const ia = index.getX(i), ib = index.getX(i + 1), ic = index.getX(i + 2);
    a.fromBufferAttribute(positions, ia);
    ab.fromBufferAttribute(positions, ib).sub(a);
    ac.fromBufferAttribute(positions, ic).sub(a);
    if (ab.cross(ac).dot(toEye.copy(eye).sub(a)) > 0) visible.push(ia, ib, ic);
  }
  return visible;
}

export function buildObjects(module: WebModule, objects: ViewportObject[], hierarchy: Map<string, ViewportObject>,
  placement: UniformTransform, clay: THREE.Color, settings: Pick<ViewportFrame["settings"], "mode" | "exposure">,
  groups?: Map<string, THREE.Group>) {
  const solid = settings.mode === "solid";
  const records = new Map<string, DisplayedObject>();
  for (const object of objects) {
    const { id, kind } = object;
    const ancestor = object.parent ? objectParentWorld(object.parent, hierarchy) : undefined;
    const parent = ancestor?.matrix ?? new THREE.Matrix4();
    const group = groups?.get(id);
    group?.updateWorldMatrix(true, false);
    const world = group?.matrixWorld.clone() ?? localMatrix(object).premultiply(parent);
    const relative = runtimeMatrix(world, placement);
    const record: DisplayedObject = { object, parent, world, axis: ancestor?.singular ? undefined : worldXAxis(parent),
      center: new THREE.Vector3().setFromMatrixPosition(relative).toArray(), bounds: new THREE.Box3(),
      segments: [], helperColor: [1,1,1], opacity: 1 };
    records.set(id, record);
    let geometry: THREE.BufferGeometry | undefined, material: MaterialInput | undefined;
    let surfaceKind: "cube" | "mesh" | "light" = "mesh";
    let doubleSided = false;
    if (kind.type === "mesh" && kind.source.type === "primitive") {
      const primitive = kind.source.primitive;
      geometry = primitiveGeometry(primitive);
      doubleSided = primitive.type === "plane";
      surfaceKind = primitive.type === "cube" ? "cube" : "mesh";
      const rgb = solid ? clay.toArray() : kind.material.baseColor;
      material = { id, baseColor: [rgb[0],rgb[1],rgb[2],1], metallic: solid ? 0 : kind.material.metallic,
        roughness: solid ? .62 : kind.material.roughness };
    } else if (kind.type === "camera" || kind.type === "light") {
      const helper = kind.type === "camera" ? buildCameraGizmo(kind) : buildLightGizmo(kind);
      if (kind.type === "light") {
        const authored = new THREE.Color(...kind.color);
        record.helperColor = helperDisplayColor(authored, settings.exposure);
      }
      helper.traverse(child => {
        if (child instanceof THREE.Line) {
          child.geometry.computeBoundingBox();
          record.bounds.union(child.geometry.boundingBox!.clone().applyMatrix4(relative));
          const pos = child.geometry.attributes.position;
          const line = child.material as THREE.LineBasicMaterial;
          if (kind.type === "camera") record.helperColor = helperDisplayColor(line.color.clone(), settings.exposure);
          record.opacity = line.opacity;
          for (let i = 0; i + 1 < pos.count; i += 2) {
            const endpoints = [i,i+1].map(j => new THREE.Vector3().fromBufferAttribute(pos,j).applyMatrix4(relative));
            record.segments.push([endpoints[0].toArray(), endpoints[1].toArray()]);
          }
          child.geometry.dispose();
          line.dispose();
        } else if (child instanceof THREE.Mesh && kind.type === "light") {
          geometry = child.geometry;
          surfaceKind = "light";
          material = { id, baseColor: [0,0,0,1], roughness: 1, metallic: 0 };
          child.material.dispose();
        }
      });
    }
    if (!geometry || !material) continue;
    geometry.computeBoundingBox();
    record.bounds.union(geometry.boundingBox!.clone().applyMatrix4(relative));
    const { transforms } = scatterGeometry(geometry, relative, ancestor?.singular || object.scale.includes(0));
    const instance = new THREE.Matrix4().fromArray(transforms).transpose();
    const tint = material.baseColor!;
    record.scatter = { local: geometry, transforms, inverse: instance.clone().invert(), doubleSided, material, tint };
    const baked = geometry.clone().applyMatrix4(instance);
    baked.clearGroups();
    baked.setIndex([]);
    record.surface = { id, kind: surfaceKind, geometry: baked };
  }
  const slots = new module.MaterialCollection().snapshot();
  return { records, solid, drawn: [] as DisplayedObject[], materials: slots, batches: [] as import("@forge3d/web").ScatterBatchSnapshot[] };
}

/** Refresh the displayed indices when the eye crosses a face plane. */
export function updateFaces(scene: ReturnType<typeof buildObjects>, eye: Triple) {
  let changed = false;
  for (const record of scene.records.values()) {
    const scatter = record.scatter, surface = record.surface;
    if (!scatter || !surface) continue;
    const { local, inverse } = scatter;
    const front = frontIndices(local, new THREE.Vector3(...eye).applyMatrix4(inverse));
    const indices = scatter.doubleSided ? local.index!.array : front;
    // Three's DoubleSide lights the reverse side with reversed normals.
    const backFacing = scatter.doubleSided && !front.length;
    const previous = surface.geometry.index!;
    if (scatter.backFacing === backFacing && indices.length === previous.count &&
        indices.every((value,i) => value === previous.getX(i))) continue;
    scatter.backFacing = backFacing;
    surface.geometry.setIndex(new THREE.Uint32BufferAttribute(indices, 1));
    changed = true;
  }
  return changed;
}

type ObjectScene = ReturnType<typeof buildObjects>;
const white: [number,number,number,number] = [1,1,1,1];

// Concatenate in scene order. Equal-depth fragments must resolve identically
// in the display, mask and depth passes, including across material changes.
function joinedBatch(module: WebModule, records: DisplayedObject[], materialIndex: number,
  palette?: { width:number; height:number; sun:Triple; first:number }) {
  const vertices = records.reduce((sum,r) => sum+r.surface!.geometry.attributes.position.count,0);
  const elements = records.reduce((sum,r) => sum+r.surface!.geometry.index!.count,0);
  const positions = new Float32Array(vertices*3), normals = new Float32Array(vertices*3);
  const indices = new Uint32Array(elements), uvs = palette && new Float32Array(vertices*2);
  let vertex = 0, element = 0;
  for (const [i,record] of records.entries()) {
    const geometry = record.surface!.geometry;
    positions.set(geometry.attributes.position.array,vertex*3);
    normals.set(geometry.attributes.normal.array,vertex*3);
    const next = vertex + geometry.attributes.position.count;
    if (record.scatter!.backFacing) for (let j = vertex*3; j < next*3; j++) normals[j] *= -1;
    if (palette && uvs) {
      const columns = palette.width / 2;
      const index = palette.first+i;
      const u = (2*(index%columns)+.5+filterFraction)/palette.width;
      const v = (2*Math.floor(index/columns)+.5+filterFraction)/palette.height;
      for (let j = vertex; j < next; j++) {
        uvs[j*2] = u;
        uvs[j*2+1] = v;
        // A bulb shares this draw's PBR route. With zero ambient occlusion
        // and zero incident cosine its only contribution is emission.
        if (record.surface!.kind === "light") normals.set(palette.sun,j*3);
      }
    }
    for (const idx of geometry.index!.array) indices[element++] = vertex+idx;
    vertex = next;
  }
  const layer = new module.MeshLayer({positions,normals,indices,uvs},{materialIndex,color:white});
  const batch = layer.toBatch().snapshot();
  layer.dispose();
  return batch;
}

// Each material channel is the bilinear sum of four texels. Power-of-two
// dimensions keep the sample weights independent of the number of objects.
// The sRGB texture is decoded by the GPU before filtering in linear light.
const filterFraction = 1/64;
const weights = [(1-filterFraction)**2, filterFraction*(1-filterFraction),
  filterFraction*(1-filterFraction), filterFraction**2];
const linearLevels = Array.from({length:256},(_,i) => i/255);
const srgbLevels = linearLevels.map(v => new THREE.Color(v,0,0).convertSRGBToLinear().r);

function encodeChannel(data: Uint8Array, offsets: number[], channel: number, value: number, levels: number[]) {
  // Prefer a constant channel when one texel already represents its float
  // value. This also preserves exact roughness steps in environment lookups.
  value = THREE.MathUtils.clamp(value,0,1);
  const nearest = levels === linearLevels ? Math.round(value*255)
    : Math.round(new THREE.Color(value,0,0).convertLinearToSRGB().r*255);
  if (Math.fround(value) === Math.fround(levels[nearest])) {
    for (const offset of offsets) data[offset+channel] = nearest;
    return;
  }
  let remaining = value;
  for (let tap=0; tap<4; tap++) {
    const target = remaining/weights[tap];
    let low=0, high=255;
    while (low < high) {
      const mid = (low+high+1) >>> 1;
      if (levels[mid] <= target) low=mid;
      else high=mid-1;
    }
    if (tap===3 && low<255 && target-levels[low] > levels[low+1]-target) low++;
    data[offsets[tap]+channel] = low;
    remaining -= weights[tap]*levels[low];
  }
}

// Field applies Three's ACES and output transfer to the camera and light
// materials before blending their strokes. BoxHelper disables tone mapping.
const acesInput = new THREE.Matrix3().set(
  .59719, .35458, .04823,
  .07600, .90834, .01566,
  .02840, .13383, .83777,
);
const acesOutput = new THREE.Matrix3().set(
  1.60475, -.53108, -.07367,
  -.10208, 1.10813, -.00605,
  -.00327, -.07276, 1.07602,
);

function helperDisplayColor(color: THREE.Color, exposure: number): Triple {
  color.multiplyScalar(exposure / .6).applyMatrix3(acesInput);
  const fit = (v: number) =>
    (v * (v + .0245786) - .000090537) / (v * (.983729 * v + .432951) + .238081);
  color.setRGB(fit(color.r), fit(color.g), fit(color.b)).applyMatrix3(acesOutput).convertLinearToSRGB();
  return color.toArray().map(channel => THREE.MathUtils.clamp(channel, 0, 1)) as Triple;
}

/** Keep the same geometry and material encoding at every draw count.
 * Each object's material is independent of its neighbours and their values. */
export function submitObjectBatches(module: WebModule, scene: ObjectScene, records: DisplayedObject[],
  sun: Triple) {
  scene.drawn = records;
  const materials = new module.MaterialCollection();
  scene.batches = [];
  if (records.length) {
    const columns = THREE.MathUtils.ceilPowerOfTwo(Math.ceil(Math.sqrt(records.length)));
    const width = 2*columns, height = 2*THREE.MathUtils.ceilPowerOfTwo(Math.ceil(records.length/columns));
    const texture = (srgb: boolean) => ({width,height,generateMipmaps:false,
      format:srgb ? "rgba8unorm-srgb" as const : "rgba8unorm" as const,
      colorSpace:srgb ? "srgb" as const : "linear" as const, data:new Uint8Array(4*width*height)});
    const baseColor = texture(true), metallicRoughness = texture(false);
    const emissive = texture(!scene.solid), occlusion = texture(false);
    for (const [i,record] of records.entries()) {
      const {material,tint} = record.scatter!;
      const start = 8*((i%columns)+Math.floor(i/columns)*width);
      const offsets = [start,start+4,start+4*width,start+4*(width+1)];
      const kind = record.object.kind;
      for (let c=0; c<3; c++) {
        encodeChannel(baseColor.data,offsets,c,tint[c],srgbLevels);
      }
      if (kind.type === "light") {
        if (!scene.solid) {
          // Material applies exposure and the display transform in the GPU post pass.
          for (let c = 0; c < 3; c++) encodeChannel(emissive.data, offsets, c, kind.color[c], srgbLevels);
        } else {
          const pixel = [...record.helperColor.map(channel => Math.round(255 * channel)), 255];
          for (const offset of offsets) emissive.data.set(pixel, offset);
        }
      }
      encodeChannel(metallicRoughness.data,offsets,1,material.roughness!,linearLevels);
      encodeChannel(metallicRoughness.data,offsets,2,material.metallic!,linearLevels);
      for (const offset of offsets) {
        baseColor.data[offset+3] = 255;
        occlusion.data[offset] = kind.type==="light" ? 0 : 255;
      }
    }
    materials.set("surfaces",{id:"surfaces",baseColor:white,roughness:1,metallic:1,textures:{
      baseColor,metallicRoughness,emissive,occlusion,sampler:{minFilter:"linear",magFilter:"linear"} }});
    const palette = {width,height,sun,first:0};
    scene.batches = records.length <= 256
      ? records.map((record,first) => joinedBatch(module,[record],1,{...palette,first}))
      : [joinedBatch(module,records,1,palette)];
  }
  scene.materials = materials.snapshot();
}

export function objectMaskBatches(module: WebModule, scene: ObjectScene, marked: (id:string)=>boolean) {
  const records = scene.drawn;
  const batches = [];
  for (let first=0; first<records.length;) {
    const value = marked(records[first].object.id);
    let end = first+1;
    while (end<records.length && marked(records[end].object.id) === value) end++;
    batches.push(joinedBatch(module,records.slice(first,end),Number(value)));
    first=end;
  }
  return batches;
}

// The vector facade admits coordinates within ±1e12. A distant helper can
// exceed that range after terrain rebasing. Clip crossing strokes and omit
// ones wholly outside, so neither can invalidate the rest of the scene.
function vectorSegment(segment: Segment): Segment | undefined {
  const limit = 1e12;
  const [a, b] = segment;
  if ([...a, ...b].every(value => Math.abs(value) <= limit)) return segment;
  let enter = 0, leave = 1;
  for (let axis = 0; axis < 3; axis++) {
    const delta = b[axis] - a[axis];
    if (!delta) {
      if (Math.abs(a[axis]) > limit) return;
      continue;
    }
    const low = (-limit - a[axis]) / delta, high = (limit - a[axis]) / delta;
    enter = Math.max(enter, Math.min(low, high));
    leave = Math.min(leave, Math.max(low, high));
    if (enter > leave) return;
  }
  const at = (t: number) => a.map((v,i) => THREE.MathUtils.clamp(v + t * (b[i] - v), -limit, limit)) as Triple;
  return [at(enter), at(leave)];
}

export function helperVectors(module: WebModule, records: Map<string, DisplayedObject>, boxes: ReadonlyMap<string, THREE.Box3>) {
  const owners = new Map<number, string>();
  const vectors = new module.VectorLayers();
  type Feature = Parameters<VectorLayers["add"]>[0]["features"][number];
  const features: Extract<Feature,{kind:"line"}>[] = [];
  let id = 0;
  const add = (segment: Segment, rgb: Triple, opacity: number, owner?: string) => {
    const positions = vectorSegment(segment);
    if (!positions) return;
    features.push({ id: ++id, kind: "line", positions, style: { color: [...rgb,1], opacity } });
    if (owner) owners.set(id,owner);
  };
  for (const [uuid, record] of records) {
    for (const edge of record.segments) add(edge, record.helperColor, record.opacity, uuid);
  }
  const amber = new THREE.Color(0xefa026).convertLinearToSRGB().toArray() as Triple;
  for (const bounds of boxes.values()) {
    if (bounds.isEmpty()) continue;
    const corner = (i: number): Triple => [i & 1 ? bounds.max.x : bounds.min.x,
      i & 2 ? bounds.max.y : bounds.min.y, i & 4 ? bounds.max.z : bounds.min.z];
    for (let i = 0; i < 8; i++) for (const bit of [1,2,4]) {
      if (!(i & bit)) add([corner(i),corner(i|bit)],amber,1);
    }
  }
  if (features.length) vectors.add({ name: "Studio helpers", style: { lineWidth: 1, depthBias: .01 }, features });
  return { vectors: features.length ? vectors : null, owners, features };
}
