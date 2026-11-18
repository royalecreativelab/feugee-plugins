#!/usr/bin/env python3
"""Feugee HTML Import - local CORS proxy.

Lets the Figma plugin fetch pages, stylesheets, fonts and images from any
host without sending your URLs to a public proxy service.

    python3 tools/cors-proxy.py            # listens on 127.0.0.1:8787
    python3 tools/cors-proxy.py 9000       # other port (set Custom proxy in the plugin)

Only binds to localhost. Stdlib only.
"""
import gzip
import sys
import urllib.error
import urllib.parse
import urllib.request
import zlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = int(sys.argv[1]) if len(sys.argv) > 1 else 8787
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0 Safari/537.36")
PASS_HEADERS = ("content-type", "cache-control", "last-modified", "etag")


def decode(body, encoding):
    """Undo transfer compression; the browser sees no Content-Encoding header."""
    enc = encoding.lower().strip()
    if not enc and body[:2] == b"\x1f\x8b":
        enc = "gzip"
    try:
        if enc in ("gzip", "x-gzip"):
            return gzip.decompress(body)
        if enc == "deflate":
            try:
                return zlib.decompress(body)
            except zlib.error:
                return zlib.decompress(body, -zlib.MAX_WBITS)
    except (OSError, zlib.error):
        pass
    return body


class Handler(BaseHTTPRequestHandler):
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.send_header("Access-Control-Allow-Private-Network", "true")

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        url = (q.get("url") or [""])[0]
        if not url.startswith(("http://", "https://")):
            self.send_response(400)
            self._cors()
            self.end_headers()
            self.wfile.write(b"usage: /?url=https://...")
            return
        req = urllib.request.Request(url, headers={
            "User-Agent": UA,
            "Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
            # Only encodings stdlib can decode. Some servers (python.org)
            # gzip even without being asked, so always decode below.
            "Accept-Encoding": "gzip, deflate",
        })
        try:
            with urllib.request.urlopen(req, timeout=25) as r:
                body = decode(r.read(), r.headers.get("Content-Encoding", ""))
                self.send_response(r.status)
                for k, v in r.headers.items():
                    if k.lower() in PASS_HEADERS:
                        self.send_header(k, v)
                self.send_header("Content-Length", str(len(body)))
                self.send_header("X-Final-Url", r.geturl())
                self._cors()
                self.end_headers()
                self.wfile.write(body)
        except urllib.error.HTTPError as e:
            self.send_response(e.code)
            self._cors()
            self.end_headers()
            self.wfile.write(decode(e.read() or b"", e.headers.get("Content-Encoding", "")))
        except Exception as e:  # network errors -> 502 with a readable reason
            self.send_response(502)
            self._cors()
            self.end_headers()
            self.wfile.write(str(e).encode("utf-8", "replace"))

    def log_message(self, format, *args):  # noqa: A002 (base-class signature)
        sys.stderr.write("[feugee-proxy] " + (format % args) + "\n")


if __name__ == "__main__":
    print(f"Feugee CORS proxy on http://127.0.0.1:{PORT}/?url=<page>  (Ctrl+C to stop)")
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
