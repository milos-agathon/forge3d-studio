import { useSyncExternalStore } from "react";

import type { GroundScale } from "./groundScale";

/**
 * The viewport samples the DEM and publishes its ground scale here; the
 * inspectors read it. One source, so the viewport's AREA and the inspectors'
 * Footprint can never disagree.
 */
let current: GroundScale | null = null;
const listeners = new Set<() => void>();

export function publishGroundScale(next: GroundScale | null): void {
  if (
    current === next ||
    (current && next && current.path === next.path && current.metresPerUnit === next.metresPerUnit)
  ) {
    return;
  }
  current = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The published scale, only if it belongs to the DEM at `path`. */
export function useGroundScale(path: string | null): GroundScale | null {
  const scale = useSyncExternalStore(subscribe, () => current);
  return scale && path !== null && scale.path === path ? scale : null;
}
