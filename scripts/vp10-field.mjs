import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// Load the oracle from Field's checkout, including its own installed picker.
export async function fieldOracle(field) {
  const module = path => import(pathToFileURL(join(field,"node_modules/three",path)));
  const T = await module("build/three.module.js");
  const { TransformControls } = await module("examples/jsm/controls/TransformControls.js");
  assert.equal(T.REVISION, "187");
  const width = 794, height = 727;
  return (transform, tool, space, eye, aim) => {
    const camera = new T.PerspectiveCamera(45,width/height,.05,2000);
    camera.position.fromArray(eye);
    camera.lookAt(new T.Vector3(...aim));
    const controls = new TransformControls(camera);
    const scene = new T.Scene(), object = new T.Group();
    scene.add(object,controls.getHelper());
    object.position.copy(transform.translation);
    object.scale.copy(transform.scale);
    const r = transform.rotationDeg;
    object.rotation.set(...[r.x,r.y,r.z].map(T.MathUtils.degToRad),"ZYX");
    controls.attach(object);
    controls.setSize(.85);
    controls.setMode(tool === "move" ? "translate" : tool);
    controls.setSpace(space);
    scene.updateMatrixWorld(true);
    const pointer = ([x,y],button) => ({x:2*x/width-1,y:1-2*y/height,button});
    const screen = p => {
      p.project(camera);
      return [(p.x+1)*width/2,(1-p.y)*height/2];
    };
    const geometry = controls.getHelper().children.find(c=>c.isTransformControlsGizmo).gizmo[controls.mode];
    const landmarks = geometry.children.filter(c=>c.visible).map(mesh=>{
      const positions = mesh.geometry.attributes.position;
      return {axis:mesh.name, pixels:[0,Math.floor(positions.count/3),positions.count-1].map(index=>
        screen(new T.Vector3().fromBufferAttribute(positions,index).applyMatrix4(mesh.matrixWorld)))};
    });
    return {landmarks,
      point(axis) {
        // Search from the projected grip geometry, keeping the cursor away from
        // picker boundaries and the singular origin of uniform scaling.
        const pivot = screen(object.position.clone());
        const points = landmarks.filter(m=>m.axis===axis).flatMap(m=>m.pixels);
        if (axis === "XYZE" || axis === "XYZ") points.unshift([pivot[0]+7,pivot[1]-5]);
        const hit = p => { controls.pointerHover(pointer(p,0)); return controls.axis === axis; };
        for (const radius of [0,3,6,10,15,23]) {
          for (const point of points) for (let i=0;i<16;i++) {
            const angle = i*Math.PI/8;
            const p = point.map((v,j)=>Math.round(v+radius*(j?Math.sin(angle):Math.cos(angle))));
            if ([[0,0],[1,0],[-1,0],[0,1],[0,-1]].every(([x,y])=>hit([p[0]+x,p[1]+y]))) return p;
          }
        }
        throw Error(`Field has no resolved ${tool} ${space} ${axis} grip`);
      },
      matrix(t) {
        const r = t.rotationDeg;
        return new T.Matrix4().compose(new T.Vector3().copy(t.translation), new T.Quaternion().setFromEuler(
          new T.Euler(...[r.x,r.y,r.z].map(T.MathUtils.degToRad),"ZYX")),new T.Vector3().copy(t.scale)).elements;
      }
    };
  };
}
