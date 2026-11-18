import * as THREE from "three";
import { formatGridValue, gridLines, niceInterval, type GridLine, type MapFrame } from "./mapGrid";

/** Measurement cyan (Field Instrument `--measure`): sRGB hex in, linear
 *  working-space components out (three's colour management). */
const MEASURE_SRGB = new THREE.Color(0x4fb0c4);
/** Tick length and label stand-off, in the terrain's unit-square space. */
const TICK = 0.022;
const LABEL_OFFSET = 0.05;

type Edge = "north" | "south" | "west" | "east";

interface RulerLabel {
  div: HTMLDivElement;
  edge: Edge;
  /** Terrain-local anchor (the mesh's unit square, before its scale). */
  local: THREE.Vector3;
  /** Measured once while shown (a hidden div measures 0). */
  width: number;
}

export interface MapGridHandle {
  interval: number;
  setVisible(visible: boolean): void;
  /** False once the terrain has left the scene (deleted or rebuilt). */
  attachedTo(root: THREE.Object3D): boolean;
  /** Per frame: pick the near edges and move their labels with the view. */
  update(camera: THREE.Camera, width: number, height: number): void;
  dispose(): void;
}

/**
 * Drapes the map grid on a terrain mesh built by buildTerrainMesh (a unit
 * plane, row 0 north, column 0 west, scaled to its footprint) and hangs the
 * edge rulers off it. The ticks and labels sit on the two edges nearest the
 * camera, so they never read through the relief.
 */
export function buildMapGrid(
  terrain: THREE.Mesh,
  frame: MapFrame,
  labelParent: HTMLElement,
): MapGridHandle {
  const interval = niceInterval(Math.max(frame.spanX, frame.spanZ));
  const { eastings, northings } = gridLines(frame, interval);

  // --- the drape: lines from the map coordinates of each fragment -------
  // The offsets are taken in float64 here so the shader only ever sees
  // small numbers (a UTM northing in float32 is only good to ~0.5 m).
  const offsetX = frame.west - Math.floor(frame.west / interval) * interval;
  const offsetZ = frame.north - Math.floor(frame.north / interval) * interval;
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uSpan: { value: new THREE.Vector2(frame.spanX / interval, frame.spanZ / interval) },
      uOffset: { value: new THREE.Vector2(offsetX / interval, offsetZ / interval) },
      uColor: { value: new THREE.Vector3(MEASURE_SRGB.r, MEASURE_SRGB.g, MEASURE_SRGB.b) },
      uOpacity: { value: 0.85 },
      uMargin: { value: 0.02 },
    },
    vertexShader: /* glsl */ `
      uniform vec2 uSpan;
      uniform vec2 uOffset;
      varying vec2 vGrid;
      varying vec2 vUnit;
      void main() {
        vUnit = vec2(position.x + 0.5, position.z + 0.5);
        // x: intervals east of the last line west of the west edge;
        // y: the same for northings (north decreases as z grows).
        vGrid = vec2(vUnit.x * uSpan.x + uOffset.x, uOffset.y - vUnit.y * uSpan.y);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform float uOpacity;
      uniform float uMargin;
      varying vec2 vGrid;
      varying vec2 vUnit;
      void main() {
        vec2 width = max(fwidth(vGrid), vec2(1e-6));
        vec2 distance = abs(fract(vGrid - 0.5) - 0.5) / width;
        // Lines hugging an edge are the edge: leave them to the outline.
        if (vUnit.x < uMargin || vUnit.x > 1.0 - uMargin) distance.x = 1e3;
        if (vUnit.y < uMargin || vUnit.y > 1.0 - uMargin) distance.y = 1e3;
        float line = 1.0 - clamp(min(distance.x, distance.y) - 0.35, 0.0, 1.0);
        if (line < 0.02) discard;
        gl_FragColor = vec4(uColor, line * uOpacity);
        // uColor is linear (THREE.Color converts the sRGB hex on input);
        // built-in materials end with this conversion, a ShaderMaterial must
        // ask for it, or the canvas shows the darker linear values.
        #include <colorspace_fragment>
      }
    `,
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
    side: THREE.DoubleSide,
  });
  const drape = new THREE.Mesh(terrain.geometry, material);
  drape.name = "map-grid";
  drape.renderOrder = 2;
  drape.userData.mapGrid = true;
  // Never a pick target: selection and the cursor readout hit the terrain.
  drape.raycast = () => {};

  // --- edge heights, from the terrain's own vertices --------------------
  const position = terrain.geometry.attributes.position as THREE.BufferAttribute;
  const resolution = Math.round(Math.sqrt(position.count));
  const heightAt = (row: number, column: number) =>
    position.getY(Math.min(resolution - 1, row) * resolution + Math.min(resolution - 1, column));
  const sample = (fraction: number, along: (index: number) => number) => {
    const exact = fraction * (resolution - 1);
    const low = Math.floor(exact);
    const blend = exact - low;
    return along(low) * (1 - blend) + along(Math.min(resolution - 1, low + 1)) * blend;
  };
  const edgePoint = (edge: Edge, t: number): THREE.Vector3 => {
    switch (edge) {
      case "north":
        return new THREE.Vector3(t - 0.5, sample(t, (c) => heightAt(0, c)), -0.5);
      case "south":
        return new THREE.Vector3(t - 0.5, sample(t, (c) => heightAt(resolution - 1, c)), 0.5);
      case "west":
        return new THREE.Vector3(-0.5, sample(t, (r) => heightAt(r, 0)), t - 0.5);
      case "east":
        return new THREE.Vector3(0.5, sample(t, (r) => heightAt(r, resolution - 1)), t - 0.5);
    }
  };
  const outward: Record<Edge, THREE.Vector3> = {
    north: new THREE.Vector3(0, 0, -1),
    south: new THREE.Vector3(0, 0, 1),
    west: new THREE.Vector3(-1, 0, 0),
    east: new THREE.Vector3(1, 0, 0),
  };

  // --- ticks: one segment set per edge, shown for the near edges only ----
  const tickMaterial = new THREE.LineBasicMaterial({
    color: MEASURE_SRGB,
    transparent: true,
    opacity: 0.95,
    depthWrite: false,
  });
  const ticks = new Map<Edge, THREE.LineSegments>();
  const labels: RulerLabel[] = [];
  const layer = document.createElement("div");
  layer.className = "map-grid-labels";
  layer.setAttribute("aria-hidden", "true");
  labelParent.appendChild(layer);

  const addEdge = (edge: Edge, lines: GridLine[], axis: "E" | "N") => {
    const points: number[] = [];
    for (const line of lines) {
      const base = edgePoint(edge, line.t);
      const tip = base.clone().addScaledVector(outward[edge], TICK);
      points.push(base.x, base.y, base.z, tip.x, tip.y, tip.z);
      const div = document.createElement("div");
      div.className = `map-grid-label map-grid-label--${axis === "E" ? "easting" : "northing"}`;
      div.textContent = formatGridValue(line.value, interval, axis, frame.projected);
      layer.appendChild(div);
      labels.push({ div, edge, local: base.clone().addScaledVector(outward[edge], LABEL_OFFSET), width: 0 });
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(points, 3));
    const segments = new THREE.LineSegments(geometry, tickMaterial);
    segments.raycast = () => {};
    segments.renderOrder = 3;
    ticks.set(edge, segments);
    drape.add(segments);
  };
  addEdge("south", eastings, "E");
  addEdge("north", eastings, "E");
  addEdge("west", northings, "N");
  addEdge("east", northings, "N");

  terrain.add(drape);

  let visible = true;
  const cameraLocal = new THREE.Vector3();
  const world = new THREE.Vector3();
  const view = new THREE.Vector3();
  return {
    interval,
    setVisible(next) {
      if (next === visible) return;
      visible = next;
      drape.visible = next;
      layer.style.display = next ? "" : "none";
    },
    attachedTo(root) {
      let attached = false;
      terrain.traverseAncestors((ancestor) => {
        if (ancestor === root) attached = true;
      });
      return attached;
    },
    update(camera, width, height) {
      if (!visible) return;
      // The drape and ticks are children of the terrain and hide with it; the
      // DOM rulers are not, so they follow the terrain's own visibility.
      let shown = terrain.visible;
      terrain.traverseAncestors((ancestor) => {
        if (!ancestor.visible) shown = false;
      });
      layer.style.display = shown ? "" : "none";
      if (!shown) return;
      // The near edge of each pair faces the camera.
      cameraLocal.copy(camera.position);
      terrain.worldToLocal(cameraLocal);
      const near: Record<Edge, boolean> = {
        south: cameraLocal.z >= 0,
        north: cameraLocal.z < 0,
        east: cameraLocal.x >= 0,
        west: cameraLocal.x < 0,
      };
      for (const [edge, segments] of ticks) segments.visible = near[edge];
      for (const label of labels) {
        if (!near[label.edge]) {
          label.div.style.display = "none";
          continue;
        }
        world.copy(label.local);
        terrain.localToWorld(world);
        view.copy(world).applyMatrix4(camera.matrixWorldInverse);
        if (view.z >= -0.05) {
          label.div.style.display = "none";
          continue;
        }
        world.project(camera);
        const x = (world.x * 0.5 + 0.5) * width;
        const y = (-world.y * 0.5 + 0.5) * height;
        // Whole labels only: one cut by the viewport edge reads as a wrong number.
        if (label.width === 0 && label.div.style.display !== "none") label.width = label.div.offsetWidth;
        const half = (label.width || 96) / 2 + 4;
        if (x < half || y < 12 || x > width - half || y > height - 12) {
          label.div.style.display = "none";
          continue;
        }
        label.div.style.display = "";
        label.div.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) translate(-50%, -50%)`;
      }
    },
    dispose() {
      drape.removeFromParent();
      material.dispose();
      tickMaterial.dispose();
      for (const segments of ticks.values()) segments.geometry.dispose();
      layer.remove();
    },
  };
}
