#!/bin/sh
# The packages never require the engine; they only name the remedy. The shell
# probes `FORGE3D_STUDIO_PYTHON`, ancestors' .venv, then PATH python3/python.
# A first-run machine needs python3 + the engine and its raster/image dependencies.
printf '%s\n' "Forge3D Studio installed. It needs forge3d with Rasterio and Pillow at runtime:"
printf '%s\n' "  python3 -m venv \"\$HOME/forge3d-studio-venv\""
printf '%s\n' "  \"\$HOME/forge3d-studio-venv/bin/python\" -m pip install forge3d rasterio pillow"
printf '%s\n' "  export FORGE3D_STUDIO_PYTHON=\"\$HOME/forge3d-studio-venv/bin/python\""
printf '%s\n' "For desktop-menu launches, set FORGE3D_STUDIO_PYTHON in your desktop environment too."
printf '%s\n' "Verify with:  forge3d-studio-shell --engine-check"
exit 0
