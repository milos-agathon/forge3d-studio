import { Group, MathUtils, PerspectiveCamera, Quaternion, Scene, Vector3 } from "three";
import { TransformControls } from "three/addons/controls/TransformControls.js";
import type { Tool, ToolSpace, Transform } from "../bridge/types";
import type { ForgeTerrainViewport } from "./forge3dWebViewport";

// These published TransformControls properties are shared with its helper
// meshes. The r187 type declarations only list their change events.
type ControlState = TransformControls & {
  pointStart: Vector3;
  pointEnd: Vector3;
  worldPositionStart: Vector3;
  worldQuaternionStart: Quaternion;
  rotationAxis: Vector3;
};

export type DisplayedPose = NonNullable<ReturnType<ForgeTerrainViewport["displayedObject"]>>;
export type TransformTool = Exclude<Tool, "select">;

// Work in Studio units relative to the submitted pivot. Keeping the translation
// out of the parent matrix preserves small gestures at large project coordinates.
export class TransformRig {
  readonly scene = new Scene();
  readonly camera = new PerspectiveCamera();
  readonly controls = new TransformControls(this.camera) as ControlState;
  readonly object = new Group();
  private parent = new Group();
  readonly plane = this.controls.getHelper().getObjectByProperty("isTransformControlsPlane", true)!;

  constructor() {
    this.parent.matrixAutoUpdate = false;
    this.parent.add(this.object);
    this.scene.add(this.parent, this.controls.getHelper());
    this.controls.setSize(.85);
    this.controls.attach(this.object);
  }

  configure(pose: DisplayedPose, tool: TransformTool, space: ToolSpace, transform?: Transform) {
    const { camera, center, scale } = pose;
    const relative = (v: readonly number[]) => new Vector3().fromArray(v).sub(new Vector3(...center)).multiplyScalar(scale);
    this.camera.position.copy(relative(camera.position));
    this.camera.up.fromArray(camera.up);
    this.camera.lookAt(relative(camera.target));
    this.camera.fov = camera.fovYDegrees;
    this.camera.aspect = pose.width / pose.height;
    this.camera.near = camera.near * scale;
    this.camera.far = camera.far * scale;
    this.camera.updateProjectionMatrix();
    this.parent.matrix.copy(pose.parent).setPosition(0, 0, 0);
    const rotation = transform?.rotationDeg;
    const [x,y,z] = rotation ? [rotation.x, rotation.y, rotation.z] : pose.object.rotationDeg;
    this.object.rotation.set(MathUtils.degToRad(x), MathUtils.degToRad(y), MathUtils.degToRad(z), "ZYX");
    if (transform) this.object.scale.copy(transform.scale);
    else this.object.scale.fromArray(pose.object.scale);
    this.object.position.set(0, 0, 0);
    this.controls.setMode(tool === "move" ? "translate" : tool);
    this.controls.setSpace(space);
    this.scene.updateMatrixWorld(true);
  }

  // TransformControls accepts a precomputed ray when its pointer is null.
  // Set it for every event since Three shares the raycaster between controls.
  setRay(pose: DisplayedPose, rect: DOMRect, event: PointerEvent) {
    const x = (event.clientX - rect.left) * pose.width / rect.width;
    const y = (event.clientY - rect.top) * pose.height / rect.height;
    const { origin, direction } = pose.camera.screenRay(x, y, pose);
    const ray = this.controls.getRaycaster().ray;
    ray.origin.fromArray(origin).sub(new Vector3(...pose.center)).multiplyScalar(pose.scale);
    ray.direction.fromArray(direction);
  }

  intersectsPlane() {
    return this.controls.getRaycaster().intersectObject(this.plane, false).length > 0;
  }

  dispose() {
    // This rig has no DOM connection. Its helper owns the picker and meshes.
    this.controls.detach();
    this.controls.getHelper().dispose();
  }
}
