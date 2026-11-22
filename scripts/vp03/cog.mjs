import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { sha256 } from "./identity.mjs";

const reviewCog = "a64100d4047907354f0e11205450da88ae8add4445602bd74641cac900130820";

export async function cogFixture(dem, dir, supplied) {
  const path = supplied ? resolve(supplied) : join(dir, "bryce-plus500-cog.tif");
  const script = `
import json, sys
import numpy as np
import rasterio
from rasterio.io import MemoryFile
from rasterio.shutil import copy
from rasterio.enums import Resampling

dem, path, make = sys.argv[1:]
if make == "yes":
    with rasterio.open(dem) as src:
        data = src.read(1, masked=True).astype("float32") + 500
        profile = dict(src.profile, driver="GTiff", count=1, dtype="float32", nodata=-9999)
        with MemoryFile() as memory:
            with memory.open(**profile) as raster:
                raster.write(data.filled(-9999), 1)
                copy(raster, path, driver="COG", BLOCKSIZE=128, COMPRESS="DEFLATE", OVERVIEW_RESAMPLING="AVERAGE")

# Read the file's full-footprint 128 x 128 overview as an independent oracle
# for the four bins sampled by the query at the center of a 96 x 96 grid.
with rasterio.open(path) as src:
    assert (src.width, src.height) == (1024, 1024) and 8 in src.overviews(1)
    raw = src.read(1, out_shape=(128, 128), masked=True, resampling=Resampling.nearest).astype("float64")
    finite = raw.compressed()
    low, high = np.percentile(finite[np.isfinite(finite)], [0.01, 99.99])
    cells = []
    for row in (47, 48):
        for col in (47, 48):
            values = raw[row * 128 // 96:(row + 1) * 128 // 96, col * 128 // 96:(col + 1) * 128 // 96]
            cells.append(round(float(np.clip(values.mean(), low, high)), 2))
    print(json.dumps({"dimensions": [src.width, src.height], "overview": [128, 128], "cells": cells,
        "elevation": sum(cells) / 4, "origin": [src.transform.c, -src.transform.f],
        "span": [src.width * src.res[0], src.height * src.res[1]]}))
`;
  const oracle = JSON.parse(execFileSync(process.env.FORGE3D_STUDIO_PYTHON || "python", [
    "-c", script, dem, path, supplied ? "no" : "yes",
  ], { encoding: "utf8", windowsHide: true, timeout: 30_000 }));
  const bytes = await readFile(path);
  const fixture = { path, byteSize: bytes.length, sha256: sha256(bytes), oracle };
  if (fixture.sha256 === reviewCog) assert.ok(Math.abs(oracle.elevation - 2779.955) < 1e-6);
  return fixture;
}

export async function terrainControls(dem, dir) {
  const names = { hiddenSmall: "hidden-128.tif", raised: "bryce-raised.tif", east: "east.tif", west: "west.tif", centerEast: "east-shared.tif", centerWest: "west-shared.tif",
    queryOld: "query-old.tif", queryNew: "query-new.tif",
    below: "span-47760.tif", boundary: "span-48000.tif", wide: "span-112363.tif",
    png: "ordinary-rgb.png", rgb: "rgb.tif", rgbCog: "rgb-cog.tif", intensity: "intensity-nogeo.tif",
    nodata: "all-nodata.tif", metres: "real-metres.tif", packed: "packed-metres.tif", feet: "survey-feet.tif", verticalFeet: "vertical-feet.tif" };
  const script = `
import sys
from pathlib import Path
import numpy as np
import rasterio
from PIL import Image
from rasterio.io import MemoryFile
from rasterio.shutil import copy
from rasterio.transform import from_origin

dem, destination = sys.argv[1:]
directory = Path(destination)
with rasterio.open(dem) as source:
    transform = from_origin(source.transform.c, source.transform.f, 4000 / 96, 3800 / 96)
    crs = source.crs
    with rasterio.open(directory / "bryce-raised.tif", "w", **source.profile) as raised:
        raised.write((source.read(1, masked=True) + 512).filled(source.nodata), 1)
profile = dict(driver="GTiff", width=96, height=96, count=1, dtype="float32", crs=crs, transform=transform, nodata=-9999)
x = np.linspace(0, 2 * np.pi, 96)
z = np.linspace(0, np.pi, 96)
heights = (2000 + 95 * np.sin(z)[:, None] * np.sin(x)[None, :]).astype("float32")
def write_dem(name, values, options):
    with rasterio.open(directory / name, "w", **options) as raster:
        raster.write(values, 1)

def write_cog(name, values, options, scale=1.0, offset=0.0, unit=None):
    with MemoryFile() as memory:
        with memory.open(**options) as raster:
            raster.write(values, 1)
            raster.scales = (scale,)
            raster.offsets = (offset,)
            if unit:
                raster.set_band_unit(1, unit)
            copy(raster, directory / name, driver="COG", BLOCKSIZE=128, COMPRESS="DEFLATE", OVERVIEW_RESAMPLING="AVERAGE")

with rasterio.open(dem) as source:
    hidden = source.read(1, out_shape=(128, 128)).astype("float32")
    small_profile = dict(profile, width=128, height=128, transform=source.transform * source.transform.scale(source.width / 128, source.height / 128))
    write_dem("hidden-128.tif", hidden, small_profile)

for span in (47760, 48000, 112363):
    scaled = from_origin(395000, 4160000, span / 96, span * 0.9 / 96)
    write_dem(f"span-{span}.tif", heights, dict(profile, transform=scaled))

for name, values in [("east", heights), ("west", heights[:, ::-1])]:
    write_dem(f"{name}.tif", values, profile)
    shared = values.copy()
    shared[42:54, 42:54] = 2000
    write_dem(f"{name}-shared.tif", shared, profile)
    shared[42:54, 41:70] = 2000
    write_dem("query-old.tif" if name == "east" else "query-new.tif", shared, profile)

intensity_y, intensity_x = np.mgrid[:96, :96]
write_cog("intensity-nogeo.tif", (intensity_x * 5).astype("uint8"),
          dict(driver="GTiff", width=96, height=96, count=1, dtype="uint8"))
write_cog("all-nodata.tif", np.full((96, 96), -9999, dtype="int16"), dict(profile, dtype="int16"))

# A common 96 x 96 overview encoded as physical floats and packed integers.
raw = (510 + intensity_x + intensity_y).astype("int16").repeat(2, axis=0).repeat(2, axis=1)
raw[:2, :2] = -9999
physical = np.where(raw == -9999, -9999, raw * 0.5 + 1000).astype("float32")
metre_profile = dict(profile, width=192, height=192, transform=from_origin(395000, 4160000, 20, 20))
write_cog("real-metres.tif", physical, metre_profile, unit="m")
# Both the encoded scale and offset are in feet, on a horizontal metre CRS.
vertical_feet = np.where(raw == -9999, -9999, (physical.astype("float64") / 0.3048 - 1000) / 2)
write_cog("vertical-feet.tif", vertical_feet, dict(metre_profile, dtype="float64"), 2, 1000, "ft")
write_cog("packed-metres.tif", raw, dict(metre_profile, dtype="int16"), 0.5, 1000.0)
survey_foot = 1200 / 3937
foot_crs = rasterio.crs.CRS.from_string("+proj=utm +zone=12 +datum=WGS84 +units=us-ft")
feet_profile = dict(metre_profile, crs=foot_crs,
    transform=from_origin(395000 / survey_foot, 4160000 / survey_foot, 20 / survey_foot, 20 / survey_foot))
write_cog("survey-feet.tif", physical, feet_profile)

rgb = np.zeros((64, 96, 3), "uint8")
rgb[:, :, 0] = np.arange(96, dtype="uint8")
rgb[:, :, 1:] = [80, 200]
Image.fromarray(rgb).save(directory / "ordinary-rgb.png")

y, x = np.mgrid[:192, :256]
colors = np.array([x, y, x + y], dtype="uint8")
image_profile = dict(driver="GTiff", width=256, height=192, count=3, dtype="uint8", photometric="RGB",
    transform=from_origin(395000, 4160000, 20, 20))
with rasterio.open(directory / "rgb.tif", "w", **image_profile) as raster:
    raster.write(colors)
with MemoryFile() as memory:
    with memory.open(**image_profile, crs=crs) as raster:
        raster.write(colors)
        copy(raster, directory / "rgb-cog.tif", driver="COG", BLOCKSIZE=128, COMPRESS="DEFLATE")
`;
  execFileSync(process.env.FORGE3D_STUDIO_PYTHON || "python", ["-c", script, dem, dir],
    { windowsHide: true, timeout: 30_000 });
  return Object.fromEntries(await Promise.all(Object.entries(names).map(async ([name, file]) => {
    const path = join(dir, file);
    return [name, { path, sha256: sha256(await readFile(path)) }];
  })));
}

export async function serveCog(path) {
  const bytes = await readFile(path);
  const ranges = [];
  let available = true;
  const server = createServer((req, res) => {
    if (req.url !== "/bryce-plus500-cog.tif") { res.writeHead(404); res.end(); return; }
    if (!available) {
      ranges.push({ method: req.method, range: req.headers.range, status: 503, bytes: 0 });
      res.writeHead(503);
      res.end();
      return;
    }
    const headers = { "Accept-Ranges": "bytes", "Content-Type": "image/tiff", "Content-Length": bytes.length };
    const range = req.headers.range;
    let status = 200;
    let payload;
    if (req.method !== "HEAD") {
      const parsed = /^bytes=(\d+)-(\d*)$/.exec(range ?? "");
      const start = parsed && Number(parsed[1]);
      const end = parsed && (parsed[2] ? Math.min(Number(parsed[2]), bytes.length - 1) : bytes.length - 1);
      if (req.method !== "GET" || !parsed || start > end) {
        status = 416;
        headers["Content-Length"] = 0;
        headers["Content-Range"] = `bytes */${bytes.length}`;
      } else {
        status = 206;
        payload = bytes.subarray(start, end + 1);
        headers["Content-Length"] = payload.length;
        headers["Content-Range"] = `bytes ${start}-${end}/${bytes.length}`;
      }
    }
    ranges.push({ method: req.method, range, status, bytes: payload?.length ?? 0 });
    res.writeHead(status, headers);
    res.end(payload);
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  return { url: `http://127.0.0.1:${server.address().port}/bryce-plus500-cog.tif`, ranges,
    setAvailable(value) { available = value; }, close: () => server.close() };
}
