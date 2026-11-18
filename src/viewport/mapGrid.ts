/**
 * The map grid: the viewport's replacement for a modelling grid on terrain
 * scenes. Lines run at round map coordinates (eastings and northings in the
 * DEM's own projected metres, like the kilometre grid of a topographic map),
 * so the grid says where the ground is, not where a unitless origin sits.
 *
 * Pure maths, no three.js: the drape and the rulers are built on top of this
 * in mapGridLayer.ts. Runs under `node --experimental-strip-types`.
 */

/** Where the terrain sits on the map, in metres. */
export interface MapFrame {
  /** Easting of the west edge. */
  west: number;
  /** Northing of the north edge. */
  north: number;
  /** East–west extent. */
  spanX: number;
  /** North–south extent. */
  spanZ: number;
  /**
   * True when the DEM carried a projected origin: the values are real
   * eastings and northings. False (geographic or CRS-less DEMs, whose origin
   * the shell reports as 0, 0) falls back to distances from the south-west
   * corner, which are still true ground metres.
   */
  projected: boolean;
}

/** One grid line: its map value and where it crosses the terrain, 0..1. */
export interface GridLine {
  value: number;
  /** Eastings: fraction east of the west edge. Northings: fraction south of the north edge. */
  t: number;
}

/** Lines closer than this (as a fraction of the extent) to an edge are left
 *  out: the edge already marks them and their labels would collide at the
 *  corner. */
export const EDGE_MARGIN = 0.02;

/**
 * The terrain's map frame from the project's viewer-basis origin
 * (`[mapX, -mapY]` of the north-west corner) and span, both metres.
 */
export function mapFrame(originXz: [number, number], spanXz: [number, number]): MapFrame {
  const [spanX, spanZ] = spanXz;
  const projected = originXz[0] !== 0 || originXz[1] !== 0;
  if (!projected) {
    return { west: 0, north: spanZ, spanX, spanZ, projected: false };
  }
  return { west: originXz[0], north: -originXz[1], spanX, spanZ, projected: true };
}

/**
 * A round line spacing: the largest 1, 2 or 5 × 10^k metres that still puts
 * at least `minLines` lines across the longer side. A 4 km tile gets a 1 km
 * grid, a 350 km region a 50 km one.
 */
export function niceInterval(span: number, minLines = 4): number {
  if (!(span > 0)) return 1;
  const target = span / minLines;
  const decade = 10 ** Math.floor(Math.log10(target));
  for (const step of [5, 2, 1]) {
    if (step * decade <= target) return step * decade;
  }
  return decade;
}

/** The grid lines that cross the frame at `interval` metres. */
export function gridLines(
  frame: MapFrame,
  interval: number,
): { eastings: GridLine[]; northings: GridLine[] } {
  const eastings: GridLine[] = [];
  const northings: GridLine[] = [];
  const east = frame.west + frame.spanX;
  for (let value = Math.ceil(frame.west / interval) * interval; value <= east; value += interval) {
    const t = (value - frame.west) / frame.spanX;
    if (t >= EDGE_MARGIN && t <= 1 - EDGE_MARGIN) eastings.push({ value, t });
  }
  const south = frame.north - frame.spanZ;
  for (let value = Math.ceil(south / interval) * interval; value <= frame.north; value += interval) {
    const t = (frame.north - value) / frame.spanZ;
    if (t >= EDGE_MARGIN && t <= 1 - EDGE_MARGIN) northings.push({ value, t });
  }
  // North to south reads top to bottom on a north-up map.
  northings.reverse();
  return { eastings, northings };
}

/** Digit groups with a narrow no-break space, the way map grids print them. */
function grouped(value: number): string {
  const digits = Math.round(Math.abs(value)).toString();
  const groups: string[] = [];
  for (let end = digits.length; end > 0; end -= 3) {
    groups.unshift(digits.slice(Math.max(0, end - 3), end));
  }
  return `${value < 0 ? "−" : ""}${groups.join(" ")}`;
}

/** A distance in the unit a reader expects at this spacing. */
export function formatDistance(metres: number, interval: number): string {
  if (interval >= 1000) {
    const km = metres / 1000;
    return `${Number.isInteger(km) ? km.toFixed(0) : km.toFixed(1)} km`;
  }
  return `${grouped(metres)} m`;
}

/**
 * A ruler label. Projected frames print full eastings and northings with the
 * map-grid suffixes mE / mN; relative frames print the distance from the
 * south-west corner.
 */
export function formatGridValue(
  value: number,
  interval: number,
  axis: "E" | "N",
  projected: boolean,
): string {
  if (projected) return `${grouped(value)} m${axis}`;
  return formatDistance(value, interval);
}
