import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

// 192 columns by 96 rows, two source pixels per preview column. The north
// and south edges have distinct elevations and the maximum is off-centre.
const writeRasters = `
import numpy as np, rasterio, sys
from pathlib import Path
from rasterio.transform import from_origin
a = np.full((96, 96), 10, dtype="float32")
a[0, 0], a[0, -1], a[-1, 0], a[-1, -1] = 11, 14, 17, 22
a[19, 70] = 29
for name, grid in [("peak", a), ("flat", np.full(a.shape, 3210.1234)), ("overlay", a), ("edge", a),
                   ("edgeShort", a), ("edgeWide", a), ("scaledMiss", a), ("scaledLeak", a),
                   ("translatedNorth", a), ("halfHover", np.where(np.indices(a.shape)[1] < 48, 100, 101.5).astype("float32"))]:
    data = np.repeat(grid, 2, axis=1)
    if name not in ("flat", "halfHover"):
        # Additional high source pixels keep the percentile at 29. Only the
        # two-pixel block at (19, 70) averages to that peak in the preview.
        data[20, 138] = data[20, 142] = 29
    spacing = {"overlay": (2, 1.25), "edge": (25/192, 7/96),
               "edgeShort": (171.2/192, 85.6/96), "edgeWide": (25.1/192, 12.55/96),
               "scaledMiss": (84/192,61/96), "scaledLeak": (42/192,29/96),
               "translatedNorth": (5/192,2/96), "halfHover": (10/192,5/96)}.get(name, (14, 10))
    with rasterio.open(Path(sys.argv[1]) / (name + ".tif"), "w", driver="GTiff",
                       width=192, height=96, dtype=grid.dtype, count=1, crs="EPSG:2229" if name == "overlay" else "EPSG:32612",
                       transform=from_origin(400000, 4100000, *spacing)) as dst:
        dst.write(data, 1)
for name, low, high, sx, sz in [
    ("level", 4096, 4096, 12, 6), ("collapsed", 4096, 4096.0001, 12, 6),
    ("fractional", 4150.24, 4150.25, 2, 1), ("rounded", 100.004, 100.304, 12, 6),
    ("upperRounded", 100.004, 100.306, 12, 6), ("rawFormula", 0, 0.31, 12, 6),
    ("twoPlateaux", 4150.24, 4151.24, 2, 1),
    ("budget", 3210.1234, 3210.1234, 2, 1), ("relative", 0, 0.01, 2, 1),
    ("threshold", 4096.0049, 4096.0051, 2, 1), ("clip", 100, 101.499, 12, 6),
    ("admit", 4150.24, 4151.24, 2, 1), ("roundFlat", 4096.006, 4096.006, 2, 1), ("roundNear", 4096.006, 4096.0061, 2, 1)
]:
    data = np.full((256,512), low, dtype="float64")
    data[:,256:] = high
    if name == "admit": data[:,2:4] = 4150.25
    with rasterio.open(Path(sys.argv[1]) / (name + ".tif"), "w", driver="GTiff",
                       width=512, height=256, count=1, dtype=data.dtype, crs="EPSG:32612",
                       transform=from_origin(400000,4100000,sx/512,sz/256)) as dst:
        dst.write(data, 1)
`;

export async function fixtures(root, dir) {
  execFileSync(process.env.FORGE3D_STUDIO_PYTHON ?? "python", ["-c", writeRasters, dir]);
  const src = JSON.parse(await readFile(join(root, "samples/bryce-terrain.studio3d"), "utf8"));
  const result = {};
  for (const [name, raster, zScale, scale] of [
    ["bryce", "bryce", 1, 1], ["identity", "peak", 1, 1], ["placed", "peak", 1, 1.25],
    ["flat", "flat", 1, 1], ["flatPlaced", "flat", 3, 1.25],
    ["overlay", "overlay", 1, 1.25], ["translated", "peak", 1, 1.25], ["edge", "edge", 1, 1.5],
    ["edgeShort", "edgeShort", 1, 1], ["edgeWide", "edgeWide", 1, 1],
    ["scaledMiss", "scaledMiss", 1, 7], ["scaledLeak", "scaledLeak", 1, 7],
    ["translatedNorth", "translatedNorth", 1, 1], ["halfHover", "halfHover", 1, 1],
    ["rawFormula", "rawFormula", 10, 1], ["twoPlateaux", "twoPlateaux", 20, 1],
    ["roundFlat", "roundFlat", 20, 1], ["roundNear", "roundNear", 20, 1], ["roundRaised", "roundFlat", 20, 1],
    ["relative", "relative", 20, 1], ["relativeSmall", "relative", 0.4, 1], ["threshold", "threshold", 20, 1],
    ["clip", "clip", 1, 1], ["admit", "admit", 20, 1], ["farEdge", "level", 1, 1],
    ["level", "level", 1, 1], ["collapsed", "collapsed", 1, 1], ["lifted", "level", 1, 1],
    ["fractional", "fractional", 20, 1], ["rounded", "rounded", 10, 1], ["upperRounded", "upperRounded", 10, 1], ["budget", "budget", 50, 1],
  ]) {
    const project = structuredClone(src);
    project.name = "VP-04 " + name;
    project.id = randomUUID();
    Object.assign(project.viewport, { mode: "solid", gridVisible: false, hillshade: false });
    Object.assign(project.render, { shadows: false, sunVisibility: false, environment: null });
    const terrain = project.scene.objects.find(o => o.kind.type === "terrain");
    const asset = project.assets.find(a => a.id === terrain.kind.asset);
    asset.path = raster === "bryce" ? resolve(root, "samples", asset.path) : join(dir, raster + ".tif");
    asset.byteSize = (await stat(asset.path)).size;
    project.assets = [asset];
    delete terrain.kind.overlay;
    terrain.kind.zScale = zScale;
    if (raster !== "bryce") Object.assign(terrain.kind, { dimensions: [192, 96],
      worldSpanXz: raster === "overlay" ? [384, 120] : [2688, 960], worldOriginXz: [400000, -4100000],
      elevationRange: raster === "flat" ? [3210.1234, 3210.1234] : [10, 29] });
    if (scale !== 1) {
      terrain.transform.translation = { x: 1.5, y: 2, z: -0.75 };
      terrain.transform.scale = { x: scale, y: scale, z: scale };
    }
    if (name === "translated") terrain.transform.translation.z = 42;
    if (name === "edge") {
      terrain.transform.translation = {x:0,y:0,z:42};
      terrain.kind.worldSpanXz = [25,7];
    }
    if (name === "edgeShort") terrain.kind.worldSpanXz = [171.2, 85.6];
    if (name === "edgeWide") terrain.kind.worldSpanXz = [25.1, 12.55];
    if (name === "scaledMiss" || name === "scaledLeak") {
      terrain.kind.worldSpanXz = name === "scaledMiss" ? [84,61] : [42,29];
      terrain.transform.translation = {x:0,y:0,z:0};
    }
    if (name === "translatedNorth") {
      terrain.kind.worldSpanXz = [5,2];
      terrain.transform.translation.z = 3;
    }
    if (name === "halfHover") Object.assign(terrain.kind, {worldSpanXz:[10,5], elevationRange:[100,101.5]});
    if (name === "rawFormula") terrain.transform.translation.y = -0.04;
    if (name === "roundRaised") terrain.transform.translation.y = 0.46875;
    if (name === "farEdge") terrain.transform.translation.x = 4_000_000_000;
    if (name === "lifted") terrain.transform.translation.y = 0.5;
    const ranges = { level: [4096,4096], collapsed: [4096,4096.0001], rounded: [100.004,100.304], upperRounded: [100.004,100.306],
      rawFormula: [0, 0.31], twoPlateaux: [4150.24, 4151.24],
      threshold:[4096.0049,4096.0051], admit:[4150.24,4151.24], clip:[100,101.499], relative: [0,0.01], roundFlat: [4096.006,4096.006], roundNear: [4096.006,4096.0061],
      fractional: [4150.24,4150.25], budget: [3210.1234,3210.1234] };
    if (ranges[raster]) Object.assign(terrain.kind, { dimensions: [512,256], spanMetresPerUnit: 1,
      worldSpanXz: ["budget","fractional","relative","roundNear","roundFlat","threshold","admit","twoPlateaux"].includes(raster) ? [2,1] : [12,6], elevationRange: ranges[raster] });
    if (name === "overlay" || name === "budget" || name === "twoPlateaux") {
      const survey = name === "overlay";
      terrain.kind.spanMetresPerUnit = survey ? 1200 / 3937 : 1;
      const peak = survey ? [400000 + 384 * 70 / 95, 4100000 - 120 * 19 / 95]
        : name === "twoPlateaux" ? [400000,4100000] : [400001,4099999.5];
      const end = survey ? [400384,4099880] : [400001.5,4099999.5];
      const path = join(dir, name + "-landmarks.geojson");
      await writeFile(path, JSON.stringify({ type: "FeatureCollection",
        crs: { type: "name", properties: { name: survey ? "EPSG:2229" : "EPSG:32612" } }, features: [
          { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: [peak, end] } },
          { type: "Feature", properties: { name: "Peak" }, geometry: { type: "Point", coordinates: peak } },
        ] }));
      const vector = { id: randomUUID(), name: "Landmarks", kind: "vector", path, byteSize: (await stat(path)).size };
      project.assets.push(vector);
      const line = { id: randomUUID(), name: "Line", type: "vector", asset: vector.id, colour: [1, 1, 1, 1], widthPx: 2 };
      project.cartography = [line, { id: randomUUID(), name: "Label", type: "labels", source: line.id,
        field: "name", colour: [1, 1, 1, 1], sizePx: 13 }];
    }
    const path = join(dir, name + ".studio3d");
    await writeFile(path, JSON.stringify(project));
    result[name] = { id: project.id, path, raster, scale, zScale };
  }
  return result;
}
