struct Frame {
  projection: mat4x4<f32>,
  size: vec2<f32>,
  spacing: vec2<f32>,
  datum: f32,
  exaggeration: f32,
  heightRange: vec2f,
}
@group(0) @binding(0) var<uniform> frame: Frame;
@group(0) @binding(1) var heights: texture_2d<f32>;

struct Vertex {
  @builtin(position) position: vec4<f32>,
  @location(0) color: vec4<f32>,
  @location(1) distance: f32,
}
@vertex fn surface(@location(0) p: vec3<f32>, @location(1) color: vec4<f32>) -> Vertex {
  return Vertex(frame.projection * vec4(p, 1.), color, 0.);
}
@fragment fn surfaceColor(v: Vertex) -> @location(0) vec4<f32> {
  return v.color;
}

// The same NW–NE–SW and NE–SE–SW triangles and perimeter skirt used
// by the pinned dense grid. Generate indices on the GPU from the admitted DEM.
@vertex fn terrain(@builtin(vertex_index) vertex: u32) -> @builtin(position) vec4<f32> {
  let size = textureDimensions(heights);
  let cells = size - vec2u(1);
  let cell = vertex / 6u;
  let corner = array<u32,6>(0,1,2,1,3,2)[vertex % 6u];
  let offset = vec2u(corner & 1u, corner >> 1u);
  var sample: vec2u;
  var skirt = 0.;
  let interior = cells.x * cells.y;
  if cell < interior {
    sample = vec2u(cell % cells.x, cell / cells.x) + offset;
  } else {
    let edge = cell - interior;
    if edge < 2u * cells.x {
      sample = vec2u(edge % cells.x + offset.x, select(0u, cells.y, edge >= cells.x));
    } else {
      let side = edge - 2u * cells.x;
      sample = vec2u(select(0u, cells.x, side >= cells.y), side % cells.y + offset.x);
    }
    skirt = f32(offset.y) * .24;
  }
  let xz = vec2f(sample) * frame.spacing - vec2f(cells) * frame.spacing * .5;
  let raw = textureLoad(heights, vec2i(sample), 0).r;
  let range = frame.heightRange.y - frame.heightRange.x;
  let unit = clamp((raw - frame.heightRange.x) / max(range, 1e-6), 0., 1.);
  let y = (frame.heightRange.x + unit * range - frame.datum) * frame.exaggeration;
  return frame.projection * vec4(xz.x, y - skirt, xz.y, 1.);
}

@vertex fn stroke(@builtin(vertex_index) i: u32, @location(0) start: vec3f,
                  @location(1) end: vec3f, @location(2) color: vec4f) -> Vertex {
  let a = frame.projection * vec4(start, 1.);
  let b = frame.projection * vec4(end, 1.);
  let delta = (b.xy / max(b.w, 1e-6) - a.xy / max(a.w, 1e-6)) * frame.size;
  let normal = select(vec2f(0.,1.), vec2f(-delta.y,delta.x) * inverseSqrt(max(dot(delta,delta),1e-10)), dot(delta,delta) >= 1e-10);
  let side = array<f32,6>(-1.,1.,1.,-1.,1.,-1.)[i];
  var clip = select(a, b, i == 2u || i >= 4u);
  // Pin d6459a26 expands each 1px line by another pixel for analytic AA,
  // biases depth by style.depthBias * 1e-5, then quantizes clip coordinates.
  let biased = vec4(clip.xy + 3. * side * normal / frame.size * clip.w, clip.z - 1e-7 * clip.w, clip.w);
  clip = round(biased * 524288.) / 524288.;
  if biased.w > 0. && biased.z >= 0. && biased.z <= biased.w {
    clip.z = floor(biased.z * 524288.) / 524288.;
    clip.w = ceil(biased.w * 524288.) / 524288.;
  }
  return Vertex(clip, color, 3. * side);
}
@fragment fn strokeColor(v: Vertex) -> @location(0) vec4f {
  let edge = abs(v.distance) - 1.;
  let aa = max(fwidth(edge), .0001);
  let alpha = v.color.a * (1. - smoothstep(-aa, aa, edge));
  if alpha <= .01 { discard; }
  return vec4(v.color.rgb * alpha, alpha);
}
@vertex fn cover(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  return vec4(array<vec2f,3>(vec2f(-1.,-1.),vec2f(3.,-1.),vec2f(-1.,3.))[i], 0., 1.);
}
@group(0) @binding(2) var overlay: texture_2d<f32>;
@fragment fn composite(@builtin(position) p: vec4f) -> @location(0) vec4f {
  return textureLoad(overlay, vec2i(p.xy), 0);
}
