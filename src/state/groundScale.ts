/**
 * Ground scale: what one unit of a terrain's stored span is on the ground.
 *
 * The project stores `worldSpanXz` in the DEM's own CRS unit (the render path
 * frames with it): metres for UTM, US survey feet for EPSG:2263, pixels for a
 * raster with no CRS. Every readout that prints metres or kilometres must
 * convert through this, and say so when the scale is unknown instead of
 * guessing. Pure: runs under `node --experimental-strip-types`.
 */

/** One sampled DEM's scale. `metresPerUnit` null = unknown (no or unnamed CRS). */
export interface GroundScale {
  path: string;
  metresPerUnit: number | null;
}

/** The span in ground metres, or null when the scale is unknown or pending. */
export function groundSpanMetres(
  span: [number, number] | null,
  scale: GroundScale | null,
): [number, number] | null {
  if (!span || !scale || scale.metresPerUnit === null) return null;
  return [span[0] * scale.metresPerUnit, span[1] * scale.metresPerUnit];
}

/**
 * A footprint readout: `format` prints one side in ground metres. An unknown
 * scale gives `unknown` (the caller's wording, e.g. the pixel size); a
 * pending one (not sampled yet) gives `pending`.
 */
export function footprintLabel(
  span: [number, number] | null,
  scale: GroundScale | null,
  format: (metres: number) => string,
  { unknown, pending }: { unknown: string | null; pending: string | null },
): string | null {
  if (!span) return pending;
  if (!scale) return pending;
  const metres = groundSpanMetres(span, scale);
  if (!metres) return unknown;
  return metres.map(format).join(" × ");
}

/** Relief as a percentage of the longer ground side; null when unknown. */
export function reliefPercent(
  elevationRange: [number, number] | null,
  span: [number, number] | null,
  scale: GroundScale | null,
): number | null {
  const metres = groundSpanMetres(span, scale);
  if (!elevationRange || !metres) return null;
  return ((elevationRange[1] - elevationRange[0]) / Math.max(metres[0], metres[1])) * 100;
}
