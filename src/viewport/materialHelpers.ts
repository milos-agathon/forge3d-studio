/// <reference types="@webgpu/types" />
import type { Camera, TerrainDataset } from "@forge3d/web";
import type { buildObjects, helperVectors } from "./viewportObjects";
import shader from "./materialHelpers.wgsl?raw";

type Scene = ReturnType<typeof buildObjects>;
type Helpers = ReturnType<typeof helperVectors>;
const premultiplied: GPUBlendState = {
  color: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
  alpha: { srcFactor: "one", dstFactor: "one-minus-src-alpha" },
};
const layerFormat: GPUTextureFormat = "rgba8unorm";
const depthFormat: GPUTextureFormat = "depth24plus";

/** W11 tone-maps the whole capture, including W12 vectors. Paint Material
 * helpers on the same WebGPU device after W11, using the submitted faces and
 * admitted terrain for depth. The layer also supplies diagnostic readbacks. */
export class MaterialHelpers {
  private context: GPUCanvasContext;
  private device: GPUDevice;
  private uniform: GPUBuffer;
  private terrainPipeline: GPURenderPipeline;
  private surfacePipeline: GPURenderPipeline;
  private strokePipeline: GPURenderPipeline;
  private compositePipeline: GPURenderPipeline;
  private surfaceGroup: GPUBindGroup;
  private strokeGroup: GPUBindGroup;
  private terrainGroup?: GPUBindGroup;
  private compositeGroup?: GPUBindGroup;
  private layer?: GPUTexture;
  private depth?: GPUTexture;
  private heights?: GPUTexture;
  private grid?: TerrainDataset;
  private batches?: Scene["batches"];
  private vertices?: GPUBuffer;
  private indices?: GPUBuffer;
  private indexCount = 0;
  private helpers?: Helpers;
  private strokes?: GPUBuffer;
  private strokeDirection?: number[];

  constructor(canvas: HTMLCanvasElement) {
    this.context = canvas.getContext("webgpu")!;
    const config = this.context.getConfiguration()!;
    const device = this.device = config.device;
    const module = device.createShaderModule({ label: "Studio material helpers", code: shader });
    this.uniform = device.createBuffer({ size: 96, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    const depthStencil: GPUDepthStencilState = { format: depthFormat, depthWriteEnabled: true, depthCompare: "less-equal" };
    this.terrainPipeline = device.createRenderPipeline({ label: "Studio helper terrain depth", layout: "auto",
      vertex: { module, entryPoint: "terrain" }, depthStencil });
    this.surfacePipeline = device.createRenderPipeline({ label: "Studio helper surfaces", layout: "auto",
      vertex: { module, entryPoint: "surface", buffers: [{ arrayStride: 28, attributes: [
        { shaderLocation: 0, offset: 0, format: "float32x3" }, { shaderLocation: 1, offset: 12, format: "float32x4" },
      ] }] }, fragment: { module, entryPoint: "surfaceColor", targets: [{ format: layerFormat }] }, depthStencil });
    this.strokePipeline = device.createRenderPipeline({ label: "Studio helper strokes", layout: "auto",
      vertex: { module, entryPoint: "stroke", buffers: [{ arrayStride: 40, stepMode: "instance", attributes: [
        { shaderLocation: 0, offset: 0, format: "float32x3" }, { shaderLocation: 1, offset: 12, format: "float32x3" },
        { shaderLocation: 2, offset: 24, format: "float32x4" },
      ] }] }, fragment: { module, entryPoint: "strokeColor", targets: [{ format: layerFormat, blend: premultiplied }] },
      depthStencil });
    this.compositePipeline = device.createRenderPipeline({ label: "Studio helper composite", layout: "auto",
      vertex: { module, entryPoint: "cover" }, fragment: { module, entryPoint: "composite",
        targets: [{ format: config.format, blend: premultiplied }] } });
    this.surfaceGroup = this.bind(this.surfacePipeline);
    this.strokeGroup = this.bind(this.strokePipeline);
  }

  private bind(pipeline: GPURenderPipeline, extra: GPUBindGroupEntry[] = []) {
    return this.device.createBindGroup({ layout: pipeline.getBindGroupLayout(0),
      entries: [{ binding: 0, resource: { buffer: this.uniform } }, ...extra] });
  }

  private upload(data: Float32Array<ArrayBuffer> | Uint32Array<ArrayBuffer>, usage: GPUBufferUsageFlags) {
    if (!data.length) return;
    const buffer = this.device.createBuffer({ size: data.byteLength, usage: usage | GPUBufferUsage.COPY_DST });
    this.device.queue.writeBuffer(buffer, 0, data);
    return buffer;
  }

  private setScene(scene: Scene) {
    if (this.batches === scene.batches) return;
    this.batches = scene.batches;
    const drawn = scene.drawn;
    const positions = new Float32Array(7 * drawn.reduce((n,r) => n + r.surface!.geometry.attributes.position.count, 0));
    const indices = new Uint32Array(drawn.reduce((n,r) => n + r.surface!.geometry.index!.count, 0));
    let vertex = 0, index = 0;
    for (const record of drawn) {
      const {geometry, kind} = record.surface!;
      const position = geometry.attributes.position;
      const color = kind === "light" ? [...record.helperColor,1] : [0,0,0,0];
      for (const i of geometry.index!.array) indices[index++] = vertex + i;
      for (let i=0; i<position.count; i++, vertex++) {
        positions[7*vertex] = position.getX(i);
        positions[7*vertex+1] = position.getY(i);
        positions[7*vertex+2] = position.getZ(i);
        positions.set(color, 7*vertex+3);
      }
    }
    this.vertices?.destroy();
    this.indices?.destroy();
    this.vertices = this.upload(positions, GPUBufferUsage.VERTEX);
    this.indices = this.upload(indices, GPUBufferUsage.INDEX);
    this.indexCount = indices.length;
  }

  private setTerrain(grid?: TerrainDataset) {
    if (this.grid === grid) return;
    this.grid = grid;
    this.heights?.destroy();
    this.terrainGroup = undefined;
    if (!grid) return;
    const size = { width: grid.width, height: grid.height };
    this.heights = this.device.createTexture({ size, format: "r32float",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST });
    this.device.queue.writeTexture({ texture: this.heights }, new Float32Array(grid.heights),
      { bytesPerRow: 4 * grid.width }, size);
    this.terrainGroup = this.bind(this.terrainPipeline, [{ binding: 1, resource: this.heights.createView() }]);
  }

  private setStrokes(helpers: Helpers, camera: Camera) {
    const forward = camera.forward;
    if (this.helpers === helpers && forward.every((v,i)=>v===this.strokeDirection?.[i])) return;
    this.helpers = helpers;
    this.strokeDirection = [...forward];
    // Field renders opaque lines first, then sorts its translucent Line
    // objects from back to front using each segment's bounding-sphere centre.
    const depth = (f: Helpers["features"][number]) => {
      const [a,b] = f.positions;
      return forward[0]*(a[0]+b[0])+forward[1]*(a[1]+b[1])+forward[2]*(a[2]+b[2]);
    };
    const opaque = helpers.features.filter(f => f.style!.opacity === 1);
    const translucent = helpers.features.filter(f => f.style!.opacity !== 1).sort((a,b) => depth(b)-depth(a));
    const data = new Float32Array(helpers.features.length * 10);
    for (const [i,f] of [...opaque,...translucent].entries()) {
      data.set(f.positions[0], i*10);
      data.set(f.positions[1], i*10+3);
      data.set(f.style!.color!, i*10+6);
      data[i*10+9] = f.style!.opacity!;
    }
    this.strokes?.destroy();
    this.strokes = this.upload(data, GPUBufferUsage.VERTEX);
  }

  draw(camera: Camera, width: number, height: number, scene: Scene, helpers: Helpers,
    ground?: { dataset: TerrainDataset; heightRange: [number,number] }) {
    const grid = ground?.dataset;
    this.setTerrain(grid);
    this.setScene(scene);
    this.setStrokes(helpers,camera);
    if (this.layer?.width !== width || this.layer.height !== height) {
      this.layer?.destroy();
      this.depth?.destroy();
      const size = { width, height };
      this.layer = this.device.createTexture({ size, format: layerFormat,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC });
      this.depth = this.device.createTexture({ size, format: depthFormat, usage: GPUTextureUsage.RENDER_ATTACHMENT });
      this.compositeGroup = this.device.createBindGroup({ layout: this.compositePipeline.getBindGroupLayout(0),
        entries: [{ binding: 2, resource: this.layer.createView() }] });
    }
    const params = new Float32Array(24);
    params.set(camera.viewProjectionMatrix(width/height));
    params.set([width,height,...(grid?.spacing ?? [1,1]),grid?.domain[0] ?? 0,grid?.exaggeration ?? 1,
      ...(ground?.heightRange ?? [0,1])],16);
    this.device.queue.writeBuffer(this.uniform,0,params);
    const encoder = this.device.createCommandEncoder();
    const depthView = this.depth!.createView();
    if (grid) {
      const terrain = encoder.beginRenderPass({ colorAttachments: [], depthStencilAttachment: {
        view: depthView, depthLoadOp: "clear", depthClearValue: 1, depthStoreOp: "store" } });
      terrain.setPipeline(this.terrainPipeline);
      terrain.setBindGroup(0,this.terrainGroup!);
      terrain.draw(6*((grid.width-1)*(grid.height-1) + 2*(grid.width+grid.height-2)));
      terrain.end();
    }
    const pass = encoder.beginRenderPass({ colorAttachments: [{ view: this.layer.createView(),
      loadOp: "clear", clearValue: [0,0,0,0], storeOp: "store" }], depthStencilAttachment: {
      view: depthView, depthLoadOp: grid ? "load" : "clear", depthClearValue: 1, depthStoreOp: "discard" } });
    if (this.indices) {
      pass.setPipeline(this.surfacePipeline);
      pass.setBindGroup(0,this.surfaceGroup);
      pass.setVertexBuffer(0,this.vertices!);
      pass.setIndexBuffer(this.indices,"uint32");
      pass.drawIndexed(this.indexCount);
    }
    if (this.strokes) {
      pass.setVertexBuffer(0,this.strokes);
      pass.setPipeline(this.strokePipeline);
      pass.setBindGroup(0,this.strokeGroup);
      pass.draw(6,helpers.features.length);
    }
    pass.end();
    const output = encoder.beginRenderPass({ colorAttachments: [{ view: this.context.getCurrentTexture().createView(),
      loadOp: "load", storeOp: "store" }] });
    output.setPipeline(this.compositePipeline);
    output.setBindGroup(0,this.compositeGroup!);
    output.draw(3);
    output.end();
    this.device.queue.submit([encoder.finish()]);
  }

  async compositeReadback(base: Uint8Array) {
    const layer = this.layer!;
    const {width,height} = layer;
    const stride = Math.ceil(width*4/256)*256;
    const buffer = this.device.createBuffer({ size: stride*height, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    try {
      const encoder = this.device.createCommandEncoder();
      encoder.copyTextureToBuffer({texture:layer},{buffer,bytesPerRow:stride},{width,height});
      this.device.queue.submit([encoder.finish()]);
      await buffer.mapAsync(GPUMapMode.READ);
      const overlay = new Uint8Array(buffer.getMappedRange());
      for (let y=0; y<height; y++) for (let x=0; x<width; x++) {
        const s = y*stride+4*x, d = 4*(y*width+x), a = overlay[s+3];
        if (a) for (let c=0; c<4; c++) base[d+c] = Math.min(255, overlay[s+c] + Math.round(base[d+c]*(1-a/255)));
      }
      return base;
    } finally {
      buffer.destroy();
    }
  }

  dispose() {
    for (const resource of [this.uniform,this.layer,this.depth,this.heights,this.vertices,this.indices,this.strokes]) resource?.destroy();
  }
}
