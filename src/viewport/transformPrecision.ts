import { Euler, MathUtils, Quaternion, Vector3 } from "three";
import type { Vec3 } from "../bridge/types";
import type { DisplayedPose } from "./transformRig";

// Match the shortest round-tripping decimal used in Studio project JSON.
export function wireCoordinate(value: number) {
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

export function nativeVector(value: Vector3, start: Vec3) {
  const native = (v: number, before: number) => Math.fround(v) === Math.fround(before) ? before : wireCoordinate(Math.fround(v));
  const result = { x: native(value.x,start.x), y: native(value.y,start.y), z: native(value.z,start.z) };
  return Object.values(result).every(Number.isFinite) ? result : start;
}

export function orientation(degrees: Vec3) {
  const { x, y, z } = degrees;
  return new Quaternion().setFromEuler(new Euler(x*MathUtils.DEG2RAD,y*MathUtils.DEG2RAD,z*MathUtils.DEG2RAD,"ZYX"));
}

export function sameOrientation(a: Quaternion, b: Quaternion) {
  // q and -q represent the same rotation. The vector part of the relative
  // quaternion also retains precision for very small meaningful rotations.
  const relative = a.clone().invert().multiply(b);
  return Math.hypot(relative.x,relative.y,relative.z) < 32*Number.EPSILON;
}

export function rotationDegrees(rotation: Quaternion, start: Vec3) {
  const e = new Euler().setFromQuaternion(rotation, "ZYX");
  return nativeVector(new Vector3(e.x,e.y,e.z).multiplyScalar(MathUtils.RAD2DEG),start);
}

export function moveLocal(start: Vec3, axis: DisplayedPose["axis"], distance: number, direction = new Vector3(1, 0, 0), normal?: Vector3): Vec3 {
  if (!axis || !Number.isFinite(distance) || !distance) return start;
  const before = new Vector3(start.x, start.y, start.z);
  const native = new Vector3().fromArray(before.toArray().map(Math.fround));
  const { linear } = axis;
  const local = direction.x === 1 && !direction.y && !direction.z ? axis.local
    : direction.clone().applyMatrix3(linear.clone().invert()).toArray();
  let best = start, error = Math.abs(distance);

  function consider(travel: number) {
    const next = new Vector3().fromArray(local.map((direction, i) =>
      Math.fround(native.getComponent(i) + direction * travel)));
    const wire = new Vector3().fromArray(next.toArray().map((value, i) =>
      value === native.getComponent(i) ? before.getComponent(i) : wireCoordinate(value)));
    // Both native storage and the serialization used by the draw must respect the axis or plane constraint.
    let miss = 0;
    for (const delta of [next.sub(native), wire.clone().sub(before)]) {
      delta.applyMatrix3(linear);
      const magnitude = delta.length();
      // A screen-plane gesture may start on the preceding grip's plane.
      // Preserve that depth offset and constrain only the error from rounding.
      const rounding = delta.clone().addScaledVector(direction, -distance);
      const residual = normal ? Math.abs(rounding.dot(normal)) : delta.clone().cross(direction).length();
      if (!Number.isFinite(magnitude) || residual > 1e-5 * Math.min(Math.abs(distance), magnitude)) return;
      miss = Math.max(miss, rounding.length());
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
