import { BufferAttribute, BufferGeometry, InstancedMesh, Matrix4, Mesh, SkinnedMesh, Triangle, Vector3,
  type Frustum, type Intersection, type Object3D, type Raycaster } from "three";
import { sampleHeight } from "./cartography.ts";
import type { ViewportTerrain } from "./viewportState.ts";

export function isEditorTriangleMesh(object: Object3D): object is Mesh {
  return object instanceof Mesh && (object.raycast === Mesh.prototype.raycast ||
    object.raycast === SkinnedMesh.prototype.raycast ||
    (object instanceof InstancedMesh && object.raycast === InstancedMesh.prototype.raycast));
}

export function terrainHitElevation(mesh: Mesh, terrain: ViewportTerrain, point: Vector3, matched?: Intersection): number | undefined {
  const sample = (u: number, v: number) => sampleHeight(terrain.preview, u, v, terrain.heightOrigin);
  if (matched?.uv) return sample(matched.uv.x, 1 - matched.uv.y);
  if (mesh.matrixWorld.determinant() !== 0) {
    const local = mesh.worldToLocal(point.clone());
    return sample(local.x + .5, local.z + .5);
  }

  // A collapsed axis still leaves drawable triangles when the other two
  // span an area. A covered sample can lie just outside the centre ray, so
  // recover the nearest point on the drawn surface and interpolate its UV.
  const { attributes: { position, uv }, index, drawRange } = mesh.geometry;
  if (!position || !uv) return;
  const triangle = new Triangle(), closest = new Vector3(), bary = new Vector3();
  const end = Math.min(index?.count ?? position.count, drawRange.start + drawRange.count);
  let nearest = Infinity, elevation: number | undefined;
  for (let i = drawRange.start; i + 2 < end; i += 3) {
    const a = index?.getX(i) ?? i, b = index?.getX(i + 1) ?? i + 1, c = index?.getX(i + 2) ?? i + 2;
    triangle.a.fromBufferAttribute(position, a).applyMatrix4(mesh.matrixWorld);
    triangle.b.fromBufferAttribute(position, b).applyMatrix4(mesh.matrixWorld);
    triangle.c.fromBufferAttribute(position, c).applyMatrix4(mesh.matrixWorld);
    triangle.closestPointToPoint(point, closest);
    const distance = point.distanceToSquared(closest);
    if (distance < nearest && triangle.getBarycoord(closest, bary)) {
      nearest = distance;
      const u = uv.getX(a) * bary.x + uv.getX(b) * bary.y + uv.getX(c) * bary.z;
      const v = uv.getY(a) * bary.x + uv.getY(b) * bary.y + uv.getY(c) * bary.z;
      elevation = sample(u, 1 - v);
    }
  }
  return elevation;
}

// Mesh.raycast inverts matrixWorld and rejects rays against cached bounds.
// Give it the submitted pose when either assumption breaks. Keep vertex and
// draw offsets intact so material groups, UVs and coverage replay agree.
function meshForRaycast(mesh: Mesh, objectMatrix: Matrix4, instanceMatrix?: Matrix4): Mesh {
  const posed = mesh.geometry.morphAttributes.position && mesh.morphTargetInfluences?.some(weight => weight !== 0);
  if (!posed && mesh.matrixWorld.determinant() !== 0 && !(instanceMatrix && instanceMatrix.determinant() < 0)) return mesh;

  const source = mesh.geometry, geometry = new BufferGeometry();
  const position = source.getAttribute("position"), vertex = new Vector3();
  const positions = new Float64Array(3 * position.count);
  const bakeWorld = objectMatrix.determinant() === 0;
  const bake = bakeWorld ? mesh.matrixWorld : instanceMatrix;
  for (let i = 0; i < position.count; i++) {
    mesh.getVertexPosition(i, vertex);
    if (bake) vertex.applyMatrix4(bake);
    vertex.toArray(positions, 3 * i);
  }
  geometry.setAttribute("position", new BufferAttribute(positions, 3));
  geometry.setIndex(source.index);
  if (source.attributes.uv) geometry.setAttribute("uv", source.attributes.uv);
  geometry.groups = source.groups;
  geometry.setDrawRange(source.drawRange.start, source.drawRange.count);
  const proxy = new Mesh(geometry, mesh.material);
  // WebGL chooses front-face winding from the object's transform. Instance
  // transforms above are part of its vertex shader, including reflections.
  if (!bakeWorld) proxy.matrixWorld.copy(objectMatrix);
  return proxy;
}

export function intersectEditorObject(object: Object3D, raycaster: Raycaster, cameraFrustum: Frustum): Intersection[] {
  if (!isEditorTriangleMesh(object)) return raycaster.intersectObject(object, false);
  const instanced = object instanceof InstancedMesh && object.raycast === InstancedMesh.prototype.raycast;
  if (!object.geometry.attributes.position || (object.frustumCulled && !cameraFrustum.intersectsObject(object))) return [];
  if (instanced) {
    const mesh = new Mesh(object.geometry, object.material), local = new Matrix4();
    const hits: Intersection[] = [];
    for (let id = 0; id < object.count; id++) {
      object.getMatrixAt(id, local);
      mesh.matrixWorld.multiplyMatrices(object.matrixWorld, local);
      if (object.morphTexture) object.getMorphAt(id, mesh);
      const start = hits.length;
      meshForRaycast(mesh, object.matrixWorld, local).raycast(raycaster, hits);
      for (let i = start; i < hits.length; i++) hits[i].instanceId = id;
    }
    return hits.sort((a,b) => a.distance - b.distance);
  }
  return raycaster.intersectObject(meshForRaycast(object, object.matrixWorld), false);
}
