import assert from "node:assert/strict";
import { PerspectiveCamera, Vector3 } from "three";

// Use a separate implementation and the camera in Studio coordinates.
export function projector({ eye, aim, up, fovYDegrees, near, far }, width, height) {
  const camera = new PerspectiveCamera(fovYDegrees, width / height, near, far);
  camera.position.fromArray(eye);
  camera.up.fromArray(up);
  camera.lookAt(...(aim.orbitTarget ?? eye.map((v,i) => v + aim.forward[i])));
  camera.updateMatrixWorld();
  return position => {
    const p = new Vector3(...position).project(camera);
    return [(1 + p.x) * width / 2, (1 - p.y) * height / 2];
  };
}

export function checkPlacement(name, data, points) {
  const project = projector(data.camera, data.size.width, data.size.height);
  for (const [i, point] of points.entries()) {
    const mark = data.landmarks[i];
    mark.expectedPixel = project(point.position);
    mark.errorPx = Math.hypot(...mark.pixel.map((v,axis) => v - mark.expectedPixel[axis]));
  }
  // The broad low-relief fixtures also have an independently predictable
  // footprint. Test the actual alpha readback even if the camera observer lies.
  if (points.every(p => Math.abs(p.position[1] - p.datumY) < 0.5)) {
    const corners = [0,1,3,2].map(i => {
      const [x,,z] = points[i].position;
      return project([x,points[i].datumY,z]);
    });
    data.footprint = polygonCoverage(Buffer.from(data.mask, "base64"), data.size.width, corners);
  }
  const worst = Math.max(...data.landmarks.map(p => p.errorPx));
  assert.ok(worst <= 1, `${name} projection error ${worst} px`);
  if (data.footprint) assert.ok(data.footprint.iou >= 0.995, `${name} rendered footprint IoU ${data.footprint.iou}`);
}

export function measureFootprint(mask, heights) {
  const [width, height] = [192, 128];
  assert.equal(mask.length, width * height);
  const project = projector({eye:[0,12,0], aim:{orbitTarget:[0,0,0]}, up:[0,0,-1],
    fovYDegrees:45, near:0.1, far:100}, width, height);
  // Clockwise corners of the specified 8 x 2 ground footprint. The plane
  // slopes linearly, so its four projected edges delimit every covered pixel.
  const corners = [0,4,14,10].map(i => project([(i%5-2)*2, heights[i]-10, Math.floor(i/5)-1]));
  return polygonCoverage(mask, width, corners);
}

function polygonCoverage(mask, width, corners) {
  let expected = 0, actual = 0, intersection = 0;
  for (let i = 0; i < mask.length; i++) {
    const x = i%width + 0.5, y = Math.floor(i/width) + 0.5;
    const inside = corners.every(([ax,ay], j) => {
      const [bx,by] = corners[(j+1)%4];
      return (bx-ax)*(y-ay) - (by-ay)*(x-ax) >= 0;
    });
    expected += Number(inside);
    actual += mask[i];
    intersection += inside ? mask[i] : 0;
  }
  return { corners, expected, actual, intersection, iou: intersection / (expected + actual - intersection) };
}

export function checkFootprint(result) {
  assert.ok(result.expected && result.actual && result.iou >= 0.995, `Packaged footprint IoU ${result.iou}`);
}
