"""Record the Rust renderer payload as each real Python render request is read."""
import json
import os
from pathlib import Path
import sys


if Path(sys.argv[0]).name == "studio_render.py" and os.getenv("VP09_RENDER_LOG"):
    class RendererInput:
        def __init__(self, stream):
            self.stream = stream

        def readline(self):
            return self.stream.readline()

        def __iter__(self):
            for line in self.stream:
                request = json.loads(line)
                if "camera" in request:
                    with open(os.environ["VP09_RENDER_LOG"], "a", encoding="utf-8") as log:
                        print(json.dumps({key: request.get(key) for key in
                                          ("id", "output", "width", "height", "camera")}), file=log)
                yield line

    sys.stdin = RendererInput(sys.stdin)
