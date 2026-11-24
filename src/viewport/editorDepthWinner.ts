import { AddEquation, Color, CustomBlending, DepthTexture, FloatType, InstancedBufferAttribute, InstancedMesh,
  Light, Line, LineBasicMaterial, LineLoop, LineSegments, Mesh, OneFactor, OneMinusSrcAlphaFactor, Plane, Vector3, Uint32BufferAttribute, UnsignedShortType, WebGLRenderTarget, ZeroFactor,
  type Group, type Material, type Object3D, type PerspectiveCamera, type Points, type Scene, type WebGLRenderer } from "three";
import { depthTieWindow, type Pixel, type RasterCandidate, type StudioHit } from "./viewportPicking";
import type { ViewportDimensions } from "./viewportState";

function pickTarget(renderer: WebGLRenderer, depthBits: number, size: ViewportDimensions, pixel: Pixel, slots = 1) {
  const gl = renderer.getContext();
  // Implicit texture LOD uses derivatives from a 2x2 fragment quad. Keep
  // each replay in the same quad lane as the displayed framebuffer pixel.
  // Matching height parity preserves that lane for both top- and bottom-origin targets.
  // Matching height parity preserves row alignment from either framebuffer origin.
  const width = 2 * slots, height = 2 + (size.height % 2);
  const bottom = size.height - 1 - pixel[1];
  const x = pixel[0] % 2, y = bottom % 2;
  const depthTexture = depthBits === 16 || depthBits === 32
    ? new DepthTexture(width, height, depthBits === 16 ? UnsignedShortType : FloatType) : null;
  const target = new WebGLRenderTarget(width, height, { depthTexture, samples: gl.getParameter(gl.SAMPLES) });
  target.viewport.set(x - pixel[0], y - bottom, size.width, size.height);
  target.scissor.set(x, y, 1, 1);
  target.scissorTest = true;
  return target;
}

/** Give each draw a scissored texel with the original multisample coverage.
 * Read the row together, then measure linear fragment depth for covered draws. */
export function editorRasterDepths(
  { renderer, scene, depthBits }: { renderer: WebGLRenderer; scene: Scene; depthBits: number },
  camera: PerspectiveCamera, size: ViewportDimensions, pixel: Pixel,
  candidates: readonly RasterCandidate[],
): (number | undefined)[] {
  if (!candidates.length) return [];
  const slots = Math.min(64, candidates.length);
  const target = pickTarget(renderer, depthBits, size, pixel, slots);
  const { x: firstColumn, y: row } = target.scissor;
  const previousTarget = renderer.getRenderTarget(), planes = renderer.clippingPlanes;
  const cubeFace = renderer.getActiveCubeFace(), mipLevel = renderer.getActiveMipmapLevel();
  const clearColor = renderer.getClearColor(new Color()), clearAlpha = renderer.getClearAlpha();
  const shadows = renderer.shadowMap.autoUpdate, children = scene.children, background = scene.background;
  const updateWorld = scene.matrixWorldAutoUpdate;
  const lightChildren = new Map<Light, Object3D[]>();
  scene.traverseVisible(node => {
    if (node instanceof Light) lightChildren.set(node, node.children);
  });
  const drawList: Object3D[] = [...lightChildren.keys()];
  const drawIndex = drawList.length;
  const restoreWidths: (() => void)[] = [];
  const rgba = new Uint8Array(4 * target.width), depths = new Array<number | undefined>(candidates.length).fill(undefined);
  const plane = new Plane(), towardsEye = new Vector3(0, 0, 1);
  const depthPlanes = [...planes, plane];

  function draw(object: RasterCandidate["object"], slot: number) {
    target.scissor.x = firstColumn + 2 * slot;
    target.viewport.x = target.scissor.x - pixel[0];
    // A readback can leave the resolved (single-sample) framebuffer bound.
    renderer.setRenderTarget(target);
    drawList[drawIndex] = object;
    const descendants = object.children;
    try {
      object.children = [];
      renderer.render(scene, camera);
    } finally {
      object.children = descendants;
    }
  }

  function findDepth({ object, rayDepths }: RasterCandidate) {
    function covered(depth: number) {
      plane.set(towardsEye, depth).applyMatrix4(camera.matrixWorld);
      draw(object, 0);
      renderer.readRenderTargetPixels(target, firstColumn, row, 1, 1, rgba);
      return rgba[3] > 0;
    }
    let lower = camera.near, upper = camera.far;
    // The nearest ray intersection usually matches. Search the remaining
    // sorted hits by halves when masked or overlapping surfaces intervene.
    const hints = [...new Set(rayDepths())];
    // Coverage decides terrain ownership. Its continuous DEM query uses the
    // centre of the pixel, even where adjacent triangles cover other samples.
    if (object.userData.forgeTerrain && hints.length) return hints[0];
    let first = 0, end = hints.length, index = 0;
    while (first < end) {
      const depth = hints[index];
      // Raster interpolation and the analytic ray can differ within one
      // depth-buffer increment. Convert that increment to view-space units
      // and keep neighbouring faces' confirmation intervals disjoint.
      const increment = (1 / camera.near - 1 / camera.far) * depth ** 2 / (2 ** Math.min(depthBits, 24) - 1);
      const precision = Math.max(Math.max(1, depth) * 4 * 2 ** -23, increment / 2);
      const gap = Math.min(depth - (hints[index - 1] ?? -Infinity), (hints[index + 1] ?? Infinity) - depth);
      const error = Math.min(precision, gap / 2);
      if (depth < lower || (depth <= upper && !covered(depth + error))) {
        first = index + 1;
        if (depth >= lower) lower = depth + error;
      } else {
        end = index;
        if (depth <= upper) {
          if (!covered(depth - error)) return depth;
          upper = depth - error;
        }
      }
      index = Math.floor((first + end) / 2);
    }
    // A centre ray can miss all covered samples or the uploaded geometry.
    while (Math.fround(lower) < Math.fround(upper)) {
      const mid = Math.fround((lower + upper) / 2);
      if (mid <= lower || mid >= upper) break;
      if (covered(mid)) upper = mid;
      else lower = mid;
    }
    return upper;
  }

  try {
    // Keep the display scene's environment and renderer caches (including
    // transmission). Each object retains its original parent and submitted pose.
    const lineMaterials = candidates.flatMap(({object}) =>
      object instanceof Line ? object.material : []);
    matchDisplayLineWidths(lineMaterials, renderer.getPixelRatio(), restoreWidths);
    scene.children = drawList;
    scene.matrixWorldAutoUpdate = false;
    for (const light of lightChildren.keys()) light.children = [];
    scene.background = null;
    renderer.shadowMap.autoUpdate = false;
    renderer.setClearColor(0, 0);
    const covered = [];
    for (let start = 0; start < candidates.length; start += slots) {
      const count = Math.min(slots, candidates.length - start);
      for (let i = 0; i < count; i++) draw(candidates[start + i].object, i);
      renderer.readRenderTargetPixels(target, firstColumn, row, 2 * count - 1, 1, rgba);
      for (let i = 0; i < count; i++) {
        if (rgba[2 * i * 4 + 3] > 0) covered.push(start + i);
      }
    }
    renderer.clippingPlanes = depthPlanes;
    for (const i of covered) depths[i] = findDepth(candidates[i]);
    return depths;
  } finally {
    for (const restore of restoreWidths) restore();
    for (const [light, descendants] of lightChildren) light.children = descendants;
    scene.children = children;
    scene.matrixWorldAutoUpdate = updateWorld;
    scene.background = background;
    renderer.clippingPlanes = planes;
    renderer.shadowMap.autoUpdate = shadows;
    renderer.setRenderTarget(previousTarget, cubeFace, mipLevel);
    renderer.setClearColor(clearColor, clearAlpha);
    target.dispose();
  }
}

// Keep the instanced shader and the original world transform, but submit only
// the raycast instance. Another copy of this face may sample a different texel.
function isolateInstance(source: InstancedMesh, index: number) {
  const mesh = new InstancedMesh(source.geometry, source.material, 1);
  mesh.matrixWorldAutoUpdate = false;
  mesh.matrixWorld.copy(source.matrixWorld);
  mesh.layers.mask = source.layers.mask;
  mesh.frustumCulled = false;
  mesh.instanceMatrix.copyAt(0, source.instanceMatrix, index);
  const color = source.instanceColor;
  if (color) {
    const offset = Math.floor(index / color.meshPerAttribute) * color.itemSize;
    mesh.instanceColor = new InstancedBufferAttribute(color.array.subarray(offset, offset + color.itemSize), color.itemSize, color.normalized);
  }
  if (source.morphTexture) {
    const pose = new Mesh(source.geometry, source.material);
    source.getMorphAt(index, pose);
    mesh.setMorphAt(0, pose);
    mesh.morphTexture!.needsUpdate = true;
  }
  return mesh;
}

// Three multiplies linewidth by DPR on the default framebuffer and by one
// on render targets. Keep the same physical width through the replay.
function matchDisplayLineWidths(materials: Iterable<Material>, ratio: number, restore: (() => void)[]) {
  if (ratio === 1) return;
  for (const material of new Set(materials)) {
    if (!(material instanceof LineBasicMaterial)) continue;
    const width = material.linewidth;
    material.linewidth = width * ratio;
    restore.push(() => { material.linewidth = width; });
  }
}

/** Replay one candidate with the displayed shader, including vertex alpha,
 * texture filtering, blending and fragment discard. */
export function editorPrimitiveVisible(renderer: WebGLRenderer, depthBits: number, camera: PerspectiveCamera,
  size: ViewportDimensions, pixel: Pixel, source: Mesh | Line | Points, offset: number, instanceId?: number) {
  const target = pickTarget(renderer, depthBits, size, pixel);
  const previousTarget = renderer.getRenderTarget();
  const clearColor = renderer.getClearColor(new Color()), alpha = renderer.getClearAlpha();
  const instance = source instanceof InstancedMesh && instanceId !== undefined ? isolateInstance(source, instanceId) : null;
  const { geometry } = source;
  const { start, count } = geometry.drawRange;
  const index = geometry.index;
  // LINE_LOOP would also draw a return edge. Submit the directed pair as
  // LINES, using the last and first drawn vertices for the closing edge.
  const segment = source instanceof LineLoop ? new LineSegments(geometry, source.material) : null;
  let closingIndex: Uint32BufferAttribute | undefined;
  if (segment) {
    segment.morphTargetInfluences = source.morphTargetInfluences;
    segment.matrixWorldAutoUpdate = false;
    segment.matrixWorld.copy(source.matrixWorld);
    segment.layers.mask = source.layers.mask;
    segment.frustumCulled = false;
    const end = Math.min(index?.count ?? geometry.attributes.position.count, start + count);
    if (offset === end - 1) {
      closingIndex = new Uint32BufferAttribute([index?.getX(offset) ?? offset, index?.getX(start) ?? start], 1);
    }
  }
  const object = instance ?? segment ?? source;
  const children = object.children;
  const restore: (() => void)[] = [];
  try {
    if (source instanceof Line) matchDisplayLineWidths(Array.isArray(source.material) ? source.material : [source.material], renderer.getPixelRatio(), restore);
    object.children = [];
    if (closingIndex) geometry.setIndex(closingIndex);
    const vertexCount = source instanceof Mesh ? 3 : source instanceof Line ? 2 : 1;
    geometry.setDrawRange(closingIndex ? 0 : offset, vertexCount);
    renderer.setClearColor(0, 0);
    renderer.setRenderTarget(target);
    renderer.render(object, camera);
    const rgba = new Uint8Array(4);
    renderer.readRenderTargetPixels(target, target.scissor.x, target.scissor.y, 1, 1, rgba);
    return rgba[3] > 0;
  } finally {
    for (const reset of restore) reset();
    object.children = children;
    geometry.setDrawRange(start, count);
    if (closingIndex) {
      geometry.setIndex(index);
      closingIndex.dispose();
    }
    segment?.dispose();
    renderer.setRenderTarget(previousTarget);
    renderer.setClearColor(clearColor, alpha);
    instance?.dispose();
    target.dispose();
  }
}

/** Replay ambiguous fragments with the editor's own materials, draw order,
 * projection and multisample depth test. The alpha channel measures how much
 * of the clicked pixel each candidate actually covers after the depth test. */
export function editorDepthWinner(
  { renderer, scene, objects, depthBits }: { renderer: WebGLRenderer; scene: Scene; objects: ReadonlyMap<string, Group>; depthBits: number },
  camera: PerspectiveCamera, size: ViewportDimensions, pixel: Pixel, hits: StudioHit[], owned: readonly string[],
): StudioHit | null {
  const owners = new Map<Object3D, string>();
  const groups = new Set<Object3D>();
  const materials = new Set<Material>();
  const restore: (() => void)[] = [];
  const target = pickTarget(renderer, depthBits, size, pixel);
  const background = scene.background, clearColor = renderer.getClearColor(new Color()), alpha = renderer.getClearAlpha();
  const previousTarget = renderer.getRenderTarget(), shadows = renderer.shadowMap.autoUpdate;
  let marked: string;
  try {
    for (const id of new Set([...hits.map(hit => hit.id), ...owned])) {
      const group = objects.get(id);
      if (!group) continue;
      groups.add(group);
      group.traverseVisible(node => {
        const material: Material | Material[] | undefined = (node as Mesh).material;
        if (!material) return;
        owners.set(node, id);
        for (const item of Array.isArray(material) ? material : [material]) materials.add(item);
        if (owned.includes(id)) {
          // The WebGPU surface is drawn first as a depth proxy in the editor.
          const order = node.renderOrder;
          restore.push(() => { node.renderOrder = order; });
          node.renderOrder = -Infinity;
        }
      });
    }
    for (const node of scene.children) {
      if (!node.visible || node instanceof Light || groups.has(node)) continue;
      node.visible = false;
      restore.push(() => { node.visible = true; });
    }
    matchDisplayLineWidths(materials, renderer.getPixelRatio(), restore);
    // Three selects its OPAQUE shader from the authored blending mode.
    // Apply the ownership mask only to fixed-function blending, after
    // program selection, and only on our target (transmission has its own).
    let drawOwner: string | undefined;
    const state = renderer.state, setMaterial = state.setMaterial;
    restore.push(() => { state.setMaterial = setMaterial; });
    state.setMaterial = function (material, ...args) {
      if (renderer.getRenderTarget() === target && materials.has(material)) {
        const blendState: Material = Object.create(material);
        blendState.blending = CustomBlending;
        blendState.blendEquationAlpha = AddEquation;
        blendState.blendSrcAlpha = drawOwner === marked ? OneFactor : ZeroFactor;
        blendState.blendDstAlpha = material.transparent ? OneMinusSrcAlphaFactor : ZeroFactor;
        setMaterial.call(this, blendState, ...args);
      } else {
        setMaterial.call(this, material, ...args);
      }
    };
    for (const material of materials) {
      const { onBeforeRender } = material;
      restore.push(() => { material.onBeforeRender = onBeforeRender; });
      material.onBeforeRender = function (renderer, scene, camera, geometry, object, group) {
        onBeforeRender.call(this, renderer, scene, camera, geometry, object, group);
        drawOwner = owners.get(object);
      };
    }
    renderer.shadowMap.autoUpdate = false;
    scene.background = null;
    renderer.setClearColor(0, 0);
    let winner: StudioHit | null = null, coverage = 0, winnerDepth = 0;
    const position = new Vector3(), tolerance = depthTieWindow(depthBits);
    const rgba = new Uint8Array(4);
    for (const hit of hits) {
      const depth = position.fromArray(hit.worldPosition).project(camera).z * .5;
      if (winner && depth - winnerDepth > tolerance) break;
      if (owned.includes(hit.id) && !objects.get(hit.id)?.visible) {
        // The submitted WebGPU surface can precede its editor depth proxy.
        return winner ?? hit;
      }
      marked = hit.id;
      renderer.setRenderTarget(target);
      renderer.render(scene, camera);
      renderer.readRenderTargetPixels(target, target.scissor.x, target.scissor.y, 1, 1, rgba);
      if (rgba[3] > coverage) {
        if (!winner) winnerDepth = depth;
        winner = hit;
        coverage = rgba[3];
        if (coverage > 127) break;
      }
    }
    // A WebGPU surface can be visible before its editor depth proxy exists.
    return winner ?? hits.find(hit => owned.includes(hit.id)) ?? null;
  } finally {
    for (const reset of restore) reset();
    renderer.setRenderTarget(previousTarget);
    renderer.setClearColor(clearColor, alpha);
    renderer.shadowMap.autoUpdate = shadows;
    scene.background = background;
    target.dispose();
  }
}
