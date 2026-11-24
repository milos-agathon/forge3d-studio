// Two copies of the same textured triangle. At (365,330) the front copy
// discards its fragment, the DEM is opaque, and the rear copy is opaque.
export function overlappingCutouts(instanced) {
  const shifts = [[0, .8, 0], [-.8, -.8, 0]];
  const floats = values => Buffer.from(new Float32Array(values).buffer);
  // 16 x 4 RGBA PNG with a transparent left half and an opaque white right half.
  const texture = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAABAAAAAECAYAAACHtL/sAAAAGUlEQVR4nGP8//8/AwGAVwETId2EwMAbAADnWwQEmtBpIwAAAABJRU5ErkJggg==", "base64");
  const chunks = [floats([-2,0,-2, 0,0,3, 2,0,-2]), floats([0,0, .5,1, 1,0]), floats(shifts.flat()), texture];
  const binary = Buffer.concat(chunks);
  let offset = 0;
  const bufferViews = chunks.map(chunk => {
    const view = { buffer:0, byteOffset:offset, byteLength:chunk.length };
    offset += chunk.length;
    return view;
  });
  const nodes = instanced
    ? [{mesh:0, extensions:{EXT_mesh_gpu_instancing:{attributes:{TRANSLATION:2}}}}]
    : shifts.map(translation => ({mesh:0, translation}));
  const document = {
    asset:{version:"2.0"}, scene:0, scenes:[{nodes:nodes.map((_, i) => i)}], nodes,
    extensionsUsed:["KHR_materials_unlit", ...(instanced ? ["EXT_mesh_gpu_instancing"] : [])],
    meshes:[{primitives:[{attributes:{POSITION:0, TEXCOORD_0:1}, material:0}]}],
    materials:[{alphaMode:"MASK", alphaCutoff:.5, doubleSided:true, extensions:{KHR_materials_unlit:{}},
      pbrMetallicRoughness:{baseColorFactor:[1,.01,1,1], baseColorTexture:{index:0}}}],
    images:[{bufferView:3, mimeType:"image/png"}], textures:[{source:0, sampler:0}],
    samplers:[{minFilter:9728, magFilter:9728, wrapS:33071, wrapT:33071}],
    buffers:[{byteLength:binary.length}], bufferViews,
    accessors:[
      {bufferView:0, componentType:5126, count:3, type:"VEC3", min:[-2,0,-2], max:[2,0,3]},
      {bufferView:1, componentType:5126, count:3, type:"VEC2", min:[0,0], max:[1,1]},
      {bufferView:2, componentType:5126, count:2, type:"VEC3", min:[-.8,-.8,0], max:[0,.8,0]},
    ],
  };
  return {document, binary};
}

// The first pair reproduces the transparent and opaque glTF controls. The
// second pair exercises two overlapping elements in one draw and partial alpha.
export function thinCutouts(points, pose) {
  const mode = points ? 0 : 1;
  const at = (x, z) => points ? [[x,.8,z]] : [[x-.25,.8,z],[x+.25,.8,z]];
  const front = at(-.65,1);
  // Extend each eye-to-vertex ray from Y=+.8 to Y=-.8.
  const rear = front.map(p => [0,8,4].map((eye,i) => eye + (p[i]-eye) * 8.8 / 7.2));
  const partial = points ? at(.65,1) : [[.4,.8,1],[.65,.8,1.45],[.9,.8,1]];
  const groups = [at(-.65,0), at(.65,0), [...rear,...front], partial];
  const chunks = [], bufferViews = [], accessors = [];
  let byteOffset = 0;
  function accessor(values, type, bounds = {}) {
    const array = type === "SCALAR" ? new Uint32Array(values.flat()) : new Float32Array(values.flat());
    const bytes = Buffer.from(array.buffer);
    chunks.push(bytes);
    bufferViews.push({buffer:0, byteOffset, byteLength:bytes.length});
    byteOffset += bytes.length;
    return accessors.push({bufferView:bufferViews.length-1, componentType:type === "SCALAR" ? 5125 : 5126,
      type, count:values.length, ...bounds}) - 1;
  }
  function positions(vertices) {
    const bounds = fn => [0,1,2].map(i => fn(...vertices.map(p => p[i])));
    return accessor(vertices,"VEC3",{min:bounds(Math.min),max:bounds(Math.max)});
  }
  const weights = [.5,.25];
  const primitives = groups.map((vertices, material) => {
    // The weighted targets shift the opaque and partially transparent controls
    // 1.4 Studio units to the right. The baked export uses the same pose.
    const shifts = material === 1 || material === 3 ? [2,1.6] : [0,0];
    const shift = shifts[0]*weights[0] + shifts[1]*weights[1];
    const posed = pose === "baked" ? vertices.map(([x,y,z]) => [Math.fround(x)+shift,y,z]) : vertices;
    const attributes = {POSITION:positions(posed)};
    const primitive = {mode:!points && material === 3 ? 2 : mode, attributes, material};
    if (pose === "morph") {
      primitive.targets = shifts.map(dx => ({POSITION:positions(vertices.map(() => [dx,0,0]))}));
    }
    if (material === 2) {
      attributes.COLOR_0 = accessor(vertices.map((_,i) => [1,1,1,i < rear.length ? 1 : 0]),"VEC4");
      // Submit the transparent front first, using offsets distinct from its vertex indices.
      primitive.indices = accessor(vertices.map((_,i) => (i + rear.length) % vertices.length),"SCALAR");
    }
    return primitive;
  });
  const materials = [["BLEND",0],["OPAQUE",1],[points ? "MASK" : "BLEND",1],["BLEND",.5]].map(([alphaMode,a]) => ({
    alphaMode, extensions:{KHR_materials_unlit:{}}, pbrMetallicRoughness:{baseColorFactor:[1,0,1,a]},
  }));
  const document = {asset:{version:"2.0"}, extensionsUsed:["KHR_materials_unlit"], scene:0, scenes:[{nodes:[0]}],
    nodes:[{mesh:0}], meshes:[{primitives, ...(pose === "morph" ? {weights} : {})}], materials, accessors, bufferViews, buffers:[{byteLength:byteOffset}]};
  return {document, binary:Buffer.concat(chunks)};
}
