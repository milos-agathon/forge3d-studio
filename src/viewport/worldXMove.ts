import { Vector3 } from "three";
import type { worldXAxis } from "./forge3dWebMapping";
import type { Camera } from "@forge3d/web";
import type { Transform, Vec3 } from "../bridge/types";
import type { Triple } from "./forge3dWebMapping";

interface DisplayedCube {
  camera: Camera;
  center: Triple;
  axis: ReturnType<typeof worldXAxis>;
  scale: number;
  width: number;
  height: number;
}

interface Target {
  generation: number;
  sequence: number;
  id: string;
  transform: Transform;
}

interface Edit {
  target: Target;
  previous?: Pending;
  translation: Vec3;
}

interface Pending extends Edit {
  acknowledgement: Promise<number | null>;
  sequence?: number | null;
}

interface Drag extends Edit {
  start: Vec3;
  pointer: number;
  cube: DisplayedCube;
  rect: DOMRect;
  startX: number;
}

// Intersect the frozen pointer ray with the plane containing world X that
// faces the eye, as in Field Instrument's world-axis TransformControls.
function planeX(cube: DisplayedCube, rect: DOMRect, event: PointerEvent) {
  const { camera, center } = cube;
  const { origin, direction } = camera.screenRay(
    (event.clientX - rect.left) * cube.width / rect.width,
    (event.clientY - rect.top) * cube.height / rect.height, cube);
  const ny = camera.position[1] - center[1], nz = camera.position[2] - center[2];
  const denominator = ny * direction[1] + nz * direction[2];
  if (Math.abs(denominator) <= 1e-8 * Math.hypot(ny, nz)) return;
  const t = (ny * (center[1] - origin[1]) + nz * (center[2] - origin[2])) / denominator;
  if (t >= 0) return origin[0] + t * direction[0];
}

function projectedHandle(cube: DisplayedCube, rect: DOMRect) {
  const { camera, center } = cube;
  const origin = camera.worldToScreen(center, cube);
  if (!origin || origin.depth < 0 || origin.depth > 1 || !rect.height) return;
  const distance = Math.hypot(...camera.position.map((v, i) => v - center[i]));
  const length = 2 * distance * Math.tan(camera.fovYDegrees * Math.PI / 360) * 76 / rect.height;
  const end = camera.worldToScreen([center[0] + length, center[1], center[2]], cube);
  if (!end) return;
  const sx = rect.width / cube.width, sy = rect.height / cube.height;
  const x = origin.x * sx, y = origin.y * sy;
  const dx = (end.x - origin.x) * sx, dy = (end.y - origin.y) * sy;
  // Clip the shaft against the canvas inset by the grip radius. This also
  // handles a cube centre outside the viewport with a visible length of shaft.
  let first = 0, last = 1;
  for (const [p, delta, extent] of [[x, dx, rect.width], [y, dy, rect.height]]) {
    if (extent < 20) return;
    if (delta === 0) {
      if (p < 10 || p > extent - 10) return;
    } else {
      const a = (10 - p) / delta, b = (extent - 10 - p) / delta;
      first = Math.max(first, Math.min(a,b));
      last = Math.min(last, Math.max(a,b));
    }
  }
  const width = (last - first) * Math.hypot(dx, dy);
  if (width < 2) return; // End-on or fully clipped: no resolvable screen axis.
  return { x: x + first * dx, y: y + first * dy, angle: Math.atan2(dy, dx), width };
}

// Match the shortest round-tripping decimal used in Studio project JSON.
function wireCoordinate(value: number) {
  if (!value || !Number.isFinite(value)) return value;
  const magnitude = Math.abs(value);
  const exponent = Math.floor(Math.log10(magnitude));
  for (let digits = 1; digits <= 9; digits++) {
    const power = exponent - digits + 1;
    const lower = Math.floor(magnitude / 10 ** power);
    const a = Number(`${lower}e${power}`), b = Number(`${lower + 1}e${power}`);
    const fitsA = Math.fround(a) === magnitude, fitsB = Math.fround(b) === magnitude;
    if (!fitsA && !fitsB) continue;
    // Rust breaks a decimal midpoint tie toward an even last digit.
    const da = magnitude - a, db = b - magnitude;
    const nearest = fitsA && (!fitsB || da < db || (da === db && lower % 2 === 0)) ? a : b;
    return Math.sign(value) * nearest;
  }
  return value;
}

function moveLocal(start: Vec3, axis: DisplayedCube["axis"], distance: number): Vec3 {
  if (!axis || !Number.isFinite(distance) || !distance) return start;
  const before = new Vector3(start.x, start.y, start.z);
  const native = new Vector3().fromArray(before.toArray().map(Math.fround));
  const { local, linear } = axis;
  let best = start, error = Math.abs(distance);

  function consider(travel: number) {
    const next = new Vector3().fromArray(local.map((direction, i) =>
      Math.fround(native.getComponent(i) + direction * travel)));
    const wire = new Vector3().fromArray(next.toArray().map((value, i) =>
      value === native.getComponent(i) ? before.getComponent(i) : wireCoordinate(value)));
    // Both native storage and the serialization used by the draw must stay on X.
    let miss = 0;
    for (const delta of [next.sub(native), wire.clone().sub(before)]) {
      delta.applyMatrix3(linear);
      if (!Number.isFinite(delta.length()) ||
          Math.hypot(delta.y, delta.z) > 1e-5 * Math.min(Math.abs(distance), Math.abs(delta.x))) return;
      miss = Math.max(miss, Math.abs(delta.x - distance));
    }
    if (miss < error) {
      best = { x: wire.x, y: wire.y, z: wire.z };
      error = miss;
    }
  }

  consider(distance);
  if (best !== start) return best;
  // Snap the distance along the line, then derive all local coordinates from
  // that distance. A large local coordinate may have much coarser steps than
  // its siblings. Coarsen the displacement relative to the starting float so
  // consecutive edits can preserve its existing decimal rounding offset.
  for (const [i, direction] of local.entries()) {
    if (!direction) continue;
    const base = native.getComponent(i);
    const ideal = base + distance * direction;
    const ulp = 2 ** Math.max(-149, Math.floor(Math.log2(Math.abs(ideal))) - 23);
    if (!Number.isFinite(ulp)) continue;
    const visited = new Set<number>();
    for (let bits = 0; bits <= 23; bits++) {
      const step = ulp * 2 ** bits;
      const lower = Math.floor(distance * direction / step) * step;
      // Inspect adjacent floats on the finest grid before trying its coarser multiples.
      const radius = bits === 0 ? 32 : 1;
      for (let ring = 0; ring <= radius; ring++) {
        let inRange = false;
        for (const offset of [-ring, ring + 1]) {
          const anchor = Math.fround(base + lower + offset * step);
          const travel = (anchor - base) / direction;
          if (!(Math.abs(travel - distance) < error)) continue;
          inRange = true;
          if (visited.has(anchor)) continue;
          visited.add(anchor);
          consider(travel);
          const displayed = (wireCoordinate(anchor) - before.getComponent(i)) / direction;
          consider((travel + displayed) / 2);
        }
        if (!inRange) break;
      }
    }
  }
  return best;
}

function same(a: Vec3, b: Vec3) {
  return a.x === b.x && a.y === b.y && a.z === b.z;
}

function acknowledgedPose(pending: Pending, live: Target) {
  return pending.sequence === live.sequence ||
    (pending.sequence === undefined && same(live.transform.translation, pending.translation) &&
      same(live.transform.rotationDeg, pending.target.transform.rotationDeg) &&
      same(live.transform.scale, pending.target.transform.scale));
}

export class WorldXMove {
  private drag?: Drag;
  private settling?: Pending;

  constructor(private grip: HTMLButtonElement, private canvas: HTMLCanvasElement,
    private target: () => Target | undefined,
    private displayed: (id: string, allowPreviousFrame: boolean) => DisplayedCube | undefined,
    private invalidate: () => void,
    private commit: (id: string, transform: Transform, sequence: number | Promise<number | null>) => Promise<number | null>) {}

  get active() { return !!this.drag; }
  get preview() {
    const edit = this.drag ?? this.settling;
    if (!edit || !this.current(edit)) return;
    const { x, y, z } = edit.translation;
    return { id: edit.target.id, translation: [x,y,z] as Triple };
  }

  private current(edit: Edit, live = this.target()) {
    const { target } = edit;
    if (live?.id !== target.id || live.generation !== target.generation) return false;
    // A following gesture can span its predecessors' acknowledgements. Only
    // those poses belong to its starting state. Native CAS still checks the
    // predecessor's actual receipt before a dependent command can apply.
    for (let prior = edit.previous; prior; prior = prior.previous) {
      if (prior.sequence === null) return false;
      if (acknowledgedPose(prior, live)) return true;
    }
    return live.sequence === target.sequence;
  }

  private startingEdit(target: Target): Edit {
    const pending = this.settling;
    const previous = pending && this.current(pending, target) ? pending : undefined;
    return { target, previous, translation: previous?.translation ?? target.transform.translation };
  }

  private displayedFor(target: Target) {
    const pending = this.settling;
    // React may publish our command before the next draw. The grip still
    // belongs to the submitted camera and surface during that interval.
    const ownEdit = pending && pending.target.id === target.id && pending.target.generation === target.generation &&
      (acknowledgedPose(pending, target) || this.current(pending, target));
    return this.displayed(target.id, !!ownEdit);
  }

  refresh(beforeDraw = false) {
    const target = this.target();
    const pending = this.settling;
    if (pending && (!target || target.id !== pending.target.id || target.generation !== pending.target.generation ||
        (!beforeDraw && pending.sequence != null && target.sequence >= pending.sequence))) this.settling = undefined;
    const cube = target && this.displayedFor(target);
    const line = cube?.axis && projectedHandle(cube, this.canvas.getBoundingClientRect());
    if (this.drag && !this.current(this.drag, target)) this.cancel();
    // React can publish the acknowledged keyboard edit one frame before the
    // new submission. Preserve button focus while the old canvas is visible.
    if (beforeDraw && target && !cube && !this.canvas.hidden) return;
    if (this.drag && !cube?.axis) this.cancel();
    const handle = this.grip.parentElement!;
    handle.hidden = !line && !this.drag;
    handle.style.visibility = !line && this.drag ? "hidden" : "";
    if (line) {
      handle.style.transform = `translate(${line.x}px, ${line.y}px) rotate(${line.angle}rad)`;
      handle.style.width = line.width + "px";
    }
  }

  begin(event: PointerEvent) {
    if (!(event.target instanceof Node) || !this.grip.parentElement!.contains(event.target) ||
        event.button !== 0 || !event.isPrimary || this.drag) return false;
    const target = this.target();
    const cube = target && this.displayedFor(target);
    if (!target || !cube?.axis) return false;
    const rect = this.canvas.getBoundingClientRect();
    const startX = planeX(cube, rect, event);
    if (startX === undefined) return false;
    this.grip.setPointerCapture(event.pointerId);
    const edit = this.startingEdit(target);
    this.drag = { ...edit, start: edit.translation, pointer: event.pointerId, cube, rect, startX };
    return true;
  }

  move(event: PointerEvent) {
    const drag = this.drag;
    if (!drag || drag.pointer !== event.pointerId) return;
    if (!this.grip.hasPointerCapture(drag.pointer)) { this.cancel(); return; }
    const hit = planeX(drag.cube, drag.rect, event);
    if (hit === undefined) return;
    const translation = moveLocal(drag.start, drag.cube.axis, (hit - drag.startX) * drag.cube.scale);
    if (Object.values(translation).every(Number.isFinite) && !same(translation, drag.translation)) {
      drag.translation = translation;
      this.invalidate();
    }
  }

  finish(event: PointerEvent) {
    const drag = this.drag;
    if (!drag || drag.pointer !== event.pointerId) return;
    const captured = this.grip.hasPointerCapture(drag.pointer);
    this.move(event);
    this.cancel();
    if (captured && !this.canvas.hidden && !same(drag.translation, drag.start)) this.apply(drag);
  }

  nudge(distance: number) {
    const target = this.target();
    const cube = target && this.displayedFor(target);
    if (!target || !cube?.axis || this.active || this.grip.parentElement!.hidden) return;
    const edit = this.startingEdit(target);
    const translation = moveLocal(edit.translation, cube.axis, distance);
    if (!same(edit.translation, translation)) this.apply({ ...edit, translation });
  }

  private apply(edit: Edit) {
    const { target, translation, previous } = edit;
    if (!this.current(edit)) return;
    const acknowledgement = this.commit(target.id, { ...target.transform, translation }, previous?.acknowledgement ?? target.sequence);
    const pending: Pending = { target, translation, previous, acknowledgement };
    this.settling = pending;
    this.invalidate();
    void acknowledgement.then(sequence => {
      pending.sequence = sequence;
      if (sequence === null) {
        if (this.settling === pending) this.settling = undefined;
        if (this.drag && !this.current(this.drag)) this.cancel();
      }
      this.invalidate();
    });
  }

  interrupt() {
    this.settling = undefined;
    this.cancel();
  }

  cancel(event?: PointerEvent) {
    const drag = this.drag;
    if (!drag || (event && event.pointerId !== drag.pointer)) return;
    this.drag = undefined;
    if (this.grip.hasPointerCapture(drag.pointer)) this.grip.releasePointerCapture(drag.pointer);
    this.invalidate();
  }
}
