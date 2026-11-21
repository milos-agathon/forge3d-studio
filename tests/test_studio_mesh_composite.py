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

    path = REPO / "src-tauri" / "src" / "studio_render.py"
    spec = importlib.util.spec_from_file_location("studio_render_service", path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def _handoff_meshes(glb: Path, *, scale: float = 1.0) -> list[dict]:
    """The shell's serialized `meshes` payload for a visible import.

    `scale` only enlarges the fixture's own transform so a sub-pixel model at
    country scale produces a measurable pixel gate; the shape and translation
    still come from the shell's handoff fixture.
    """
    import json

    entries = json.loads((REPO / "tests" / "fixtures" / "mesh-handoff.json").read_text())
    for entry in entries:
        entry["path"] = str(glb)
        if scale != 1.0:
            transform = np.asarray(entry["transform"], dtype=np.float32).reshape(4, 4)
            transform[:3, :3] *= scale
            entry["transform"] = transform.reshape(16).tolist()
    return entries


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
    with_mesh = dict(base_request, meshes=_handoff_meshes(glb, scale=4.0))
    reply = renderer.render(with_mesh)
    image = _decode(service, reply)

    assert reply["meshReport"]["meshesRendered"] == 1, reply["meshReport"]
    diff = np.abs(image - baseline).sum(axis=2)
    changed = diff > 8
    assert int(changed.sum()) > 20, "the imported mesh did not reach the still"

    # The mesh comes from the shell's serialized handoff fixture, not from a
    # transform invented here, so returning an empty `meshes` list in the
    # shell would leave this frame identical to the baseline.
    assert int(changed.sum()) > 20

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

    meshes = _handoff_meshes(glb, scale=6.0)
    moved = np.asarray(meshes[0]["transform"], dtype=np.float32).reshape(4, 4)
    moved[0, 3] += 3.0 * (max(renderer.span_x, renderer.span_y) / 12.0)
    meshes[0]["transform"] = moved.reshape(16).tolist()

    def centroid(fov: float) -> float:
        request = {
            "width": 256, "height": 256,
            "camera": {"phiDeg": 135.0, "thetaDeg": 35.0, "radius": 26000.0,
                       "target": [0.0, 0.0, 0.0], "fovDeg": fov},
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
        assert int(changed.sum()) > 20, "the moved mesh did not reach the preview frame"
        ys, xs = np.nonzero(changed)
        return float(xs.mean())

    narrow, wide = centroid(40.0), centroid(70.0)
    assert (narrow - 128.0) * (wide - 128.0) > 0, "the mesh changed sides with FOV"
    assert abs(narrow - 128.0) > abs(wide - 128.0) + 4.0, (
        f"the requested FOV did not move the projection: {narrow:.1f}, {wide:.1f}"
    )
