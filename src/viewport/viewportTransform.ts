import { Quaternion, Vector3 } from "three";
import { SVGRenderer } from "three/addons/renderers/SVGRenderer.js";
import type { Transform, ToolSpace, Vec3 } from "../bridge/types";
import { TransformRig, type TransformTool, type DisplayedPose } from "./transformRig";
import { moveLocal, nativeVector, orientation, rotationDegrees, sameOrientation } from "./transformPrecision";
import type { Triple } from "./forge3dWebMapping";

import { renderTransformGuides } from "./transformGuides";
import { KeyboardGrips, keyboardStep } from "./transformKeyboard";
import type { TransformControlsGizmo } from "three/addons/controls/TransformControls.js";

interface Target {
  generation: number;
  sequence: number;
  id: string;
  transform: Transform;
  tool: TransformTool;
  space: ToolSpace;
}
interface Edit {
  target: Target;
  previous?: Pending;
  transform: Transform;
}
interface Pending extends Edit {
  acknowledgement: Promise<number | null>;
  sequence?: number | null;
}
interface Drag extends Edit {
  pointer: number;
  cube: DisplayedPose;
  rect: DOMRect;
  start: Transform;
  down: [number, number];
  orientation: Quaternion;
  startRotation: Quaternion;
  rig: TransformRig;
}

// Position the keyboard-accessible world X button on the visible shaft.
function projectedHandle(cube: DisplayedPose, rect: DOMRect) {
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

function same(a: Vec3, b: Vec3) {
  return a.x === b.x && a.y === b.y && a.z === b.z;
}

function samePose(a: Transform, b: Transform) {
  return same(a.translation,b.translation) && same(a.scale,b.scale) &&
    (same(a.rotationDeg,b.rotationDeg) || sameOrientation(orientation(a.rotationDeg),orientation(b.rotationDeg)));
}

function acknowledgedPose(pending: Pending, live: Target) {
  return pending.sequence === live.sequence ||
    (pending.sequence === undefined && same(live.transform.translation,pending.transform.translation) &&
      same(live.transform.rotationDeg,pending.transform.rotationDeg) && same(live.transform.scale,pending.transform.scale));
}

export class ViewportTransform {
  private drag?: Drag;
  private settling?: Pending;
  private display?: TransformRig;
  private gesture?: TransformRig;
  private hoverPose?: DisplayedPose;
  private presentedPlane?: { target: Target; rotation?: Quaternion };
  private renderer = new SVGRenderer();
  private keyboard: KeyboardGrips;

  constructor(private grip: HTMLButtonElement, private canvas: HTMLCanvasElement,
    private target: () => Target | undefined,
    private displayed: (id: string, allowPreviousFrame: boolean) => DisplayedPose | undefined,
    private invalidate: () => void,
    private commit: (id: string, transform: Transform, sequence: number | Promise<number | null>) => Promise<number | null>) {
    const overlay = this.renderer.domElement;
    overlay.classList.add("transform-handles");
    overlay.setAttribute("aria-hidden", "true");
    this.renderer.setPrecision(2);
    this.grip.parentElement!.before(overlay);
    this.keyboard = new KeyboardGrips(this.grip.parentElement!, (axis, vertical, amount) => {
      const target = this.target();
      const cube = target && this.displayedFor(target);
      if (!target || !cube?.axis || !this.display || this.active || this.keyboard.element.hidden) return;
      const edit = this.startingEdit(target);
      const transform = keyboardStep(cube,this.display,target.tool,target.space,axis,vertical,amount,edit.transform);
      if (!samePose(transform,edit.transform)) this.apply({ ...edit, transform });
    });
  }

  get diagnosticRig() { return this.display; }
  get active() { return !!this.drag; }
  get preview() {
    const edit = this.drag ?? this.settling;
    if (!edit || !this.current(edit)) return;
    const triple = (v: Vec3): Triple => [v.x,v.y,v.z];
    const { translation, rotationDeg, scale } = edit.transform;
    return { id: edit.target.id, translation: triple(translation), rotationDeg: triple(rotationDeg), scale: triple(scale) };
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
    return { target, previous, transform: previous?.transform ?? target.transform };
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
    const pivot = cube?.camera.worldToScreen(cube.center, cube);
    const visible = cube?.axis && pivot && pivot.depth >= 0 && pivot.depth <= 1;
    if (this.drag && (!this.current(this.drag, target) || target?.tool !== this.drag.target.tool ||
        target.space !== this.drag.target.space)) this.cancel();
    if (beforeDraw && target && !cube && !this.canvas.hidden) return;
    if (this.drag && !visible) this.cancel();
    const rect = this.canvas.getBoundingClientRect();
    const offsetX = (this.canvas.clientWidth - rect.width) / 2;
    const offsetY = (this.canvas.clientHeight - rect.height) / 2;
    const line = target?.tool === "move" && target.space === "world" && cube?.axis && projectedHandle(cube, rect);
    const handle = this.grip.parentElement!;
    handle.hidden = !line && !this.drag;
    handle.style.visibility = !line ? "hidden" : "";
    if (line) {
      handle.style.transform = `translate(${line.x + offsetX}px, ${line.y + offsetY}px) rotate(${line.angle}rad)`;
      handle.style.width = line.width + "px";
    }
    const overlay = this.renderer.domElement;
    this.hoverPose = visible ? cube : undefined;
    overlay.removeAttribute("data-hover");
    overlay.style.display = visible ? "" : "none";
    if (!visible || !cube || !target) {
      if (!target) this.presentedPlane = undefined;
      this.keyboard.element.hidden = true;
      return;
    }
    this.display ??= new TransformRig();
    const controls = this.display.controls;
    const previous = this.presentedPlane?.target;
    if (previous?.id !== target.id || previous.generation !== target.generation) {
      this.presentedPlane = { target };
      controls.axis = null;
    }
    // Hover can paint an SVG highlight between scene submissions. Only an
    // actual frame changes the plane used by the next pointer-down.
    controls.axis = this.drag?.rig.controls.axis ?? (controls.dragging ? null : controls.axis);
    this.display.configure(cube, target.tool, target.space);
    controls.dragging = !!this.drag;
    if (this.drag) {
      // The overlay uses the current submitted pivot as its floating origin.
      controls.worldPositionStart.fromArray(this.drag.cube.center).sub(new Vector3(...cube.center)).multiplyScalar(cube.scale);
      controls.worldQuaternionStart.copy(this.drag.rig.controls.worldQuaternionStart);
      controls.rotationAxis.copy(this.drag.rig.controls.rotationAxis);
      // Field submits the translated object between pointer events. The next
      // ray sees its current plane, while pointStart and the grab pose stay fixed.
      if (!beforeDraw && target.tool === "move") {
        const { rig, transform, start } = this.drag;
        rig.object.position.copy(transform.translation).sub(start.translation);
        rig.scene.updateMatrixWorld(true);
      }
    }
    overlay.style.left = `${offsetX}px`;
    overlay.style.top = `${offsetY}px`;
    this.renderer.setSize(rect.width, rect.height);
    this.paint(this.display);
    // Field redraws its controls on toolbar changes even when the underlying
    // scene is stationary. In particular, entering Rotate resets the grab
    // plane to the camera. A hover-only highlight must still leave it alone.
    if (!beforeDraw || previous?.tool !== target.tool || previous.space !== target.space) {
      const axis = controls.axis;
      let rotation = this.presentedPlane?.rotation;
      if (target.tool === "rotate" || axis === "XYZ" || axis === "E") rotation = undefined;
      else if (axis && ["X","Y","Z","XY","XZ","YZ"].includes(axis)) {
        rotation = this.display.plane.quaternion.clone();
      }
      this.presentedPlane = { target, rotation };
    }
    const gizmo = controls.getHelper().getObjectByProperty("isTransformControlsGizmo",true) as TransformControlsGizmo;
    const axes = gizmo.gizmo[controls.mode].children.filter(mesh => mesh.visible &&
      !(line && mesh.name === "X")).map(mesh => mesh.name);
    this.keyboard.show(target.tool,target.space,[...new Set(axes)]);
  }

  private paint(rig: TransformRig) {
    renderTransformGuides(this.renderer, rig);
    this.renderer.domElement.style.backgroundColor = "transparent";
  }

  hover(event?: PointerEvent) {
    const rig = this.display;
    if (!rig || !this.hoverPose || this.active) return;
    const previous = rig.controls.axis;
    if (event) {
      rig.setRay(this.hoverPose, this.canvas.getBoundingClientRect(), event);
      rig.controls.pointerHover(null);
    } else {
      rig.controls.axis = null;
    }
    if (rig.controls.axis === previous) return;
    this.renderer.domElement.toggleAttribute("data-hover", !!rig.controls.axis);
    this.paint(rig);
  }

  begin(event: PointerEvent) {
    if (event.button !== 0 || !event.isPrimary || this.drag) return false;
    const target = this.target();
    const cube = target && this.displayedFor(target);
    if (!target || !cube?.axis) return false;
    const rect = this.canvas.getBoundingClientRect();
    const edit = this.startingEdit(target);
    const pivot = cube.camera.worldToScreen(cube.center, cube);
    if (!pivot || pivot.depth < 0 || pivot.depth > 1) return false;
    const rig = this.gesture ??= new TransformRig();
    // Field hit-tests the submitted picker, then records pointStart on the
    // last submitted plane. The new axis plane takes effect on the held frame.
    // Hover alone does not submit a new drag plane in the desktop editor.
    rig.controls.axis = "XYZ";
    rig.configure(cube, target.tool, target.space);
    rig.setRay(cube, rect, event);
    rig.controls.pointerHover(null);
    const axis = rig.controls.axis;
    if (!axis) return false;
    rig.controls.axis = "XYZ";
    rig.configure(cube, target.tool, target.space, edit.transform);
    rig.controls.axis = axis;
    const presented = this.presentedPlane?.rotation;
    if (presented) {
      rig.plane.quaternion.copy(presented);
      rig.plane.updateMatrix();
      rig.plane.matrixWorld.multiplyMatrices(rig.plane.parent!.matrixWorld,rig.plane.matrix);
    }
    if (!rig.intersectsPlane()) return false;
    this.grip.setPointerCapture(event.pointerId);
    rig.controls.pointerDown(null);
    rig.scene.updateMatrixWorld(true);
    this.drag = { ...edit, start: edit.transform, cube, rect, rig, pointer: event.pointerId,
      down: [event.clientX,event.clientY], orientation: rig.object.getWorldQuaternion(new Quaternion()),
      startRotation: rig.object.quaternion.clone() };
    this.renderer.domElement.dataset.axis = rig.controls.axis;
    this.invalidate();
    return true;
  }

  private result(drag: Drag): Transform {
    const { start, target, cube } = drag;
    const { object, controls } = drag.rig;
    if (target.tool === "move") {
      // Use the frozen full parent linear map (including shear), and constrain
      // both the native f32 displacement and its displayed serialization.
      const delta = controls.pointEnd.clone().sub(controls.pointStart);
      const axis = controls.axis!;
      const local = target.space === "local" && axis !== "XYZ";
      if (local) delta.applyQuaternion(drag.orientation.clone().invert());
      if (!axis.includes("X")) delta.x = 0;
      if (!axis.includes("Y")) delta.y = 0;
      if (!axis.includes("Z")) delta.z = 0;
      if (local) {
        // Three projects onto the decomposed world axes, then applies the
        // authored rotation. Its decomposition puts the determinant sign on X.
        // Undo the remaining sign flips before returning to the displayed basis.
        const ySign = start.scale.y < 0 ? -1 : 1;
        const zSign = start.scale.z < 0 ? -1 : 1;
        delta.multiply(new Vector3(ySign * zSign, ySign, zSign)).applyQuaternion(drag.orientation);
      }
      // Under shear the displayed basis is not orthogonal. Its plane normal
      // is the cross product of the two displayed directions.
      let normal: Vector3 | undefined;
      if (axis.length === 2) {
        const basis = (key: string) => {
          const v = new Vector3(+(key === "X"), +(key === "Y"), +(key === "Z"));
          return local ? v.applyQuaternion(drag.orientation) : v;
        };
        normal = basis(axis[0]).cross(basis(axis[1])).normalize();
      } else if (axis === "XYZ") normal = drag.rig.camera.getWorldDirection(new Vector3());
      const length = delta.length();
      return { ...start, translation: moveLocal(start.translation, cube.axis, length, delta.normalize(), normal) };
    }
    if (target.tool === "scale") return { ...start, scale: nativeVector(object.scale, start.scale) };
    if (sameOrientation(drag.startRotation,object.quaternion)) return start;
    return { ...start, rotationDeg: rotationDegrees(object.quaternion, start.rotationDeg) };
  }

  private intersectsDragPlane(drag: Drag, event: PointerEvent) {
    drag.rig.setRay(drag.cube, drag.rect, event);
    return drag.rig.intersectsPlane();
  }

  move(event: PointerEvent) {
    const drag = this.drag;
    if (!drag || drag.pointer !== event.pointerId) return;
    if (!this.grip.hasPointerCapture(drag.pointer)) { this.cancel(); return; }
    if (!this.intersectsDragPlane(drag, event)) return;
    drag.rig.controls.pointerMove(null);
    const next = event.clientX === drag.down[0] && event.clientY === drag.down[1] ? drag.start : this.result(drag);
    if (!samePose(next, drag.transform)) {
      drag.transform = next;
      this.invalidate();
    }
  }

  finish(event: PointerEvent) {
    const drag = this.drag;
    if (!drag || drag.pointer !== event.pointerId) return;
    // Field commits the last held pose. Mouse-up can carry new coordinates,
    // which determine whether this release is valid without changing the pose.
    const valid = this.grip.hasPointerCapture(drag.pointer) && this.intersectsDragPlane(drag, event);
    this.cancel();
    const live = this.target();
    if (valid && live?.tool === drag.target.tool && live.space === drag.target.space &&
        !this.canvas.hidden && !samePose(drag.transform, drag.start)) this.apply(drag);
  }

  nudge(distance: number) {
    const target = this.target();
    const cube = target && this.displayedFor(target);
    if (target?.tool !== "move" || target.space !== "world" || !cube?.axis || this.active || this.grip.parentElement!.hidden) return;
    const edit = this.startingEdit(target);
    const translation = moveLocal(edit.transform.translation, cube.axis, distance);
    if (!same(edit.transform.translation, translation)) this.apply({ ...edit, transform: { ...edit.transform, translation } });
  }

  private apply(edit: Edit) {
    const { target, transform, previous } = edit;
    if (!this.current(edit)) return;
    const acknowledgement = this.commit(target.id, transform, previous?.acknowledgement ?? target.sequence);
    const pending: Pending = { target, transform, previous, acknowledgement };
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

  dispose() {
    this.cancel();
    this.renderer.domElement.remove();
    this.keyboard.element.remove();
    this.gesture?.dispose();
    this.display?.dispose();
  }

  interrupt() {
    this.settling = undefined;
    this.cancel();
  }

  cancel(event?: PointerEvent) {
    const drag = this.drag;
    if (!drag || (event && event.pointerId !== drag.pointer)) return;
    this.drag = undefined;
    drag.rig.controls.pointerUp(null);
    delete this.renderer.domElement.dataset.axis;
    if (this.grip.hasPointerCapture(drag.pointer)) this.grip.releasePointerCapture(drag.pointer);
    this.invalidate();
  }
}
