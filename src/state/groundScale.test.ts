import { footprintLabel, groundSpanMetres, reliefPercent } from "./groundScale.ts";

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(`groundScale: ${message}`);
}
const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;
const km = (metres: number) => `${(metres / 1000).toFixed(1)} km`;
const labels = { unknown: "unknown scale", pending: "—" };

// Bryce, EPSG:26912: metres.
const utm = { path: "bryce.tif", metresPerUnit: 1 };
check(footprintLabel([4000, 3800], utm, km, labels) === "4.0 km × 3.8 km", "UTM footprint");

// EPSG:2263, US survey feet: 4000 × 3800 ft is 1.2 × 1.2 km, not 4.0 × 3.8.
const feet = { path: "ny.tif", metresPerUnit: 0.30480060960121924 };
const feetMetres = groundSpanMetres([4000, 3800], feet);
check(feetMetres !== null && near(feetMetres[0], 1219.202438404877), "feet east side in metres");
check(feetMetres !== null && near(feetMetres[1], 1158.2423164846332), "feet north side in metres");
check(footprintLabel([4000, 3800], feet, km, labels) === "1.2 km × 1.2 km", "feet footprint");

// No CRS: a span in pixels is never printed as metres.
const none = { path: "plain.tif", metresPerUnit: null };
check(groundSpanMetres([40, 38], none) === null, "unknown scale has no metres");
check(footprintLabel([40, 38], none, km, labels) === "unknown scale", "unknown footprint wording");
check(reliefPercent([0, 10], [40, 38], none) === null, "no relief % without a ground scale");

// Not sampled yet.
check(footprintLabel([4000, 3800], null, km, labels) === "—", "pending footprint");

// Relief against the ground span: 450 m over 4000 m is 11.25 %; the same
// span in feet is 1219 m, so 36.9 %, not 11.25 %.
check(near(reliefPercent([2101, 2551], [4000, 3800], utm) ?? NaN, 11.25), "UTM relief %");
check(near(reliefPercent([2101, 2551], [4000, 3800], feet) ?? NaN, (450 / 1219.202438404877) * 100), "feet relief %");

console.log("groundScale: all assertions passed");
