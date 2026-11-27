import * as THREE from "three";
import type { CameraObject, LightObject, Primitive } from "../bridge/types";

export function primitiveGeometry(primitive: Primitive) {
  switch (primitive.type) {
    case "cube": return new THREE.BoxGeometry(primitive.size, primitive.size, primitive.size);
    case "sphere": return new THREE.SphereGeometry(primitive.radius, 32, 24);
    case "plane": return new THREE.PlaneGeometry(primitive.size, primitive.size).rotateX(-Math.PI / 2);
  }
}

/** A small frustum, drawn where the project's active camera sits. */
export function buildCameraGizmo(camera: CameraObject): THREE.LineSegments {
  const forward = 1.15;
  const halfHeight = Math.tan((camera.fovDeg * Math.PI) / 360) * forward;
  const halfWidth = halfHeight * 1.45;
  const apex: [number, number, number] = [0, 0, 0];
  const corners: Array<[number, number, number]> = [
    [-halfWidth, -halfHeight, -forward],
    [halfWidth, -halfHeight, -forward],
    [halfWidth, halfHeight, -forward],
    [-halfWidth, halfHeight, -forward],
  ];

  const points: number[] = [];
  corners.forEach((corner, index) => {
    points.push(...apex, ...corner);
    points.push(...corner, ...corners[(index + 1) % corners.length]);
  });
  points.push(0, 0, 0, 0, 0.24, 0, 0, 0, 0, 0.24, 0, 0);

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(points, 3));
  const lines = new THREE.LineSegments(
    geometry,
    new THREE.LineBasicMaterial({ color: 0xc6ced2 }),
  );
  lines.userData.owned = true;
  return lines;
}

export function buildLightGizmo(light: LightObject): THREE.Group {
  const group = new THREE.Group();
  const colour = new THREE.Color(light.color[0], light.color[1], light.color[2]);

  const bulb = new THREE.Mesh(
    new THREE.SphereGeometry(0.09, 14, 10),
    new THREE.MeshBasicMaterial({ color: colour }),
  );
  bulb.userData.owned = true;
  group.add(bulb);

  if (light.kind === "directional") {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute(
      "position",
      new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, -1.6], 3),
    );
    const ray = new THREE.Line(
      geometry,
      new THREE.LineBasicMaterial({ color: colour, transparent: true, opacity: 0.75 }),
    );
    ray.userData.owned = true;
    group.add(ray);
  } else {
    for (let index = 0; index < 8; index += 1) {
      const angle = (index / 8) * Math.PI * 2;
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute(
        "position",
        new THREE.Float32BufferAttribute(
          [0, 0, 0, Math.cos(angle) * 0.42, Math.sin(angle) * 0.42, 0],
          3,
        ),
      );
      const spike = new THREE.Line(
        geometry,
        new THREE.LineBasicMaterial({ color: colour, transparent: true, opacity: 0.6 }),
      );
      spike.userData.owned = true;
      group.add(spike);
    }
  }
  group.userData.owned = true;
  return group;
}
