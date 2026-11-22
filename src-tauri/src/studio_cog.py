"""Read an exact COG image directory for the Studio preview and renderer."""

import math
import os
import re
from urllib.parse import urlsplit
from urllib.request import Request, url2pathname, urlopen


def cog_source(url):
    parts = urlsplit(url)
    if parts.scheme == "file":
        host = "//" + parts.netloc if parts.netloc.lower() not in ("", "localhost") else ""
        return host + url2pathname(parts.path)
    return parts.scheme + url[len(parts.scheme):]


def cog_byte_size(url):
    source = cog_source(url)
    if urlsplit(url).scheme == "file":
        size = os.path.getsize(source)
    else:
        request = Request(source, headers={"Range": "bytes=0-0", "Accept-Encoding": "identity"})
        with urlopen(request, timeout=10) as reply:
            match = re.fullmatch(r"bytes 0-0/(\d+)", reply.headers.get("Content-Range", ""))
            if reply.status != 206 or not match or len(reply.read(2)) != 1:
                raise RuntimeError("the COG server did not return a one-byte range and total length")
            size = int(match[1])
    if size <= 0:
        raise RuntimeError("the COG source is empty")
    return size


def dem_footprint(src, *, require_georef):
    """Use the full raster's footprint at every preview resolution."""
    transform = src.transform
    if require_georef and (not src.crs or transform == transform.identity()):
        raise RuntimeError("The GeoTIFF DEM is missing geographic metadata (a CRS and geotransform are required)")
    if not all(math.isfinite(value) for value in transform[:6]) or transform.determinant == 0:
        raise RuntimeError("The GeoTIFF DEM geotransform is invalid")
    origin = [transform.c, -transform.f]
    x_res, y_res = src.res
    span = [x_res * src.width, y_res * src.height]
    if not src.crs:
        return [0.0, 0.0], [float(src.width), float(src.height)], None
    if src.crs.is_geographic:
        from forge3d import gis
        from rasterio.warp import transform_bounds

        wgs84 = transform_bounds(src.crs, "EPSG:4326", *src.bounds)
        zone = gis.estimate_local_utm(wgs84)["crs"]
        left, bottom, right, top = transform_bounds(src.crs, zone, *src.bounds, densify_pts=21)
        return [0.0, 0.0], [right - left, top - bottom], 1.0
    if src.crs.is_projected:
        return origin, span, src.crs.linear_units_factor[1]
    if require_georef:
        raise RuntimeError("The GeoTIFF DEM needs a projected or geographic CRS")
    return origin, span, None


def cog_rasterio():
    try:
        import rasterio
    except ImportError as exc:
        raise RuntimeError(
            "Reading DEMs requires Rasterio. "
            "Run `python -m pip install rasterio` in Studio's Python environment."
        ) from exc
    return rasterio


def cog_path(url):
    source = cog_source(url)
    return "/vsicurl/" + source if urlsplit(url).scheme in ("http", "https") else source


def elevation_band(image):
    import numpy as np

    if image.driver != "GTiff":
        raise RuntimeError(f"Expected a GeoTIFF DEM. The source uses the {image.driver} driver.")
    interpretations = [color.name for color in image.colorinterp]
    bands = [band for band, color in enumerate(interpretations, start=1) if color in ("gray", "undefined")]
    if len(bands) != 1 or any(color not in ("gray", "undefined", "alpha") for color in interpretations):
        raise RuntimeError("Expected a single elevation band in the GeoTIFF DEM. Found bands: " + ", ".join(interpretations))
    band = bands[0]
    if np.dtype(image.dtypes[band - 1]).kind not in "iuf":
        raise RuntimeError("The GeoTIFF DEM elevation band must contain real numeric samples")
    return band


def elevation_metres_per_unit(unit):
    # GDAL band units describe scaled samples independently of horizontal CRS units.
    name = re.sub(r"[\s_()\-]+", " ", (unit or "").casefold()).strip()
    if name in ("", "m", "metre", "metres", "meter", "meters"):
        return 1.0
    if name in ("ft", "foot", "feet", "international foot", "international feet", "ft international", "foot international"):
        return 0.3048
    if name in ("ftus", "us ft", "ft us", "foot us", "us survey foot", "us survey feet", "ft us survey", "survey foot"):
        return 1200.0 / 3937.0
    metric = {"km": 1000.0, "cm": 0.01, "mm": 0.001}
    if name in metric:
        return metric[name]
    raise RuntimeError(f"Unsupported DEM elevation band unit {unit!r}")


def cog_info(url):
    import numpy as np

    rasterio = cog_rasterio()
    size = cog_byte_size(url)
    source = cog_path(url)
    compression_codes = {"LZW": 5, "JPEG": 7, "DEFLATE": 8, "ZSTD": 50000}

    def describe(image, level, band):
        tile_height, tile_width = image.block_shapes[band - 1]
        across = (image.width + tile_width - 1) // tile_width
        down = (image.height + tile_height - 1) // tile_height
        bits = image.tags(band, ns="IMAGE_STRUCTURE").get("NBITS") or 8 * np.dtype(image.dtypes[band - 1]).itemsize
        compression = compression_codes.get(image.compression.value.upper(), 0) if image.compression else 1
        return {
            "level": level, "width": image.width, "height": image.height,
            "tileWidth": tile_width, "tileHeight": tile_height, "tilesAcross": across, "tilesDown": down,
            "tiles": across * down, "compression": compression, "bitsPerSample": int(bits),
        }

    with rasterio.Env(GDAL_DISABLE_READDIR_ON_OPEN="EMPTY_DIR"):
        with rasterio.open(source) as base:
            band = elevation_band(base)
            elevation_metres_per_unit(base.units[band - 1])
            dem_footprint(base, require_georef=True)
            levels = [describe(base, 0, band)]
            for index in range(len(base.overviews(band))):
                with rasterio.open(source, OVERVIEW_LEVEL=index) as image:
                    levels.append(describe(image, index + 1, band))
            return {
                "byteSize": size, "overviewCount": len(levels), "bounds": list(base.bounds),
                "streamable": True, "levels": levels, "totalTiles": sum(level["tiles"] for level in levels),
            }


def read_cog_overview(url, resolution):
    return read_dem_overview(cog_path(url), resolution, remote=True)


def read_dem_overview(source, resolution=None, *, remote=False):
    """Decode physical elevations from the base raster or a suitable overview."""
    rasterio = cog_rasterio()
    # HTTP sources use internal IFDs and must not probe for sibling files.
    options = {"GDAL_DISABLE_READDIR_ON_OPEN": "EMPTY_DIR"} if remote else {}
    with rasterio.Env(**options):
        with rasterio.open(source) as base:
            band = elevation_band(base) if remote else 1
            origin, span, units = dem_footprint(base, require_georef=remote)
            count = len(base.overviews(band))
            scale = base.scales[band - 1]
            offset = base.offsets[band - 1]
            metres_per_unit = elevation_metres_per_unit(base.units[band - 1])
            if not (math.isfinite(scale) and math.isfinite(offset)):
                raise RuntimeError("The GeoTIFF DEM elevation band has an invalid scale or offset")

            def read_grid(image):
                # The full-resolution band's encoding also applies to its overview IFDs.
                raw = image.read(band, masked=True, out_dtype="float64").filled(float("nan"))
                return (raw * scale + offset) * metres_per_unit

            metadata = {
                "width": base.width, "height": base.height, "bounds": list(base.bounds),
                "crs": str(base.crs), "originXz": origin, "spanXz": span, "spanMetresPerUnit": units,
                "extentMeters": [side * units for side in span] if units is not None else None,
                "geographic": bool(base.crs and base.crs.is_geographic),
                "overviewCount": count + 1,
            }
            # Open the actual overview IFD as the dataset. Forge3D 1.49's
            # read_tile(..., lod) can select the base IFD for an overview LOD.
            if resolution is not None:
                for index in reversed(range(count)):
                    with rasterio.open(source, OVERVIEW_LEVEL=index) as image:
                        if min(image.width, image.height) >= resolution:
                            return read_grid(image), index + 1, metadata
            return read_grid(base), 0, metadata


def sample_dem(grid, resolution, empty_message):
    import numpy as np

    height, width = grid.shape
    values = grid[np.isfinite(grid)]
    if not values.size:
        raise RuntimeError(empty_message)
    low, high = np.percentile(values, [0.01, 99.99])
    ys = np.linspace(0, height, resolution + 1).astype(int)
    xs = np.linspace(0, width, resolution + 1).astype(int)
    out = np.empty((resolution, resolution), dtype="float64")
    for j in range(resolution):
        for i in range(resolution):
            block = grid[ys[j]:max(ys[j] + 1, ys[j + 1]), xs[i]:max(xs[i] + 1, xs[i + 1])]
            good = block[np.isfinite(block)]
            out[j, i] = float(np.clip(good.mean(), low, high)) if good.size else float(low)
    return {
        "ok": True, "resolution": resolution,
        "minElevation": float(low), "maxElevation": float(high),
        "heights": [round(float(value), 2) for value in out.ravel()],
        "outliers": int(np.count_nonzero((values < low) | (values > high))),
    }
