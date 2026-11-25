"""Check the native roll against the same level image in central, textured regions."""
import json
import sys

import numpy as np
from PIL import Image

level, rolled, keyed = [Image.open(path).convert("L") for path in sys.argv[1:]]
assert level.size == rolled.size == keyed.size
reference = np.asarray(level.rotate(-30, Image.Resampling.BILINEAR), dtype=float)
actual = np.asarray(rolled, dtype=float)
key_error = np.abs(actual - np.asarray(keyed, dtype=float)).mean()
assert key_error < 1, key_error
h, w = actual.shape
offsets = []
for sy in (-1, 1):
    for sx in (-1, 1):
        # Select a textured patch in each quadrant using the reference alone.
        candidates = [(w//2 + sx*i, h//2 + sy*j)
                      for i in range(20, 85, 8) for j in range(20, 65, 8)]
        def region(x, y):
            return reference[y-16:y+16, x-16:x+16]
        x, y = max(candidates, key=lambda p:region(*p).std())
        patch = region(x, y)
        assert patch.std() > 2, (x, y, patch.std())
        def error(dx, dy):
            match = actual[y+dy-16:y+dy+16, x+dx-16:x+dx+16]
            return np.abs(match - patch).mean()
        dx, dy = min(((i,j) for i in range(-3,4) for j in range(-3,4)), key=lambda d:error(*d))
        assert np.hypot(dx, dy) <= 1, (x,y,dx,dy)
        offsets.append(dict(x=x, y=y, dx=dx, dy=dy, meanAbsoluteError=error(dx,dy)))
print(json.dumps(dict(regions=offsets, stillToKeyMeanAbsoluteError=key_error)))
