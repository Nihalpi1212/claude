"""A stand-in for OpenAI's API on 127.0.0.1, for the final end-to-end check of pigment-cli.
Answers GET /v1/models and POST /v1/images/edits; logs each request (never the key)."""
import base64, json, struct, sys, zlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

KEY = sys.argv[2]
LOG = sys.argv[3]

def png(w, h, rgba):
    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
    row = b"\x00" + bytes(rgba) * w
    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0)) + chunk(b"IDAT", zlib.compress(row * h, 9)) + chunk(b"IEND", b"")

MAGENTA = base64.b64encode(png(1024, 1024, (255, 0, 255, 255))).decode()

class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass
    def answer(self, status, obj):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Connection", "close")
        self.end_headers()
        self.wfile.write(body)
    def record(self, body):
        auth = self.headers.get("Authorization", "")
        entry = {
            "method": self.command, "path": self.path,
            "auth": "right key" if auth == "Bearer " + KEY else ("none" if not auth else "other"),
            "contentType": (self.headers.get("Content-Type") or "").split(";")[0],
            "bytes": len(body),
            "keyInUrl": KEY in self.path,
            "prompt": b"a magenta box" in body,
            "hasMask": b'name="mask"' in body,
            "hasImage": b'name="image[]"' in body,
        }
        with open(LOG, "a") as f:
            f.write(json.dumps(entry) + "\n")
        return auth == "Bearer " + KEY
    def do_GET(self):
        ok = self.record(b"")
        if not ok:
            return self.answer(401, {"error": {"message": "Incorrect API key provided", "code": "invalid_api_key"}})
        if self.path == "/v1/models":
            return self.answer(200, {"data": [{"id": "gpt-5.1"}, {"id": "gpt-image-1"}, {"id": "text-embedding-3-small"}]})
        self.answer(404, {"error": {"message": "no route"}})
    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("Content-Length") or 0))
        ok = self.record(body)
        if not ok:
            return self.answer(401, {"error": {"message": "Incorrect API key provided", "code": "invalid_api_key"}})
        if self.path == "/v1/images/edits":
            return self.answer(200, {"data": [{"b64_json": MAGENTA}]})
        self.answer(404, {"error": {"message": "no route"}})

srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
with open(sys.argv[1], "w") as f:
    f.write(str(srv.server_address[1]))
srv.serve_forever()
