"""One GPU gate for every suite that renders through the engine.

Kept out of ``_terrain_runtime`` on purpose: that module's probe spawns a child
interpreter which imports it again, so a module-level probe there would recurse.
"""

import pytest

from _terrain_runtime import terrain_rendering_available

# One probe, one marker: both rendering suites share it.
engine_required = pytest.mark.skipif(
    not terrain_rendering_available(),
    reason="no terrain-safe GPU for the engine's render path",
)
