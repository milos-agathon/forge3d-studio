/**
 * Tests for the viewport map grid (mapGrid.ts).
 *
 * Runs with zero dependencies:
 *   npm test   (node --experimental-strip-types)
 *
 * The golden frame is the Bryce sample DEM: NAD83 / UTM 12N, north-west
 * corner at 395 998.5 E / 4 165 574.5 N, 4000 × 3800 m.
 */
import {
  EDGE_MARGIN,
  formatDistance,
  formatGridValue,
  gridLines,
  mapFrame,
  niceInterval,
} from "./mapGrid.ts";

let failures = 0;

function equal(name: string, actual: unknown, expected: unknown): void {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    failures += 1;
    console.error(`FAIL ${name}: got ${a}, want ${e}`);
  }
}

function truthy(name: string, value: boolean): void {
  if (!value) {
    failures += 1;
    console.error(`FAIL ${name}`);
  }
}

// --- frame -------------------------------------------------------------
const bryce = mapFrame([395_998.5, -4_165_574.5], [4000, 3800]);
equal("bryce west", bryce.west, 395_998.5);
equal("bryce north", bryce.north, 4_165_574.5);
equal("bryce projected", bryce.projected, true);

const local = mapFrame([0, 0], [12_000, 9_000]);
equal("relative frame starts at the south-west corner", [local.west, local.north], [0, 9_000]);
equal("relative frame is not projected", local.projected, false);

// --- interval ----------------------------------------------------------
equal("4 km tile → 1 km grid", niceInterval(4000), 1000);
equal("350 km region → 50 km grid", niceInterval(350_000), 50_000);
equal("12 km → 2 km", niceInterval(12_000), 2000);
equal("900 m → 200 m", niceInterval(900), 200);
equal("degenerate span", niceInterval(0), 1);

// --- lines ---------------------------------------------------------------
const lines = gridLines(bryce, 1000);
// 396 000 E sits 1.5 m inside the west edge: inside the margin, left out.
equal(
  "bryce eastings",
  lines.eastings.map((line) => line.value),
  [397_000, 398_000, 399_000],
);
equal(
  "bryce northings, north first",
  lines.northings.map((line) => line.value),
  [4_165_000, 4_164_000, 4_163_000, 4_162_000],
);
truthy(
  "every line clears the edge margin",
  [...lines.eastings, ...lines.northings].every(
    (line) => line.t >= EDGE_MARGIN && line.t <= 1 - EDGE_MARGIN,
  ),
);
const first = lines.eastings[0];
truthy("easting fraction measured from the west edge", Math.abs(first.t - (397_000 - 395_998.5) / 4000) < 1e-12);
const top = lines.northings[0];
truthy("northing fraction measured from the north edge", Math.abs(top.t - (4_165_574.5 - 4_165_000) / 3800) < 1e-12);

const relative = gridLines(local, niceInterval(12_000));
equal("relative eastings", relative.eastings.map((line) => line.value), [2000, 4000, 6000, 8000, 10_000]);
equal("relative northings", relative.northings.map((line) => line.value), [8000, 6000, 4000, 2000]);

// --- labels --------------------------------------------------------------
equal("projected easting", formatGridValue(397_000, 1000, "E", true), "397 000 mE");
equal("projected northing", formatGridValue(4_165_000, 1000, "N", true), "4 165 000 mN");
equal("relative km", formatGridValue(4000, 2000, "E", false), "4 km");
equal("relative half km", formatDistance(2500, 500), "2 500 m");
equal("relative fractional km", formatDistance(2500, 2500), "2.5 km");

if (failures > 0) {
  throw new Error(`${failures} mapGrid assertion(s) failed`);
}
console.log("mapGrid: all assertions passed");
