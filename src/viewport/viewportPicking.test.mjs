import assert from "node:assert/strict";
import { test } from "node:test";
import { Camera, TerrainDataset } from "@forge3d/web";
import { BoxGeometry, BufferGeometry, Float32BufferAttribute, Group, InstancedMesh, Line, LineBasicMaterial, LineLoop, LineSegments, Matrix4, Mesh, PerspectiveCamera, PlaneGeometry, Points, PointsMaterial, Vector3 } from "three";
import { cubeScatterGeometry } from "./forge3dWebMapping.ts";
import { canvasPixel, measurePixelDepth, pickEditor, pickSurfaces } from "./viewportPicking.ts";
import { terrainHitElevation } from "./editorTrianglePicking.ts";
import { ViewportModel } from "./viewportState.ts";
import { readFileSync } from "node:fs";

const viewport = { width: 101, height: 101 };
const center = [50, 50];
const placement = { translation: [0, 0, 0], scale: 1 };
const cube = { id: "cube", geometry: new BoxGeometry(2, 2, 2) };
const facing = new Camera({ position: [0, 0, 5], target: [0, 0, 0], near: .1, far: 30 });

test("near and far planes clip individual faces, including oblique rays", () => {
  const pick = (camera, pixel = center) => pickSurfaces(camera, viewport, pixel, placement, { cube }, 7).hit;
  assert.equal(pick(facing).worldPosition[2], 1);
  assert.ok(Math.abs(pick(facing.with({ near: 5 })).worldPosition[2] + 1) < 1e-12);
  assert.equal(pick(facing.with({ far: 3.9 })), null);
  assert.equal(pick(facing.with({ near: 6.1 })), null);
  const offAxis = pick(facing.with({ far: 4.01 }), [75, 50]);
  assert.ok(offAxis.distance > 4.01);
  assert.equal(offAxis.frameRevision, 7);
});

test("flattened indexed cube shares the submitted camera origin at four billion units", () => {
  const origin = { translation: [4_000_000_000, 0, 0], scale: 1 };
  const { geometry, transforms } = cubeScatterGeometry(2, {
    rotationDeg: [0, 0, 0], scale: [1, 1, 0], translation: origin.translation,
  }, origin);
  geometry.applyMatrix4(new Matrix4().fromArray(transforms).transpose());
  const hit = pickSurfaces(facing, viewport, center, origin, { cube: { id: "flat", geometry } }, 3).hit;
  assert.deepEqual(hit.worldPosition, origin.translation);
  assert.equal(hit.id, "flat");
  assert.equal(hit.distance, 5);
});

test("cube silhouette hits and misses defer to raster coverage and retain the clicked ray", () => {
  const size = { width: 794, height: 727 };
  for (const [z, x, interior] of [[9.478847292072615, 500, 499], [9.478961982570125, 293, 294]]) {
    const camera = new Camera({ position:[0,0,z], target:[0,0,0], fovYDegrees:45, near:.05, far:2000 });
    const pick = px => pickSurfaces(camera, size, [px,363], placement, {cube}, 17);
    const edge = pick(x);
    assert.equal(edge.terrain, null);
    assert.equal(edge.cube.id, cube.id);
    assert.equal(edge.cube.frameRevision, 17);
    assert.ok(Math.abs(edge.cube.worldPosition[2] - 1) < 1e-7);
    const screen = camera.worldToScreen(edge.cube.worldPosition, size);
    assert.ok(Math.hypot(screen.x - x - .5, screen.y - 363.5) < 1e-7);
    assert.equal(pick(interior).hit.id, cube.id);
    assert.equal(pick(2*x - interior).hit, null);
  }
});

test("a grazing cube face measures fragment depth even inside its projected edges", () => {
  const size = { width: 794, height: 727 };
  const pick = height => pickSurfaces(new Camera({ position:[0,height,10], target:[0,1,0],
    fovYDegrees:45, near:.05, far:2000 }), size, [397,363], placement, {cube}, 17);
  const grazing = pick(1.1);
  assert.equal(grazing.cube.id, cube.id);
  assert.ok(grazing.cubeDepths.hints.length);
  assert.ok(grazing.cubeDepths.minimum < grazing.cubeDepths.maximum);
  assert.equal(pick(4).hit.id, cube.id);
});

test("terrain silhouette defers both a mathematical hit and a raster-only hit to coverage", () => {
  const size = { width: 794, height: 727 };
  const grid = TerrainDataset.fromArray({width:2, height:2, spacing:[12,11.4], domain:[0,1], heights:new Float32Array(4)});
  for (const [height, x] of [[50.8730837524357,500], [50.873771895420745,293]]) {
    const camera = new Camera({position:[0,height,0.00001], target:[0,0,0], up:[0,0,-1], fovYDegrees:45, near:.05, far:2000});
    const surface = pickSurfaces(camera, size, [x,363], placement, {terrain:{id:"terrain",grid}}, 17);
    assert.equal(surface.cube, null);
    assert.equal(surface.terrain.id, "terrain");
    assert.equal(surface.terrain.frameRevision, 17);
    assert.ok(Math.abs(surface.terrain.worldPosition[1]) < 1e-6);
    const screen = camera.worldToScreen(surface.terrain.worldPosition, size);
    assert.ok(Math.hypot(screen.x - x - .5, screen.y - 363.5) < 1e-7);
  }
});

test("a shared DEM vertex stays synchronous while a folded ridge defers to the framebuffer", () => {
  const grid = TerrainDataset.fromArray({width:3,height:3,spacing:[4,4],domain:[0,4],
    heights:new Float32Array([0,0,0,4,4,4,0,0,0])});
  const pick = camera => pickSurfaces(camera,viewport,center,placement,{terrain:{id:"DEM",grid}},19);
  const above = new Camera({position:[0,10,0],target:[0,0,0],up:[0,0,-1],near:.05,far:100});
  assert.equal(pick(above).hit.id, "DEM");
  const grazing = new Camera({position:[0,4,10],target:[0,4,0],near:.05,far:100});
  assert.equal(pick(grazing).terrain.id, "DEM");
});

test("a foreground ridge missed by the centre ray still competes with a cube ahead of the back slope", () => {
  const grid = TerrainDataset.fromArray({width:3, height:5, spacing:[2,1], domain:[0,2],
    heights:new Float32Array([0,0,0, 2,2,2, 0,0,0, 1,1,1, 0,0,0])});
  const camera = new Camera({position:[.15,1.000001,5],target:[.15,1.000001,0],near:.05,far:30});
  const geometry = new BoxGeometry(.2,.2,.2).translate(.15,1,.35);
  const result = pickSurfaces(camera,viewport,center,placement,{terrain:{id:"DEM",grid},cube:{id:"cube",geometry}},7);
  assert.equal(result.cube.id, "cube");
  assert.equal(result.terrain.id, "DEM");
  assert.ok(result.terrain.distance > result.cube.distance);
  assert.ok(result.terrainDepths.hints.length >= 2);
  assert.ok(result.terrainDepths.minimum < result.terrainDepths.maximum);
});

test("depth measurement verifies the folded and back-slope hints, with a bounded fallback outside both", async () => {
  const steps = 2 ** 24;
  const depths = {minimum: .75, maximum: .96, hints:[.8, .900001, .900001]};
  async function sample(truth) {
    const probes = [];
    const measured = await measurePixelDepth(depths, async depth => {
      assert.ok(!probes.includes(depth));
      probes.push(depth);
      return depth < truth;
    });
    assert.ok(Math.abs(measured - truth) <= .5 / steps);
    return probes.length;
  }
  assert.ok(await sample(.8) <= 4);
  assert.ok(await sample(.900001) <= 4);
  assert.ok(await sample(.985) <= 29);
});

test("both admitted triangles use the NE/SW diagonal and the packed elevation datum", () => {
  const grid = TerrainDataset.fromArray({ width: 2, height: 2, spacing: [4, 2], exaggeration: 2,
    domain: [100, 104], heights: new Float32Array([100, 102, 101, 104]) });
  for (const [x,z,y] of [[-1,-.5,1.5], [1,.5,5.5], [0,0,3], [2.5,0,null]]) {
    const camera = new Camera({position:[x,20,z], target:[x,0,z], up:[0,0,-1], far:30});
    const hit = pickSurfaces(camera, viewport, center, placement, {terrain:{id:"DEM",grid}}, 9).hit;
    if (y === null) assert.equal(hit, null);
    else assert.ok(Math.abs(hit.worldPosition[1] - y) < 1e-6);
  }
});

test("a possible depth tie preserves both ray hits for the GPU ID pass", () => {
  const camera = new Camera({position:[0,145,20],target:[0,0,0],near:.05,far:2000});
  const grid = TerrainDataset.fromArray({width:2,height:2,spacing:[12,12],domain:[0,1],heights:new Float32Array(4)});
  for (const [y, expected] of [[-.002,"tie"],[-2,"DEM"],[2,"box"]]) {
    const geometry = new BoxGeometry(2,2,2).scale(1,0,1).translate(0,y,0);
    const hit = pickSurfaces(camera, {width:794,height:727}, [397,363], placement,
      {cube:{id:"box",geometry},terrain:{id:"DEM",grid}}, 11);
    if (expected === "tie") {
      assert.equal(hit.terrain.id, "DEM");
      assert.equal(hit.cube.id, "box");
      assert.ok(Math.abs(hit.cube.worldPosition[1] - y) < 1e-6);
    } else assert.equal(hit.hit.id, expected);
  }
});

test("a grazing ray can select the visible terrain edge skirt", () => {
  const grid = TerrainDataset.fromArray({ width: 2, height: 2, spacing: [2,2], heights: new Float32Array(4), domain: [0,1] });
  const camera = facing.with({ position:[0,-.12,5], target:[0,-.12,0] });
  const pick = pickSurfaces(camera, viewport, center, placement, {terrain:{id:"DEM",grid}}, 10);
  const hit = "hit" in pick ? pick.hit : pick.terrain;
  assert.equal(hit.kind, "terrain");
  assert.ok(Math.abs(hit.worldPosition[2]-1) < 1e-6 && Math.abs(hit.worldPosition[1]+.12) < 1e-6);
});

test("canvas bounds are half-open and use the actual scaled canvas rectangle", () => {
  const rect = { left: 10.25, top: 5.5, width: 109.75, height: 50.25 }, size = { width: 137, height: 62 };
  assert.deepEqual(canvasPixel(10.25, 5.5, rect, size), [0, 0]);
  assert.deepEqual(canvasPixel(119.99, 55.749, rect, size), [136, 61]);
  assert.equal(canvasPixel(120, 55.75, rect, size), undefined);
  assert.equal(canvasPixel(10.24, 10, rect, size), undefined);
});

test("editor picking excludes hidden subtrees and surfaces already owned by the GPU", () => {
  const camera = new PerspectiveCamera(45, 1, .1, 30);
  camera.position.z = 6;
  camera.updateMatrixWorld();
  const groups = new Map(), objects = [];
  for (const [id,z] of [["back",0], ["front",2], ["hidden",4]]) {
    const group = new Group(), sub = new Group();
    sub.visible = id !== "hidden";
    group.add(sub);
    sub.add(new Mesh(new BoxGeometry(1,1,1)));
    group.position.z = z;
    group.updateMatrixWorld();
    groups.set(id, group);
    objects.push({ id, visible: true, kind: { type:"mesh", source:{ type:"primitive", primitive:{ type:"cube", size:1 } } } });
  }
  const pick = owned => pickEditor(camera, viewport, center, objects, groups, owned, 1);
  assert.equal(pick([]).id, "front");
  assert.equal(pick(["front"]).id, "back");
  groups.get("back").visible = false;
  assert.equal(pick(["front"]), null);
});

test("a camera wire must cross the physical pixel before it can cover a mesh", () => {
  const camera = new PerspectiveCamera(45,1,.05,100);
  camera.position.z = 10;
  camera.updateMatrixWorld();
  const wire = new LineSegments(new BufferGeometry().setAttribute("position",
    new Float32BufferAttribute([0,-1,0, 0,1,0], 3)));
  const helper = new Group().add(wire), box = new Group().add(new Mesh(cube.geometry));
  const groups = new Map([["wire",helper],["box",box]]);
  const objects = [{id:"wire",visible:true,kind:{type:"camera"}},
    {id:"box",visible:true,kind:{type:"mesh",source:{type:"primitive",primitive:{type:"cube"}}}}];
  const pick = x => {
    helper.position.set(x,0,4);
    helper.updateMatrixWorld();
    return pickEditor(camera,viewport,center,objects,groups,[],1);
  };
  assert.equal(pick(.5).id,"box");
  assert.equal(pick(0).id,"wire");
});

test("a singular editor cube keeps its two visible faces after a parent transform", () => {
  const camera = new PerspectiveCamera(45, 1, .1, 30);
  camera.position.z = 6;
  camera.updateMatrixWorld();
  const group = new Group().add(new Mesh(cube.geometry));
  group.scale.z = 0;
  group.position.z = 1;
  group.rotation.y = .4;
  group.updateMatrixWorld();
  const object = {id:"box",visible:true,kind:{type:"mesh",source:{type:"primitive",primitive:{type:"cube"}}}};
  const hit = pickEditor(camera, viewport, center, [object], new Map([["box",group]]), [], 7);
  assert.equal(hit.kind, "cube");
  assert.ok(Math.abs(hit.distance - 5) < 1e-6);
});

test("flattened and additively morphed triangles use their drawn pose and original face", () => {
  const camera = new PerspectiveCamera(45,1,.1,30);
  camera.position.z = 6;
  camera.updateMatrixWorld();
  const object = {id:"ink",visible:true,kind:{type:"mesh",source:{type:"gltf"}}};
  for (const instanced of [false,true]) for (const morph of [false,true]) {
    const geometry = new PlaneGeometry(.25,.25);
    const ordinary = new Mesh(geometry);
    const matrix = new Matrix4().makeScale(1,1,morph ? 1 : 0);
    if (morph) {
      geometry.translate(1.4,0,0);
      geometry.morphTargetsRelative = true;
      geometry.morphAttributes.position = [-.6,-.8].map(dx =>
        new Float32BufferAttribute(Array.from({length:4},()=>[dx,0,0]).flat(),3));
      ordinary.updateMorphTargets();
      ordinary.morphTargetInfluences.fill(1);
      geometry.computeBoundingSphere();
      geometry.computeBoundingBox();
    }
    const mesh = instanced ? new InstancedMesh(geometry,ordinary.material,1) : ordinary;
    if (instanced) {
      mesh.setMatrixAt(0,matrix);
      if (morph) mesh.setMorphAt(0,ordinary);
    }
    mesh.matrixAutoUpdate = false;
    if (!instanced) mesh.matrix.copy(matrix);
    const group = new Group().add(mesh);
    group.position.z = 1;
    group.updateMatrixWorld(true);
    const checked = [];
    mesh.material.alphaTest = .5;
    const hit = pickEditor(camera,viewport,center,[object],new Map([["ink",group]]),[],11,{
      primitiveVisible: (node,offset,instance) => { assert.equal(node,mesh); checked.push([offset,instance]); return true; },
    });
    assert.equal(hit?.id,"ink");
    assert.deepEqual(hit.worldPosition,[0,0,1]);
    assert.equal(hit.distance,5);
    assert.ok([0,3].includes(checked[0][0]));
    assert.equal(checked[0][1],instanced ? 0 : undefined);
  }
});

test("off-centre opaque strokes and sprites are selected only when raster samples are covered", () => {
  const camera = new PerspectiveCamera(90,1,.1,30);
  camera.position.z = 5;
  camera.updateMatrixWorld();
  const x = .7 * 10 / viewport.width;
  for (const Shape of [Points, LineSegments]) {
    const geometry = new BufferGeometry().setAttribute("position",new Float32BufferAttribute(
      Shape === Points ? [x,0,0] : [x,-.1,0,x,.1,0],3));
    const mesh = Shape === Points ? new Points(geometry,new PointsMaterial({size:1,sizeAttenuation:false})) : new LineSegments(geometry);
    const group = new Group().add(mesh);
    const object = {id:"ink",visible:true,kind:{type:"mesh",source:{type:"gltf"}}};
    for (const covered of [true,false]) {
      const offsets = [];
      const hit = pickEditor(camera,viewport,center,[object],new Map([["ink",group]]),[],11,{
        primitiveVisible: (_,offset) => { offsets.push(offset); return covered; },
      });
      assert.deepEqual(offsets,[0]);
      assert.equal(hit?.id,covered ? "ink" : undefined);
      if (hit) assert.deepEqual(hit.worldPosition,[0,0,0]);
    }
  }
});

test("glTF points use the displayed sprite size and the renderer point-size limit", () => {
  const camera = new PerspectiveCamera(45, 1, .1, 30);
  camera.position.z = 6;
  camera.updateMatrixWorld();
  const material = new PointsMaterial({size:1, sizeAttenuation:false});
  const points = new Points(new BufferGeometry().setAttribute("position", new Float32BufferAttribute([0,0,0],3)),material);
  const groups = new Map([["dot",new Group().add(points)]]);
  const objects = [{id:"dot",visible:true,kind:{type:"mesh",source:{type:"gltf"}}}];
  const pick = x => pickEditor(camera,{...viewport,pixelRatio:2},[x,50],objects,groups,[],1,{pointSizeRange:[1,4]});
  assert.equal(pick(50).id,"dot");
  assert.equal(pick(54),null);
  material.sizeAttenuation = true;
  assert.equal(pick(51).id,"dot");
  assert.equal(pick(54),null);
});

test("discarding a thin primitive leaves a deeper primitive in the same indexed draw eligible", () => {
  const camera = new PerspectiveCamera(45, 1, .1, 30);
  camera.position.z = 6;
  camera.updateMatrixWorld();
  const geometry = new BufferGeometry().setAttribute("position", new Float32BufferAttribute(
    [-1,0,1, 1,0,1, -1,0,2, 1,0,2, 0,0,1, 0,0,2], 3));
  const lineMaterial = new LineBasicMaterial({transparent:true});
  const pointMaterial = new PointsMaterial({alphaTest:.5, sizeAttenuation:false});
  for (const [source,indices,front,rear] of [
    [new Points(geometry,pointMaterial), [0,5,4], 1, 2],
    [new LineSegments(geometry,lineMaterial), [5,2,3,0,1], 1, 3],
  ]) {
    geometry.setIndex(indices);
    geometry.setDrawRange(1,indices.length-1);
    const checked = [];
    const group = new Group().add(source);
    const hit = pickEditor(camera, viewport, center, [{id:"ink",visible:true,kind:{type:"mesh",source:{type:"gltf"}}}],
      new Map([["ink",group]]), [], 9, {primitiveVisible: (object, offset) => {
        assert.equal(object,source);
        checked.push(offset);
        return offset === rear;
      }});
    assert.deepEqual(checked,[front,rear]);
    assert.deepEqual(hit.worldPosition,[0,0,1]);
  }
});

test("thin primitives use current relative and absolute morph weights before the world transform", () => {
  const camera = new PerspectiveCamera(45,1,.1,30);
  camera.position.z = 6;
  camera.updateMatrixWorld();
  const object = {id:"ink",visible:true,kind:{type:"mesh",source:{type:"gltf"}}};
  for (const Shape of [Points, LineSegments, Line, LineLoop]) {
    for (const relative of [true,false]) {
      const ys = Shape === Points ? [0] : [-.08,.08];
      const attribute = (x, z, delta) => new Float32BufferAttribute(ys.flatMap(y => [x,delta ? 0 : y,z]),3);
      const geometry = new BufferGeometry().setAttribute("position",attribute(1.5,0,false));
      geometry.setIndex(ys.map((_,i) => ys.length-i-1));
      geometry.morphTargetsRelative = relative;
      geometry.morphAttributes.position = [
        attribute(relative ? -.25 : 1.25,.25,relative), attribute(relative ? .5 : 2,0,relative),
      ];
      const source = new Shape(geometry);
      const group = new Group().add(source);
      group.position.x = -1;
      group.scale.x = 2;
      group.updateMatrixWorld();
      const pick = pixel => pickEditor(camera,viewport,pixel,[object],new Map([["ink",group]]),[],1);
      assert.equal(pick(center),null);
      assert.equal(pick([91,50]).id,"ink");
      source.morphTargetInfluences.splice(0,2,2,-1);
      assert.equal(pick([91,50]),null);
      const hit = pick(center);
      assert.deepEqual(hit?.worldPosition,[0,0,.5],Shape.name);
      assert.equal(hit.distance,5.5);
      source.morphTargetInfluences.fill(0);
      assert.equal(pick(center),null);
    }
  }
});

test("morphed thin primitives respect the renderer's camera cull", () => {
  const camera = new PerspectiveCamera(45,1,.1,30);
  camera.position.z = 6;
  camera.updateMatrixWorld();
  for (const Shape of [Points,LineSegments]) {
    const ys = Shape === Points ? [0] : [-.1,.1];
    const geometry = new BufferGeometry().setAttribute("position", new Float32BufferAttribute(ys.flatMap(y => [10,y,0]),3));
    geometry.morphTargetsRelative = true;
    geometry.morphAttributes.position = [new Float32BufferAttribute(ys.flatMap(() => [-1,0,0]),3)];
    const source = new Shape(geometry);
    source.morphTargetInfluences[0] = 10;
    const groups = new Map([["ink",new Group().add(source)]]);
    const pick = () => pickEditor(camera,viewport,center,[{id:"ink",visible:true,kind:{type:"mesh",source:{type:"gltf"}}}],groups,[],1);
    assert.equal(pick(),null);
    source.frustumCulled = false;
    assert.deepEqual(pick()?.worldPosition,[0,0,0]);
  }
});

test("the closing edge of a line loop has its own draw offset", () => {
  const camera = new PerspectiveCamera(45,1,.1,30);
  camera.position.z = 6;
  camera.updateMatrixWorld();
  const geometry = new BufferGeometry().setAttribute("position",new Float32BufferAttribute([-1,0,0, 0,1,0, 1,0,0],3));
  geometry.setIndex([1,2,1,0]);
  geometry.setDrawRange(1,3);
  const loop = new LineLoop(geometry,new LineBasicMaterial({transparent:true}));
  const checked = [];
  const hit = pickEditor(camera,viewport,center,[{id:"loop",visible:true,kind:{type:"mesh",source:{type:"gltf"}}}],
    new Map([["loop",new Group().add(loop)]]),[],1,{primitiveVisible: (_,offset) => { checked.push(offset); return false; }});
  assert.deepEqual(checked,[3]);
  assert.equal(hit,null);
});

test("three.js samples raw bilinear elevation at the terrain hit UV, including a relative datum", () => {
  const camera = new PerspectiveCamera(45,1,.1,30);
  camera.position.z = 5;
  camera.updateMatrixWorld();
  const mesh = new Mesh(new PlaneGeometry(2,2));
  const datum = 4_000_000_000;
  mesh.userData.forgeTerrain = {heightOrigin:datum,
    preview:{resolution:2, heights:[datum,datum,datum,datum+8], minElevation:datum, maxElevation:datum+8}};
  const group = new Group().add(mesh);
  group.rotation.z = .5;
  group.updateMatrixWorld();
  const hit = pickEditor(camera,viewport,center,[{id:"DEM",kind:{type:"terrain"},visible:true}],
    new Map([["DEM",group]]),[],1);
  assert.equal(hit.elevation,datum+2);
});

test("flattened terrain retains DEM coordinates at both centred and sample-only hits", () => {
  const camera = new PerspectiveCamera(45,1,.1,30);
  camera.position.set(0,5,0);
  camera.up.set(0,0,-1);
  camera.lookAt(0,0,0);
  camera.updateMatrixWorld();
  const mesh = new Mesh(new PlaneGeometry(1,1).rotateX(-Math.PI/2));
  mesh.userData.forgeTerrain = {heightOrigin:0,
    preview:{resolution:2, heights:[3,4,5,6], minElevation:3, maxElevation:6}};
  const group = new Group().add(mesh);
  group.scale.y = 0;
  group.updateMatrixWorld();
  const objects = [{id:"terrain",kind:{type:"terrain"},visible:true}];
  const groups = new Map([["terrain",group]]);
  let centreHits;
  const pick = pixel => pickEditor(camera,viewport,pixel,objects,groups,[],42,{
    rasterDepths: candidates => candidates.map(({rayDepths}) => {
      centreHits = rayDepths();
      return centreHits[0] ?? 5;
    }),
  });
  assert.ok(Math.abs(pick(center).elevation - 4.5) < 1e-10);
  assert.ok(centreHits.length > 0);
  // The x=.5 edge falls in column 62, just left of its pixel centre.
  group.position.x = -.01;
  group.updateMatrixWorld();
  assert.ok(Math.abs(pick([62,50]).elevation - 5) < 1e-10);
  assert.deepEqual(centreHits,[]);
});

test("relief preserves terrain coordinates when a horizontal axis collapses", () => {
  const geometry = new PlaneGeometry(1,1).rotateX(-Math.PI/2);
  const positions = geometry.getAttribute("position");
  for (let i = 0; i < positions.count; i++) positions.setY(i,positions.getX(i) + .5);
  const mesh = new Mesh(geometry);
  mesh.scale.x = 0;
  mesh.rotation.z = .3;
  mesh.position.set(6,5,4);
  mesh.updateMatrixWorld();
  const terrain = {heightOrigin:0,preview:{resolution:2, heights:[3,4,5,6], minElevation:3, maxElevation:6}};
  const point = new Vector3(0,.2,.1).applyMatrix4(mesh.matrixWorld);
  assert.ok(Math.abs(terrainHitElevation(mesh,terrain,point) - 4.4) < 1e-10);
});

test("a snapshot resolves a reverse-ordered deep ancestry once and hides cycles", () => {
  const project = JSON.parse(readFileSync(new URL("../../samples/bryce-terrain.studio3d", import.meta.url)));
  const source = project.scene.objects[1], count = 1000;
  let reads = 0;
  project.scene.objects = Array.from({length:count}, (_, i) => ({...source, id:String(i),
    get parent() {reads++; return i === count-1 ? null : String(i+1);}}));
  project.scene.activeCamera = "500";
  const model = new ViewportModel();
  model.setProject(project,1,true);
  assert.equal(model.current.objects.filter(o=>o.visible).length, count-1);
  assert.ok(reads <= 3 * count, `Read ${reads} parent links`);
  project.scene.objects[count-1] = {...project.scene.objects[count-1],parent:"500"};
  model.setProject(project,1,false);
  assert.ok(model.current.objects.every(o=>!o.visible));
});

test("a hidden Studio ancestor suppresses a visible grandchild regardless of scene order", () => {
  const project = JSON.parse(readFileSync(new URL("../../samples/bryce-terrain.studio3d", import.meta.url)));
  const [terrain, camera, light] = project.scene.objects;
  terrain.parent = camera.id;
  camera.parent = light.id;
  light.visible = false;
  const model = new ViewportModel(project, 1);
  assert.deepEqual(model.current.objects.map(o => o.visible), [false,false,false]);
  light.visible = true;
  model.setProject(project, 1, false);
  assert.deepEqual(model.current.objects.map(o => o.visible), [true,true,true]);
});
