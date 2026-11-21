"""Range-capable loopback server for Studio's remote-DEM tests.

Only the range server is used here; the engine's no-range/malformed servers and
hand-written TIFF encoder stay upstream.
"""

from __future__ import annotations

import http.server
import socketserver
import threading

from _loopback import bind_loopback_or_skip


def _serve_range(body: bytes, *, unit: str = "bytes"):
    """Serve `body` over HTTP with Range support, counting bytes and requests."""
    served = {"bytes": 0, "requests": 0, "range_requests": 0, "full_requests": 0}

    class _Handler(http.server.BaseHTTPRequestHandler):
        def do_HEAD(self):  # noqa: N802
            self.send_response(200)
            self.send_header("content-type", "image/tiff")
            self.send_header("content-length", str(len(body)))
            self.send_header("accept-ranges", "bytes")
            self.end_headers()

        def do_GET(self):  # noqa: N802
            served["requests"] += 1
            rng = self.headers.get("Range")
            if rng and rng.startswith("bytes="):
                served["range_requests"] += 1
                start_s, end_s = rng[len("bytes=") :].split("-")
                start = int(start_s)
                end = int(end_s) if end_s else len(body) - 1
                end = min(end, len(body) - 1)
                chunk = body[start : end + 1]
                self.send_response(206)
                self.send_header("content-type", "image/tiff")
                self.send_header("content-range", f"{unit} {start}-{end}/{len(body)}")
                self.send_header("content-length", str(len(chunk)))
                self.send_header("connection", "close")
                self.end_headers()
                served["bytes"] += len(chunk)
                self.wfile.write(chunk)
            else:
                served["full_requests"] += 1
                self.send_response(200)
                self.send_header("content-type", "image/tiff")
                self.send_header("content-length", str(len(body)))
                self.send_header("connection", "close")
                self.end_headers()
                served["bytes"] += len(body)
                self.wfile.write(body)

        def log_message(self, *_args):
            return

    class _Server(socketserver.ThreadingTCPServer):
        allow_reuse_address = True
        daemon_threads = True

    server = bind_loopback_or_skip(_Server, _Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, f"http://127.0.0.1:{server.server_address[1]}/data.tif", served
