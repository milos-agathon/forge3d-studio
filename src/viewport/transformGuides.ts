import { Frustum, Line, Matrix4, Vector3 } from "three";
import type { SVGRenderer } from "three/addons/renderers/SVGRenderer.js";
import type { TransformControlsGizmo } from "three/addons/controls/TransformControls.js";
import type { TransformRig } from "./transformRig";

// The long helper segments can cross both depth planes. Three's SVG projector
// clips the second endpoint against the already clipped first endpoint. Clip
// the original segment to all six planes before passing it to the projector.
export function renderTransformGuides(renderer: SVGRenderer, rig: TransformRig) {
  rig.scene.updateMatrixWorld(true);
  rig.camera.updateMatrixWorld();
  const gizmo = rig.controls.getHelper().getObjectByProperty("isTransformControlsGizmo",true) as TransformControlsGizmo;
  const restore: (() => void)[] = [];
  const autoUpdate = rig.scene.matrixWorldAutoUpdate;
  rig.scene.matrixWorldAutoUpdate = false; // The control has already positioned its helpers.
  try {
    for (const line of gizmo.helper[rig.controls.mode].children) {
      if (!(line instanceof Line) || !line.visible || line.name === "DELTA") continue;
      const position = line.geometry.getAttribute("position");
      const a = new Vector3().fromBufferAttribute(position,0);
      const b = new Vector3().fromBufferAttribute(position,1);
      const projection = new Matrix4().multiplyMatrices(rig.camera.projectionMatrix,rig.camera.matrixWorldInverse).multiply(line.matrixWorld);
      const frustum = new Frustum().setFromProjectionMatrix(projection);
      let start = 0, end = 1;
      for (const plane of frustum.planes) {
        const d0 = plane.distanceToPoint(a), d1 = plane.distanceToPoint(b);
        if (d0 < 0 && d1 < 0) { end = -1; break; }
        if (d0 < 0) start = Math.max(start,d0/(d0-d1));
        if (d1 < 0) end = Math.min(end,d0/(d0-d1));
      }
      if (end < start) {
        line.visible = false;
        restore.push(() => { line.visible = true; });
        continue;
      }
      if (!line.geometry.boundingSphere) line.geometry.computeBoundingSphere();
      const first = a.clone().lerp(b,start), last = a.clone().lerp(b,end);
      position.setXYZ(0,first.x,first.y,first.z);
      position.setXYZ(1,last.x,last.y,last.z);
      restore.push(() => {
        position.setXYZ(0,a.x,a.y,a.z);
        position.setXYZ(1,b.x,b.y,b.z);
      });
    }
    renderer.render(rig.scene,rig.camera);
  } finally {
    rig.scene.matrixWorldAutoUpdate = autoUpdate;
    for (const reset of restore) reset();
  }
}
