import type { TerrainPreview } from "../bridge/types";
import { terrainGroundSpan } from "./forge3dWebMapping";

function computeHillshadeTexel(
  dzDx: number,
  dzDy: number,
  azimuth: number,
  zenith: number,
): number {
  const slope = Math.atan(Math.sqrt(dzDx * dzDx + dzDy * dzDy));
  // ArcGIS aspect convention: 0 = north, clockwise.
  const aspect = Math.atan2(dzDy, -dzDx);
  const value = Math.cos(zenith) * Math.cos(slope) +
                Math.sin(zenith) * Math.sin(slope) * Math.cos(azimuth - aspect);
  return Math.max(0, Math.min(255, Math.floor(value * 255)));
}

/** Bake a hillshade texture from the heights: central differences, metric
 *  cell size from the footprint, 315° az / 45° alt, no exaggeration. */
export function hillshadePixels(preview: TerrainPreview): Uint8Array {
  const resolution = preview.resolution;
  const heights = preview.heights;
  const [spanX, spanZ] = terrainGroundSpan(preview);
  const cellX = spanX / Math.max(1, resolution - 1);
  const cellY = spanZ / Math.max(1, resolution - 1);
  const azimuth = (315 * Math.PI) / 180;
  // Zenith angle from the vertical, the ESRI formula: matches the standard
  // "QGIS / ArcGIS" relief shades (SE-lit slopes face dark).
  const zenith = (45 * Math.PI) / 180;
  const data = new Uint8Array(resolution * resolution * 4);
  for (let row = 0; row < resolution; row += 1) {
    for (let column = 0; column < resolution; column += 1) {
      const left = column === 0 ? heights[row * resolution + column]
                                : heights[row * resolution + column - 1];
      const right = column === resolution - 1 ? heights[row * resolution + column]
                                : heights[row * resolution + column + 1];
      const up = row === 0 ? heights[row * resolution + column]
                          : heights[(row - 1) * resolution + column];
      const down = row === resolution - 1 ? heights[row * resolution + column]
                          : heights[(row + 1) * resolution + column];
      const dzDx = (right - left) / (2 * cellX);
      const dzDy = (down - up) / (2 * cellY);
      const value = computeHillshadeTexel(dzDx, dzDy, azimuth, zenith);
      // PlaneGeometry UVs follow row order; match the mesh's own indexing.
      // RGBA: three.js .map sampling expects channels the material can read;
      // replicate the grey into R/G/B so it multiplies cleanly in the shader.
      const base = (row * resolution + column) * 4;
      data[base] = value;
      data[base + 1] = value;
      data[base + 2] = value;
      data[base + 3] = 255;
    }
  }
  return data;
}
