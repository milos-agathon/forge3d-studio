"""Phase 19.2: imported meshes land in the Rendered frame at a known position.

The regression under test is a silent mismatch between the Solid viewport and
the still: a transform that is right in the 12-unit Y-up viewport frame but
wrong in the Z-up metre frame of the MapScene still. A cube placed at the
still's camera aim must appear at the centre of the frame; a model placed
elsewhere must move there. The ablation (remove the mesh from the request)
must return the exact baseline frame.

The affine conversion itself is unit-tested in Rust
(`workspace::tests::mesh_render_matrix_maps_viewport_units_to_the_still_frame`);
this test pins the service that consumes it end to end.
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pytest

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "tests"))

# Every test here renders a still through the engine's native terrain path.
# Hosted runners have no terrain-safe adapter; the hardware lane runs them.
from _engine_gate import engine_required  # noqa: E402


def _service():
    import importlib.util

    source_dir = REPO / "src-tauri" / "src"
    if str(source_dir) not in sys.path:
        sys.path.insert(0, str(source_dir))
    path = source_dir / "studio_render.py"
    spec = importlib.util.spec_from_file_location("studio_render_service", path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def _handoff_meshes(glb: Path) -> list[dict]:
    """The shell's serialized `meshes` payload, with only the path resolved."""
    import json

    entries = json.loads((REPO / "tests" / "fixtures" / "mesh-handoff.json").read_text())
    for entry in entries:
        entry["path"] = str(glb)
    return entries


def _projected_centre(glb: Path, camera: dict, width: int, height: int) -> np.ndarray:
    """Where the fixture's mesh centre must land under this camera.

    Mirrors the service's orbit and the engine's row-major transform.
    """
    import json
    import math

    import forge3d.io as fio

    positions = np.asarray(fio.import_gltf(str(glb)).positions, dtype=np.float64)
    centre = np.append((positions.min(axis=0) + positions.max(axis=0)) * 0.5, 1.0)
    entry = _handoff_meshes(glb)[0]
    matrix = np.asarray(entry["transform"], dtype=np.float64).reshape(4, 4)
    world = (matrix @ centre)[:3]

    azimuth = math.radians(float(camera["phiDeg"]))
    elevation = math.radians(90.0 - float(camera["thetaDeg"]))
    radius = float(camera["radius"])
    eye = np.array([
        radius * math.cos(elevation) * math.cos(azimuth),
        radius * math.cos(elevation) * math.sin(azimuth),
        radius * math.sin(elevation),
    ])
    target = np.asarray(camera["target"], dtype=np.float64)
    forward = eye - target
    forward /= np.linalg.norm(forward)
    right = np.cross([0.0, 0.0, 1.0], forward)
    right /= np.linalg.norm(right)
    up = np.cross(forward, right)
    view = world - eye
    tan_half = math.tan(math.radians(float(camera["fovDeg"])) * 0.5)
    x = (view @ right) / (-(view @ forward) * tan_half)
    y = (view @ up) / (-(view @ forward) * tan_half)
    return np.array([(x * 0.5 + 0.5) * width, (1.0 - (y * 0.5 + 0.5)) * height])


def _decode(service, reply) -> np.ndarray:
    import base64
    import io

    from PIL import Image

    return np.asarray(
        Image.open(io.BytesIO(base64.b64decode(reply["png"]))).convert("RGB"), dtype=np.int32
    )


@engine_required
def test_serialized_handoff_mesh_reaches_the_still(tmp_path):
    from test_gltf_import import _write_material_glb

    service = _service()
    glb = tmp_path / "quad.glb"
    _write_material_glb(glb)

    dem = REPO / "assets" / "tif" / "Mount_Fuji_30m.tif"
    renderer = service.StudioRenderer(str(dem), z_scale=1.0)
    camera = {
        "phiDeg": 90.0,
        "thetaDeg": 45.0,
        "radius": 24000.0,
        "target": [0.0, 0.0, 0.0],
        "fovDeg": 45.0,
    }
    sun = {"azimuthDeg": 315.0, "elevationDeg": 30.0, "intensity": 3.0, "color": [1.0, 0.97, 0.92]}
    base_request = {
        "width": 256,
        "height": 256,
        "camera": dict(camera),
        "sun": dict(sun),
        "exposure": 1.35,
        "quality": {"shadows": True},
    }

    baseline = _decode(service, renderer.render(dict(base_request)))
    with_mesh = dict(base_request, meshes=_handoff_meshes(glb))
    reply = renderer.render(with_mesh)
    image = _decode(service, reply)

    assert reply["meshReport"]["meshesRendered"] == 1, reply["meshReport"]
    diff = np.abs(image - baseline).sum(axis=2)
    changed = diff > 8
    assert int(changed.sum()) > 20, "the imported mesh did not reach the still"

    # The mesh is the shell's serialized payload unchanged. Its pixels must
    # land where the viewport projection says, not just anywhere in frame.
    ys, xs = np.nonzero(changed)
    centroid = np.array([float(xs.mean()), float(ys.mean())])
    expected = _projected_centre(glb, camera, 256, 256)
    assert np.allclose(centroid, expected, atol=7.0), (centroid, expected)

    # Ablation: without the mesh key, the frame is byte-identical to baseline.
    without = renderer.render(dict(base_request))
    assert np.array_equal(_decode(service, without), baseline)


@engine_required
def test_node_scoped_mesh_is_reported_not_silently_rendered(tmp_path):
    from test_gltf_import import _write_material_glb

    service = _service()
    glb = tmp_path / "quad.glb"
    _write_material_glb(glb)
    renderer = service.StudioRenderer(str(REPO / "assets" / "tif" / "Mount_Fuji_30m.tif"), z_scale=1.0)
    request = {
        "width": 128,
        "height": 128,
        "camera": {"phiDeg": 90.0, "thetaDeg": 45.0, "radius": 24000.0, "target": [0, 0, 0], "fovDeg": 45.0},
        "sun": {"azimuthDeg": 315.0, "elevationDeg": 30.0, "intensity": 3.0, "color": [1.0, 0.97, 0.92]},
        "exposure": 1.35,
        "quality": {"shadows": True},
        "meshes": [{**_handoff_meshes(glb)[0], "node": "one-node"}],
    }
    reply = renderer.render(request)
    assert reply["meshReport"]["meshesRendered"] == 0
    assert reply["meshReport"]["meshesSkipped"] == ["one-node"]


@engine_required
def test_off_aim_handoff_mesh_tracks_the_requested_fov(tmp_path):
    """The serialized handoff mesh must move to the requested side of frame,
    and the requested FOV must change that projection. A 50 degree request
    silently rendered at 45 degrees used to pass a loose pixel check."""
    from test_gltf_import import _write_material_glb

    service = _service()
    glb = tmp_path / "quad.glb"
    _write_material_glb(glb)
    renderer = service.StudioRenderer(str(REPO / "assets" / "tif" / "Mount_Fuji_30m.tif"), z_scale=1.0)

    meshes = _handoff_meshes(glb)

    def centroid(fov: float) -> np.ndarray:
        camera = {"phiDeg": 135.0, "thetaDeg": 35.0, "radius": 26000.0,
                  "target": [0.0, 0.0, 0.0], "fovDeg": fov}
        request = {
            "width": 256, "height": 256,
            "camera": camera,
            "sun": {"azimuthDeg": 315.0, "elevationDeg": 30.0,
                    "intensity": 3.0, "color": [1.0, 0.97, 0.92]},
            "exposure": 1.35,
            "quality": {"shadows": True},
            "meshes": meshes,
        }
        reply = renderer.render(request)
        assert reply["meshReport"]["meshesRendered"] == 1
        baseline = renderer.render({key: value for key, value in request.items() if key != "meshes"})
        changed = np.abs(_decode(service, reply) - _decode(service, baseline)).sum(axis=2) > 8
        assert int(changed.sum()) > 20, "the mesh did not reach the preview frame"
        ys, xs = np.nonzero(changed)
        measured = np.array([float(xs.mean()), float(ys.mean())])
        expected = _projected_centre(glb, camera, 256, 256)
        assert np.allclose(measured, expected, atol=7.0), (fov, measured, expected)
        return measured

    narrow, wide = centroid(40.0), centroid(70.0)
    assert narrow[0] < 128.0 < 256.0 - narrow[0], f"wrong side at 40°: {narrow}"
    assert wide[0] < 128.0 < 256.0 - wide[0], f"wrong side at 70°: {wide}"
    assert abs(narrow[0] - 128.0) > abs(wide[0] - 128.0) + 4.0, (
        f"the requested FOV did not move the projection: {narrow}, {wide}"
    )
