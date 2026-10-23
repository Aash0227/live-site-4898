"""Local server for the built Live-Site Viewer (the Revit add-in starts this):

    npm run build                     # once per viewer change: writes dist/
    python serve.py [--port 8780]     # -> http://127.0.0.1:8780/viewer/?project=<id>

/                -> dist/ (the built viewer, /viewer/ and the compatibility page)
/revisions/...   -> the revisions root (env LSV_REVISIONS, default data/revisions): projects.json, <project>/index.json, revision folders
Revision payloads are immutable (their folder name is the revision id) and cached for a year; the indexes, projects.json,
published.json and revision.json (its status changes on publish) are always revalidated. Binds to 127.0.0.1 only.
"""
import argparse, http.server, os, sys
from functools import partial

HERE = os.path.dirname(os.path.abspath(__file__))
DIST = os.path.join(HERE, 'dist')
REV = os.path.abspath(os.environ.get('LSV_REVISIONS') or os.path.join(HERE, 'data', 'revisions'))
MUTABLE = ('index.json', 'projects.json', 'published.json', 'revision.json')


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map, '.wasm': 'application/wasm', '.js': 'text/javascript', '.mjs': 'text/javascript', '.frag': 'application/octet-stream'}

    def translate_path(self, path):
        p = path.split('?', 1)[0].split('#', 1)[0]
        if p.startswith('/revisions/'):
            full = os.path.abspath(os.path.join(REV, *[x for x in p[len('/revisions/'):].split('/') if x not in ('', '.', '..')]))
            return full if full.startswith(REV) else REV
        return super().translate_path(path)

    def end_headers(self):
        p = self.path.split('?', 1)[0]
        immutable = p.startswith('/revisions/') and p.count('/') >= 3 and not p.endswith(MUTABLE) and '/_failed/' not in p
        self.send_header('Cache-Control', 'public, max-age=31536000, immutable' if immutable else 'no-cache')
        super().end_headers()

    def log_message(self, fmt, *args):
        if not str(args[1]).startswith(('2', '3')):
            super().log_message(fmt, *args)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('port', nargs='?', type=int)
    ap.add_argument('--port', dest='port_opt', type=int, default=8780)
    a = ap.parse_args()
    port = a.port or a.port_opt
    if not os.path.exists(os.path.join(DIST, 'viewer', 'index.html')):
        sys.exit('dist/ is missing: run "npm run build" in ' + HERE)
    srv = http.server.ThreadingHTTPServer(('127.0.0.1', port), partial(Handler, directory=DIST))
    print(f'Live-Site Viewer: http://127.0.0.1:{port}/viewer/   (revisions: {REV})', flush=True)
    srv.serve_forever()


if __name__ == '__main__':
    main()
