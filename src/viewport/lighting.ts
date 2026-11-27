/**
 * The lighting rig both renderers share.
 *
 * Solid and Material draw with three.js, Rendered draws with Forge3D; the only
 * way the three stay the same picture is that they are handed the *same*
 * numbers. This module derives those numbers from the project — one pure
 * function — so the viewport and the node test that pins it against the
 * renderer's payload read the same source.
 *
 * The invariants it encodes (each was a real bug once):
 *  - the sun is the scene's directional light, with its own colour and
 *    intensity — no fudge factor, no sRGB conversion (`u_shading.light_params`
 *    is `colour * intensity` in linear radiance);
 *  - the exposure is the project's, the same one the engine tone-maps with;
 *  - the environment is the project's HDRI path, or nothing for the built-in sky;
 *  - shadows are on unless the project turns them off, with the project's
 *    filter and map size.
 */
import * as THREE from "three";

import type { Project, ShadowTechnique } from "../bridge/types";

import { localMatrix, objectParentWorld, sceneObjectVisibility, viewportPose } from "./forge3dWebMapping.ts";
import type { ViewportObject } from "./viewportState";

type LightNode = Omit<ViewportObject, "terrainRevision">;

export function sceneSun(objects: readonly LightNode[], groups?: ReadonlyMap<string, THREE.Group>): LightingSun | null {
  const light = objects.find(o => o.visible && o.kind.type === "light" && o.kind.kind === "directional");
  if (light?.kind.type !== "light") return null;
  const group = groups?.get(light.id);
  group?.updateWorldMatrix(true, false);
  const world = group?.matrixWorld ?? localMatrix(light);
  if (!group && light.parent) world.premultiply(objectParentWorld(light.parent, new Map(objects.map(o => [o.id,o]))).matrix);
  const direction = new THREE.Vector3(0,0,-1).transformDirection(world);
  if (!direction.lengthSq()) return null;
  return { direction: direction.toArray(),
    intensity: Math.max(0,light.kind.intensity), color: [...light.kind.color] };
}

export interface LightingSun {
  /** Unit direction the light travels, viewport frame (Y up, north at -Z). */
  direction: [number, number, number];
  /** Linear RGB radiance multiplier, exactly the project's value. */
  intensity: number;
  /** Linear RGB colour, exactly the project's value. */
  color: [number, number, number];
}

export interface LightingShadowRig {
  enabled: boolean;
  technique: ShadowTechnique;
  resolution: number;
}

export interface LightingRig {
  /** The visible directional light, or null when the scene has none. */
  sun: LightingSun | null;
  exposure: number;
  /** HDRI asset path, or null for the built-in studio sky. */
  environment: string | null;
  shadows: LightingShadowRig;
}

export function lightingRig(project: Project): LightingRig {
  const environment =
    project.render.environment !== null
      ? project.assets.find((asset) => asset.id === project.render.environment)?.path ?? null
      : null;

  const visibility = sceneObjectVisibility(project.scene.objects);
  return {
    sun: sceneSun(project.scene.objects.map(o => ({ id:o.id, parent:o.parent, kind:o.kind,
      visible:visibility.get(o.id) === true, ...viewportPose(o) }))),
    exposure: project.render.exposure,
    environment,
    shadows: {
      enabled: project.render.shadows,
      technique: project.render.shadowTechnique,
      resolution: project.render.shadowResolution,
    },
  };
}
