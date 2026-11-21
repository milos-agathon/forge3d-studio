"""GLB fixture builder for Studio's mesh compositing tests.

Only the builder lives in Studio; the import and MapScene tests that used the
other builders remain upstream in the engine repo.
"""

from __future__ import annotations

import base64
import binascii
import json
import struct
import zlib


def _png_data_uri_rgba_1x1() -> str:
    def chunk(kind: bytes, data: bytes) -> bytes:
        body = kind + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", binascii.crc32(body) & 0xFFFFFFFF)

    ihdr = struct.pack(">IIBBBBB", 1, 1, 8, 6, 0, 0, 0)
    idat = zlib.compress(b"\x00\xff\xff\xff\xff")
    png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", idat) + chunk(b"IEND", b"")
    return "data:image/png;base64," + base64.b64encode(png).decode("ascii")


def _write_material_gltf(path) -> None:
    positions = struct.pack("<18f", 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0,
                            2.0, 0.0, 0.0, 3.0, 0.0, 0.0, 2.0, 1.0, 0.0)
    indices = struct.pack("<6H", 0, 1, 2, 0, 1, 2)
    blob = positions + indices
    uri = "data:application/octet-stream;base64," + base64.b64encode(blob).decode("ascii")
    png_1x1 = _png_data_uri_rgba_1x1()
    gltf = {
        "asset": {"version": "2.0"},
        "scene": 0,
        "scenes": [{"nodes": [0]}],
        "nodes": [{"mesh": 0, "name": "landmark"}],
        "extensionsUsed": ["KHR_materials_unlit", "KHR_texture_transform"],
        "buffers": [{"byteLength": len(blob), "uri": uri}],
        "bufferViews": [
            {"buffer": 0, "byteOffset": 0, "byteLength": len(positions), "target": 34962},
            {"buffer": 0, "byteOffset": len(positions), "byteLength": len(indices), "target": 34963},
        ],
        "accessors": [
            {"bufferView": 0, "byteOffset": 0, "componentType": 5126, "count": 3,
             "type": "VEC3", "min": [0.0, 0.0, 0.0], "max": [1.0, 1.0, 0.0]},
            {"bufferView": 0, "byteOffset": 36, "componentType": 5126, "count": 3,
             "type": "VEC3", "min": [2.0, 0.0, 0.0], "max": [3.0, 1.0, 0.0]},
            {"bufferView": 1, "byteOffset": 0, "componentType": 5123, "count": 3, "type": "SCALAR"},
            {"bufferView": 1, "byteOffset": 6, "componentType": 5123, "count": 3, "type": "SCALAR"},
        ],
        "images": [{"uri": png_1x1}],
        "textures": [{"source": 0}],
        "materials": [
            {"name": "mat_red", "pbrMetallicRoughness": {"baseColorFactor": [1.0, 0.0, 0.0, 0.5]}},
        ],
        "meshes": [{"primitives": [{"attributes": {"POSITION": 0}, "indices": 2, "material": 0}]}],
    }
    path.write_text(json.dumps(gltf), encoding="utf-8")


def _write_material_glb(path) -> None:
    json_path = path.with_suffix(".gltf")
    _write_material_gltf(json_path)
    payload = json.loads(json_path.read_text(encoding="utf-8"))
    json_path.unlink()
    json_bytes = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    json_bytes += b" " * ((4 - (len(json_bytes) % 4)) % 4)
    chunk = struct.pack("<II", len(json_bytes), 0x4E4F534A) + json_bytes
    header = struct.pack("<III", 0x46546C67, 2, 12 + len(chunk))
    path.write_bytes(header + chunk)
