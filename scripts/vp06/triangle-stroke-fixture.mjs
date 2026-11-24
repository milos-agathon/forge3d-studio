import {PerspectiveCamera, Vector3} from "three";

// Studio places the object at Y=.8. Most primitives share that plane.
export function triangleStrokeFixture() {
  const camera = new PerspectiveCamera(45,794/727,.05,2000);
  camera.position.set(0,8,4);
  camera.lookAt(0,0,0);
  camera.updateMatrixWorld();
  function vertexAtPixel(x,y,worldY=.8) {
    const ray = new Vector3(2*x/794-1,1-2*y/727,.5).unproject(camera).sub(camera.position);
    const point = camera.position.clone().addScaledVector(ray,(worldY-camera.position.y)/ray.y);
    return [point.x,worldY-.8,point.z];
  }
  const strokes = [], points = [];
  for (const [pixel,offsets] of [[442,[0]],[464,[-.54,.54]]]) {
    for (const offset of offsets) {
      const x = pixel + .5 + offset;
      strokes.push(vertexAtPixel(x,311.5),vertexAtPixel(x,325.5));
      points.push(vertexAtPixel(x,353.5));
    }
  }
  const chunks = [], bufferViews = [], accessors = [];
  let byteOffset = 0;
  function positions(vertices) {
    const array = new Float32Array(vertices.flat());
    const bounds = fn => [0,1,2].map(axis => fn(...vertices.map((_,i) => array[3*i+axis])));
    chunks.push(Buffer.from(array.buffer));
    const view = bufferViews.push({buffer:0,byteOffset,byteLength:array.byteLength})-1;
    byteOffset += array.byteLength;
    return accessors.push({bufferView:view,type:"VEC3",componentType:5126,count:vertices.length,
      min:bounds(Math.min),max:bounds(Math.max)})-1;
  }
  const triangle = x => [[x-.04,0,-.025],[x,0,.03],[x+.04,0,-.025]];
  const meshes = [];
  function mesh(vertices,mode,shifts = []) {
    const primitive = {mode,attributes:{POSITION:positions(vertices)},material:0};
    if (shifts.length) primitive.targets = shifts.map(delta => ({POSITION:positions(vertices.map(() => delta))}));
    return meshes.push({primitives:[primitive], ...(shifts.length ? {weights:shifts.map(() => 1)} : {})})-1;
  }
  const nodes = [
    {mesh:mesh(triangle(.65),4),scale:[1,0,1]},
    {mesh:mesh(triangle(.95),4,[[.55,0,.04],[.55,0,-.04]])},
    {mesh:mesh(strokes,1)}, {mesh:mesh(points,0)},
  ];
  // The tiny triangle contains only the pixel centre. The two strips cover
  // all four display samples while leaving a gap through the pixel centre.
  for (const [centre,material] of [[458.5,0],[483.5,1]]) {
    const v = (x,y) => vertexAtPixel(centre+x,y);
    const strip = (left,right) => [v(left,349.5),v(right,349.5),v(right,357.5),
      v(left,349.5),v(right,357.5),v(left,357.5)];
    const vertices = [v(-.075,318.575),v(.075,318.575),v(0,318.425),
      ...strip(-1.4,-.04),...strip(.04,1.4)];
    if (material === 0) {
      // Every vertex is below terrain. Extending either strip's plane into
      // the gap instead gives a positive height at the centre of (508,353).
      for (const sign of [-1,1]) {
        const slope = (offset,y) => vertexAtPixel(508.5+sign*offset,y,.005-.16*offset);
        vertices.push(slope(.04,349.5),slope(.64,349.5),slope(.64,357.5),
          slope(.04,349.5),slope(.64,357.5),slope(.04,357.5));
      }
    }
    const index = mesh(vertices,4);
    meshes[index].primitives[0].material = material;
    nodes.push({mesh:index});
  }
  const magenta = {doubleSided:true,extensions:{KHR_materials_unlit:{}},pbrMetallicRoughness:{baseColorFactor:[1,0,1,1]}};
  const opaque = mesh([[518,390],[535,362],[551,390]].map(([x,y]) => vertexAtPixel(x,y)),4);
  meshes[opaque].primitives[0].material = 2;
  nodes.push({mesh:opaque});
  // The uploaded model-view translation loses the fraction at this origin.
  const origin = 10_000_000, translation = [.4-origin,0,0];
  nodes.push({mesh:mesh([[origin+1,0,-1],[origin+1,0,-.86]],1),translation},
    {mesh:mesh([[origin+1,0,-.7454]],0),translation});
  const document = {asset:{version:"2.0"},extensionsUsed:["KHR_materials_unlit"],scene:0,
    scenes:[{nodes:nodes.map((_,i)=>i)}],nodes,meshes,buffers:[{byteLength:byteOffset}],bufferViews,accessors,
    materials:[magenta,{...magenta,alphaMode:"MASK",alphaCutoff:.5},
      {alphaMode:"OPAQUE",doubleSided:true,pbrMetallicRoughness:{baseColorFactor:[1,0,1,0]}}]};
  return {document,binary:Buffer.concat(chunks)};
}

export function transformedTriangleFixture(skinned) {
  const origin = 10_000_000;
  const xyz = skinned ? [.47,.8,-.16, .65,.8,.22, .83,.8,-.16] : [origin-1,0,-.5, origin,0,.55, origin+1,0,-.5];
  const positions = new Float32Array(xyz);
  const chunks = [Buffer.from(positions.buffer)];
  const bounds = fn => [0,1,2].map(axis => fn(positions[axis],positions[axis+3],positions[axis+6]));
  const accessors = [{bufferView:0,type:"VEC3",componentType:5126,count:3,min:bounds(Math.min),max:bounds(Math.max)}];
  const nodes = [{mesh:0}], attributes = {POSITION:0};
  if (skinned) {
    // A separate root joint stays at its bind pose across the Studio move.
    nodes[0].skin = 0;
    nodes.push({name:"Joint"});
    chunks.push(Buffer.alloc(12),Buffer.from(new Float32Array([1,0,0,0, 1,0,0,0, 1,0,0,0]).buffer));
    attributes.JOINTS_0 = accessors.push({bufferView:1,type:"VEC4",componentType:5121,count:3})-1;
    attributes.WEIGHTS_0 = accessors.push({bufferView:2,type:"VEC4",componentType:5126,count:3})-1;
  } else {
    nodes[0].translation = [-origin,0,0];
  }
  let byteOffset = 0;
  const bufferViews = chunks.map(chunk => {
    const view = {buffer:0,byteOffset,byteLength:chunk.length};
    byteOffset += chunk.length;
    return view;
  });
  const document = {asset:{version:"2.0"},extensionsUsed:["KHR_materials_unlit"],scene:0,
    scenes:[{nodes:nodes.map((_,i)=>i)}],nodes,...(skinned ? {skins:[{skeleton:1,joints:[1]}]} : {}),
    meshes:[{primitives:[{attributes,material:0}]}],buffers:[{byteLength:byteOffset}],bufferViews,accessors,
    materials:[{doubleSided:true,extensions:{KHR_materials_unlit:{}},pbrMetallicRoughness:{baseColorFactor:[1,0,1,1]}}]};
  return {document,binary:Buffer.concat(chunks)};
}
