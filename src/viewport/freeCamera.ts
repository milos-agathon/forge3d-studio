import { MathUtils, Quaternion, Spherical, Vector3, type PerspectiveCamera, type QuaternionTuple, type Vector3Tuple } from "three";

export type CameraDrag = "orbit" | "pan" | "dolly";

export const FREE_VIEW_FOCUS_DISTANCE = 10;
const CHANGE_EPS = 1e-6; // OrbitControls squared displacement / small-angle rotation threshold.
const DAMPING = 0.09;
// Remaining motion in radians or Studio units, well below a physical pixel.
const SETTLED = 1e-9;

/** Field Instrument's Y-up perspective orbit in Studio units. Event handlers
 * take one step immediately, then the host advances the remaining motion. */
export class FreeCamera {
  private theta = 0;
  private phi = 0;
  private pan = new Vector3();
  private offset = new Vector3();
  private spherical = new Spherical();

  private lastEye = new Vector3();
  private lastRotation = new Quaternion();
  private lastTarget = new Vector3();

  constructor(private camera: PerspectiveCamera, private target: Vector3) {
    this.rememberChange();
  }

  private rememberChange() {
    this.lastEye.copy(this.camera.position);
    this.lastRotation.copy(this.camera.quaternion);
    this.lastTarget.copy(this.target);
  }

  setPose(eye: Vector3Tuple, aim: Vector3Tuple, orientation?: QuaternionTuple) {
    this.clear();
    this.camera.position.fromArray(eye);
    this.target.fromArray(aim);
    if (orientation) {
      this.camera.quaternion.fromArray(orientation);
      this.camera.updateMatrixWorld();
    } else if (eye[0] === aim[0] && eye[2] === aim[2] && eye[1] !== aim[1]) {
      // A Y-up lookAt at the pole tilts the camera to break the singularity.
      // Use the map-north convention of the viewport's top view.
      const up = this.camera.up.clone();
      this.camera.up.set(0, 0, -1);
      this.camera.lookAt(this.target);
      this.camera.up.copy(up);
    } else {
      this.camera.lookAt(this.target);
    }
    this.rememberChange();
  }

  clear() {
    this.theta = this.phi = 0;
    this.pan.set(0, 0, 0);
  }

  drag(kind: CameraDrag, dx: number, dy: number, cssHeight: number) {
    if (cssHeight <= 0) return false;
    if (kind === "dolly") return this.dolly(dy);
    if (kind === "orbit") {
      this.theta -= 2 * Math.PI * dx / cssHeight;
      this.phi -= 2 * Math.PI * dy / cssHeight;
    } else {
      const radius = this.camera.position.distanceTo(this.target);
      const units = 2 * radius * Math.tan(MathUtils.degToRad(this.camera.fov / 2)) / cssHeight;
      // OrbitControls samples the local matrix at event time. lookAt updates
      // that matrix before writing its new rotation, so input timing matters.
      const right = this.offset.setFromMatrixColumn(this.camera.matrix, 0);
      this.pan.x += units * (-dx * right.x + dy * right.z);
      this.pan.z += units * (-dx * right.z - dy * right.x);
    }
    return this.update();
  }

  dolly(pixels: number) {
    return this.update(0.95 ** (-pixels / 100));
  }

  update(scale = 1) {
    if (scale === 1 && !this.theta && !this.phi && this.pan.lengthSq() === 0) return false;
    const sphere = this.spherical.setFromVector3(this.offset.subVectors(this.camera.position, this.target));
    sphere.theta += this.theta * DAMPING;
    sphere.phi += this.phi * DAMPING;
    sphere.makeSafe();
    const radius = sphere.radius;
    sphere.radius = MathUtils.clamp(radius * scale, 0.8, 150);
    this.target.addScaledVector(this.pan, DAMPING);
    this.camera.position.copy(this.target).add(this.offset.setFromSpherical(sphere));
    this.camera.lookAt(this.target);

    this.theta *= 1 - DAMPING;
    this.phi *= 1 - DAMPING;
    this.pan.multiplyScalar(1 - DAMPING);
    if (Math.max(Math.abs(this.theta), Math.abs(this.phi), this.pan.length()) < SETTLED) this.clear();
    // Integrate small steps even on a quiet frame. Field signals a change
    // when their displacement since the last signal crosses its threshold.
    if (sphere.radius === radius &&
        this.lastEye.distanceToSquared(this.camera.position) <= CHANGE_EPS &&
        this.lastTarget.distanceToSquared(this.target) <= CHANGE_EPS &&
        8 * (1 - this.lastRotation.dot(this.camera.quaternion)) <= CHANGE_EPS) return false;
    this.rememberChange();
    return true;
  }
}
