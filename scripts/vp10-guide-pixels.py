"""Measure the visible held guide on both desktop surfaces away from the cube."""
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image

directory = Path(sys.argv[1])
a, pivot, b = np.array(json.loads(sys.argv[2]))
direction = (b - a) / np.linalg.norm(b - a)
samples = [np.rint(pivot + distance * direction).astype(int)
           for distance in range(-360, 361, 4) if abs(distance) > 125]
samples = [(x, y) for x, y in samples if 4 < x < 789 and 4 < y < 722]


def coverage(start, held):
    def pixels(filename):
        return np.array(Image.open(directory / filename).convert("RGB"), dtype=int)

    difference = np.abs(pixels(start) - pixels(held)).max(axis=2)
    # Allow one pixel for the engines' different line rasterization rules.
    return [difference[y-1:y+2, x-1:x+2].max() >= 6 for x, y in samples]


field = coverage("field-scale-Z-start.png", "field-scale-Z-held.png")
studio = coverage("studio-scale-Z-start.png", "solid-scale-local-Z-held.png")
matched = sum(bool(f and s) for f, s in zip(field, studio))
result = dict(samples=len(samples), field=int(sum(field)), studio=int(sum(studio)), matched=matched)
print(json.dumps(result))
if result["field"] < len(samples)*0.8 or matched < result["field"]*0.95:
    raise SystemExit("Visible Scale Z guide differs between desktop captures")
