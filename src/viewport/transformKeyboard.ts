import { MathUtils, Matrix4, Quaternion, Vector3 } from "three";
import type { Transform, ToolSpace } from "../bridge/types";
import type { DisplayedPose, TransformRig, TransformTool } from "./transformRig";
import { moveLocal, nativeVector, orientation, rotationDegrees } from "./transformPrecision";

export function keyboardStep(cube: DisplayedPose, rig: TransformRig, tool: TransformTool, space: ToolSpace,
  grip: string, vertical: boolean, steps: number, start: Transform): Transform {
  const component = grip[vertical && grip.length === 2 ? 1 : 0];
  const axis = new Vector3(+(component === "X"), +(component === "Y"), +(component === "Z"));
  if (tool === "scale") {
    const scale = new Vector3().copy(start.scale);
    const factor = Math.pow(1.01, steps);
    if (grip === "XYZ") scale.multiplyScalar(factor);
    else scale.setComponent(axis.x ? 0 : axis.y ? 1 : 2, scale.dot(axis)*factor);
    return { ...start, scale: nativeVector(scale,start.scale) };
  }
  const local = orientation(start.rotationDeg);
  if (tool === "move") {
    if (grip === "XYZ") axis.set(vertical?0:1,vertical?1:0,0).applyQuaternion(rig.camera.quaternion);
    else if (space === "local") {
      const world = cube.parent.clone().multiply(new Matrix4().compose(new Vector3(),local,new Vector3().copy(start.scale)));
      const orientation = new Quaternion();
      world.decompose(new Vector3(),orientation,new Vector3());
      axis.applyQuaternion(orientation).normalize();
    }
    return { ...start, translation: moveLocal(start.translation,cube.axis,steps*.1,axis) };
  }
  const screen = grip === "XYZE" || grip === "E";
  if (screen) {
    if (grip === "E") axis.copy(rig.camera.position).normalize();
    else axis.set(vertical?1:0,vertical?0:1,0).applyQuaternion(rig.camera.quaternion);
  }
  if (space === "world" || screen) {
    const parent = new Quaternion();
    cube.parent.decompose(new Vector3(),parent,new Vector3());
    axis.applyQuaternion(parent.invert()).normalize();
    local.premultiply(new Quaternion().setFromAxisAngle(axis,steps*MathUtils.DEG2RAD));
  } else local.multiply(new Quaternion().setFromAxisAngle(axis,steps*MathUtils.DEG2RAD));
  return { ...start, rotationDeg: rotationDegrees(local,start.rotationDeg) };
}

export class KeyboardGrips {
  readonly element = document.createElement("div");
  private signature = "";
  private help = document.createElement("span");

  constructor(anchor: HTMLElement, private step: (axis: string, vertical: boolean, amount: number) => void) {
    this.element.className = "transform-keyboard";
    this.element.setAttribute("role","group");
    this.element.hidden = true;
    this.help.id = "transform-key-help";
    this.element.append(this.help);
    anchor.before(this.element);
  }

  show(tool: TransformTool, space: ToolSpace, axes: string[]) {
    const basis = tool === "scale" ? "local" : space;
    const label = `${tool} · ${basis} axes`;
    const signature = [label,...axes].join("/");
    this.element.hidden = !axes.length;
    if (signature === this.signature) return;
    this.signature = signature;
    this.element.setAttribute("aria-label",label);
    const existing = new Map(Array.from(this.element.querySelectorAll("button"), button => [button.dataset.grip,button]));
    // Keep surviving controls mounted so visibility changes during a nudge
    // preserve the focused button and the browser's keyboard repeat.
    for (const [axis,button] of existing) if (!axes.includes(axis!)) button.remove();
    for (const [index,axis] of axes.entries()) {
      const button = existing.get(axis) ?? document.createElement("button");
      if (!button.isConnected) this.element.insertBefore(button,this.element.children[index] ?? this.help);
      button.type = "button";
      button.dataset.grip = axis;
      const name = axis === "XYZ" ? (tool === "scale" ? "uniform" : "screen plane")
        : axis === "XYZE" ? "free rotation" : axis === "E" ? "view axis" : axis;
      button.textContent = name;
      button.setAttribute("aria-label",`${tool} ${name}, ${basis} axes`);
      const directions = axis.length === 2 ? `Left/right adjusts ${axis[0]}. Up/down adjusts ${axis[1]}.`
        : axis === "XYZE" || (axis === "XYZ" && tool === "move") ? "Use both arrow pairs in the view plane."
        : "Right or up increases. Left or down decreases.";
      button.title = directions + " Shift increases the step tenfold.";
      button.onfocus = () => { this.help.textContent = button.title; };
      button.setAttribute("aria-describedby","transform-key-help");
      button.onclick = () => this.step(axis,false,1);
      button.onkeydown = event=>{
        if (!["ArrowLeft","ArrowRight","ArrowUp","ArrowDown"].includes(event.key)) return;
        event.preventDefault();
        event.stopPropagation();
        const positive = event.key === "ArrowUp" || event.key === "ArrowRight";
        this.step(axis,event.key === "ArrowUp" || event.key === "ArrowDown",(positive?1:-1)*(event.shiftKey?10:1));
      };
      if (button === document.activeElement) this.help.textContent = button.title;
    }
  }
}
