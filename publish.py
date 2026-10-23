"""Live-Site Viewer publishing: Revit export -> validated, immutable candidate revision -> explicit publication.

    python publish.py [--project <id>] build <export dir> [--address ".."] [--site site.json] [--survey surveys/x.json] [--ifc model.ifc]
    python publish.py [--project <id>] export <model.rvt> --fragments     # Revit harness on a scratch copy, then build
    python publish.py [--project <id>] publish <revision id>          # the ONLY step that changes what the website shows
    python publish.py [--project <id>] list
    python publish.py selftest

Projects (projects.json): each project has its own revision folder, revision history, published.json and _failed folder:
<revisions>/<project>/<revId>/..., <revisions>/<project>/index.json, <revisions>/<project>/published.json. The 'legacy' project
(Vestibule) keeps its revisions at the top level (<revisions>/<revId>, index.json, published.json) so older readers keep working;
<revisions>/projects.json is the catalogue the viewer reads (docs/PROJECTS.md). --project defaults to projects.json "default".
build never touches published.json. A candidate that fails a blocking check is moved to <project dir>/_failed/<id> with its report.
site.json (optional, from a surveyor) overrides the georeference:
    {"lat": .., "lon": .., "shared": [x_ft, y_ft], "elevationM": .., "datum": "NAVD88", "source": "..", "accuracyM": ..}
    = the shared-coordinate point (default the survey point 0,0) is at lat/lon; elevationM = its real elevation.
"""
import argparse, gzip, io, json, math, os, shutil, sys, time, urllib.parse, urllib.request
import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
REV = os.environ.get('LSV_REVISIONS') or os.path.join(HERE, 'revisions')      # the PoC branch writes its revisions elsewhere so the production viewer's list is untouched
CACHE = os.environ.get('LSV_CACHE') or os.path.join(HERE, 'cache')
FT = 0.3048
FORMAT = 'site-export/2'
REVIT_DEFAULT_SITE = (42.3584, -71.0598)          # Revit's factory location (Boston) = nobody set it
TERRAIN = [('fine', 240.0, 121), ('coarse', 1500.0, 151)]   # (name, half size m, samples per side)
SURROUND_M = 450


# ── small utilities ───────────────────────────────────────────────────────────────────────────────
def http_json(url, data=None, timeout=60):
    req = urllib.request.Request(url, data=data, headers={'User-Agent': 'livio-4898-site-viewer/0.2 (ashwin@golivio.com)'})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def http_bytes(url, timeout=30):
    req = urllib.request.Request(url, headers={'User-Agent': 'livio-4898-site-viewer/0.2'})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def cached(name, fn):
    os.makedirs(CACHE, exist_ok=True)
    p = os.path.join(CACHE, name)
    if os.path.exists(p):
        with open(p, 'rb') as f:
            return f.read()
    b = fn()
    with open(p, 'wb') as f:
        f.write(b)
    return b


def wjson(path, obj, indent=None):
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(obj, f, indent=indent)


def rjson(path):
    with open(path, encoding='utf-8') as f:
        return json.load(f)


def wjson_atomic(path, obj, indent=1):
    wjson(path + '.tmp', obj, indent=indent)
    os.replace(path + '.tmp', path)


# ── projects ──────────────────────────────────────────────────────────────────────────────────────
PROJECTS = os.path.join(HERE, 'projects.json')


def project(pid=None):
    cfg = rjson(PROJECTS)
    pid = pid or cfg['default']
    p = next((p for p in cfg['projects'] if p['id'] == pid), None)
    if p is None:
        sys.exit(f"unknown project {pid!r}; projects.json has: {', '.join(x['id'] for x in cfg['projects'])}")
    return p


def pdir(p):
    """Where a project's revisions, published.json and _failed live."""
    return REV if p.get('legacy') else os.path.join(REV, p['id'])


def prel(p):
    """URL path of the project's revision folders under /revisions/ ('' for the legacy layout)."""
    return '' if p.get('legacy') else p['id'] + '/'


def m_per_deg(lat):
    """WGS84 metres per degree of latitude / longitude at lat."""
    a, e2, phi = 6378137.0, 6.69437999014e-3, math.radians(lat)
    s = 1 - e2 * math.sin(phi) ** 2
    return (math.pi / 180) * a * (1 - e2) / s ** 1.5, (math.pi / 180) * a * math.cos(phi) / math.sqrt(s)


def haversine(a, b):
    p1, p2 = math.radians(a[0]), math.radians(b[0])
    dp, dl = p2 - p1, math.radians(b[1] - a[1])
    return 2 * 6371008.8 * math.asin(math.sqrt(math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2))


# ── 1. export integrity ───────────────────────────────────────────────────────────────────────────
def load_export(d):
    errs = []
    if d.endswith('.partial') or os.path.exists(d + '.partial'):
        errs.append('export is incomplete (.partial directory)')
    need = ['meta.json', 'model.json', 'geometry.bin.gz', 'props.json.gz', 'audit.json']
    missing = [n for n in need if not os.path.exists(os.path.join(d, n))]
    if missing:
        return None, None, None, errs + ['missing files: ' + ', '.join(missing)]
    meta, model = rjson(os.path.join(d, 'meta.json')), rjson(os.path.join(d, 'model.json'))
    if meta.get('format') != FORMAT or not meta.get('complete'):
        errs.append(f"meta.json format {meta.get('format')!r} complete={meta.get('complete')} (need {FORMAT}, complete)")
    with gzip.open(os.path.join(d, 'geometry.bin.gz'), 'rb') as f:
        raw = f.read()
    if len(raw) != model['bytes']:
        errs.append(f"geometry stream is {len(raw)} bytes, model.json says {model['bytes']}")
        return meta, model, None, errs
    batches = {}
    for b in model['batches']:
        pos = np.frombuffer(raw, np.float32, b['vertexCount'] * 3, b['posOffset']).reshape(-1, 3)
        idx = np.frombuffer(raw, np.uint32, b['indexCount'], b['idxOffset'])
        if not np.isfinite(pos).all():
            errs.append(f"material {b['mat']}: non-finite vertex coordinates")
        if idx.size and int(idx.max()) >= b['vertexCount']:
            errs.append(f"material {b['mat']}: index {int(idx.max())} >= vertex count {b['vertexCount']}")
        if b['indexCount'] % 3:
            errs.append(f"material {b['mat']}: index count not a multiple of 3")
        batches[b['mat']] = (pos, idx)
    bad = 0
    for e in model['elements']:
        for mat, start, count in e['r']:
            if mat not in batches or start + count > batches[mat][1].size:
                bad += 1
    if bad:
        errs.append(f'{bad} element index ranges point outside their batch')
    if meta.get('elements') != len(model['elements']):
        errs.append(f"meta says {meta.get('elements')} elements, model.json has {len(model['elements'])}")
    return meta, model, batches, errs


# ── 2. internal -> shared coordinates ─────────────────────────────────────────────────────────────
def internal_to_shared(meta):
    """Returns (A 3x3, t 3, how, residuals). shared = A @ internal + t (feet)."""
    pr = meta['projectPositionProbes']
    P = [np.array([p['eastWest'], p['northSouth'], p['elevation']]) for p in pr]
    cx, cy = (P[1] - P[0]) / 100.0, (P[2] - P[0]) / 100.0
    A = np.array([[cx[0], cy[0], 0], [cx[1], cy[1], 0], [0, 0, 1.0]])
    how = 'project-position probes'
    if abs(np.linalg.det(A[:2, :2]) - 1) > 1e-6 or abs(cx @ cy) > 1e-6:
        # the probes do not vary with the point: fall back to the total transform, direction chosen by the base points
        tt = meta['totalTransform']
        T = np.array([tt['basisX'], tt['basisY'], tt['basisZ']]).T
        o = np.array(tt['origin'])
        cands = [(T, o, 'total transform'), (T.T, -T.T @ o, 'total transform (inverse)')]
        def res(c):
            M, t = c[0], c[1]
            return sum(np.linalg.norm(M @ np.array(meta[k]['position']) + t - np.array(meta[k]['shared'])) for k in ('projectBasePoint', 'surveyPoint'))
        A, t, how = min(cands, key=res)
        P0 = t
    else:
        P0 = P[0]
    t = np.array(P0, dtype=float)
    residuals = {k: float(np.linalg.norm(A @ np.array(meta[k]['position']) + t - np.array(meta[k]['shared']))) for k in ('projectBasePoint', 'surveyPoint')}
    return A, t, how, residuals


# ── 3. model footprint in shared feet ─────────────────────────────────────────────────────────────
def hull(pts):
    pts = sorted(set(map(tuple, pts)))
    if len(pts) < 3:
        return pts
    def cross(o, a, b): return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
    lo, hi = [], []
    for p in pts:
        while len(lo) >= 2 and cross(lo[-2], lo[-1], p) <= 0: lo.pop()
        lo.append(p)
    for p in reversed(pts):
        while len(hi) >= 2 and cross(hi[-2], hi[-1], p) <= 0: hi.pop()
        hi.append(p)
    return lo[:-1] + hi[:-1]


def min_rect(h):
    """Minimum-area rectangle of a convex hull: (angle deg of its long side from east, CCW, in [0,180)), w, l, centre."""
    best = None
    H = np.array(h)
    for i in range(len(h)):
        e = H[(i + 1) % len(h)] - H[i]
        if np.hypot(*e) < 1e-9: continue
        a = math.atan2(e[1], e[0])
        R = np.array([[math.cos(a), math.sin(a)], [-math.sin(a), math.cos(a)]])
        q = H @ R.T
        mn, mx = q.min(0), q.max(0)
        area = (mx - mn).prod()
        if best is None or area < best[0]:
            c = ((mn + mx) / 2) @ R
            w, l = mx - mn
            ang = math.degrees(a) if w >= l else math.degrees(a) + 90
            best = (area, ang % 180, float(min(w, l)), float(max(w, l)), c)
    return best[1:]


CORE = ('Walls', 'Floors', 'Roofs', 'Structural Framing', 'Structural Columns', 'Columns', 'Structural Foundations', 'Stairs', 'Curtain Panels', 'Ceilings')
OUTLIER_FT = 400.0


def footprint(batches, A, t, model):
    """Plan footprint from the core building elements; elements far from their median are reported, not used."""
    els = model['elements']
    core = [i for i, e in enumerate(els) if e['cat'] in CORE] or list(range(len(els)))
    c = np.array([[(els[i]['bb'][0] + els[i]['bb'][3]) / 2, (els[i]['bb'][1] + els[i]['bb'][4]) / 2] for i in core])
    med = np.median(c, 0)
    keep = [i for i, d in zip(core, np.hypot(*(c - med).T)) if d <= OUTLIER_FT]
    far = [i for i in range(len(els)) if np.hypot((els[i]['bb'][0] + els[i]['bb'][3]) / 2 - med[0], (els[i]['bb'][1] + els[i]['bb'][4]) / 2 - med[1]) > OUTLIER_FT]
    pts = []
    for i in keep:
        for mat, st, cnt in els[i]['r']:
            pos, idx = batches[mat]
            pts.append(pos[np.unique(idx[st:st + cnt])])
    if not pts:     # a mesh-less export (model.json "mesh": false): the bounding-box corners stand in for the vertices
        pts = [np.array([[b[i], b[j], b[k]] for i in (0, 3) for j in (1, 4) for k in (2, 5)], np.float32) for b in (els[i]['bb'] for i in keep)]
    allp = np.concatenate(pts) if pts else np.zeros((0, 3), np.float32)
    s = allp.astype(np.float64) @ A.T + t
    snap = np.unique(np.round(s[:, :2] / 1.0).astype(np.int64), axis=0)        # 1 ft grid
    h = hull(snap.tolist())
    ang, w, l, c = min_rect(h)
    return {'hullFt': h, 'rectAngleDeg': ang, 'rectWidthFt': w, 'rectLengthFt': l, 'centerFt': [float(c[0]), float(c[1])],
            'zMinFt': float(s[:, 2].min()), 'zMaxFt': float(s[:, 2].max()), 'bboxFt': [s[:, 0].min(), s[:, 1].min(), s[:, 0].max(), s[:, 1].max()],
            'coreElements': len(keep), 'outliers': [{'id': els[i]['id'], 'cat': els[i]['cat'], 'type': els[i]['type'], 'link': els[i].get('link')} for i in far]}


# ── 4. web services (all cached) ──────────────────────────────────────────────────────────────────
def geocode(address):
    key = 'geocode_' + ''.join(ch if ch.isalnum() else '_' for ch in address)[:80] + '.json'
    def nominatim():
        q = urllib.parse.urlencode({'q': address, 'format': 'json', 'limit': 1, 'addressdetails': 1})
        return json.dumps(http_json('https://nominatim.openstreetmap.org/search?' + q)).encode()
    out = []
    def esri():
        q = urllib.parse.urlencode({'SingleLine': address, 'f': 'json', 'maxLocations': 1, 'outFields': 'Addr_type,Match_addr'})
        return json.dumps(http_json('https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer/findAddressCandidates?' + q)).encode()
    try:
        c = json.loads(cached(key.replace('geocode_', 'esri_'), esri)).get('candidates', [])
        if c and c[0]['score'] >= 90:
            out.append({'source': f"Esri World Geocoder ({c[0]['attributes'].get('Addr_type')}, score {c[0]['score']:.0f})", 'lat': c[0]['location']['y'],
                        'lon': c[0]['location']['x'], 'label': c[0]['address'], 'precise': c[0]['attributes'].get('Addr_type') in ('PointAddress', 'Subaddress')})
    except Exception as ex:
        print('  esri geocoder unavailable:', ex)
    hits = json.loads(cached(key, nominatim))
    if hits:
        out.append({'source': 'OpenStreetMap Nominatim (' + hits[0].get('type', '') + ')', 'lat': float(hits[0]['lat']), 'lon': float(hits[0]['lon']), 'label': hits[0].get('display_name', ''),
                    'precise': hits[0].get('type') in ('house', 'building', 'apartments', 'commercial', 'residential', 'yes')})
    def census():
        q = urllib.parse.urlencode({'address': address, 'benchmark': 'Public_AR_Current', 'format': 'json'})
        return json.dumps(http_json('https://geocoding.geo.census.gov/geocoder/locations/onelineaddress?' + q)).encode()
    try:
        m = json.loads(cached(key.replace('geocode_', 'census_'), census))['result']['addressMatches']
        if m:
            out.append({'source': 'US Census geocoder (street-range interpolation)', 'lat': m[0]['coordinates']['y'], 'lon': m[0]['coordinates']['x'], 'label': m[0]['matchedAddress'], 'precise': False})
    except Exception as ex:
        print('  census geocoder unavailable:', ex)
    return sorted(out, key=lambda g: not g['precise'])   # an address point beats a street centroid


def usgs_elev(lat, lon):
    key = f'usgs_{lat:.6f}_{lon:.6f}.json'
    q = urllib.parse.urlencode({'x': lon, 'y': lat, 'units': 'Meters', 'wkid': 4326, 'includeDate': 'false'})
    try:
        v = json.loads(cached(key, lambda: http_bytes('https://epqs.nationalmap.gov/v1/json?' + q)))['value']
        return float(v) if v is not None and float(v) > -1000 else None
    except Exception:
        return None


def terrarium_grid(lat0, lon0, half, n, z=15):
    """Heights (m) on an n x n grid over +-half m around (lat0, lon0); row 0 = south, col 0 = west."""
    mlat, mlon = m_per_deg(lat0)
    lin = np.linspace(-half, half, n)
    E, N = np.meshgrid(lin, lin)
    lat = lat0 + N / mlat
    lon = lon0 + E / mlon
    s = 2 ** z
    fx = (lon + 180) / 360 * s * 256
    fy = (1 - np.log(np.tan(np.radians(lat)) + 1 / np.cos(np.radians(lat))) / math.pi) / 2 * s * 256
    tx0, tx1 = int(fx.min() // 256), int(fx.max() // 256)
    ty0, ty1 = int(fy.min() // 256), int(fy.max() // 256)
    mosaic = np.zeros(((ty1 - ty0 + 1) * 256, (tx1 - tx0 + 1) * 256), np.float64)
    for tx in range(tx0, tx1 + 1):
        for ty in range(ty0, ty1 + 1):
            png = cached(f'terrarium_{z}_{tx}_{ty}.png', lambda: http_bytes(f'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{tx}/{ty}.png'))
            a = np.asarray(Image.open(io.BytesIO(png)).convert('RGB'), np.float64)
            mosaic[(ty - ty0) * 256:(ty - ty0 + 1) * 256, (tx - tx0) * 256:(tx - tx0 + 1) * 256] = a[..., 0] * 256 + a[..., 1] + a[..., 2] / 256 - 32768
    px, py = fx - tx0 * 256 - 0.5, fy - ty0 * 256 - 0.5
    x0, y0 = np.clip(np.floor(px).astype(int), 0, mosaic.shape[1] - 2), np.clip(np.floor(py).astype(int), 0, mosaic.shape[0] - 2)
    u, v = px - x0, py - y0
    m = mosaic
    return (m[y0, x0] * (1 - u) * (1 - v) + m[y0, x0 + 1] * u * (1 - v) + m[y0 + 1, x0] * (1 - u) * v + m[y0 + 1, x0 + 1] * u * v)


def overpass(lat, lon):
    q = f'[out:json][timeout:90];(way["building"](around:{SURROUND_M},{lat:.6f},{lon:.6f});way["highway"]["name"](around:250,{lat:.6f},{lon:.6f}););out geom tags;'
    key = f'overpass_{lat:.5f}_{lon:.5f}_{SURROUND_M}.json'
    mirrors = ('https://overpass-api.de/api/interpreter', 'https://maps.mail.ru/osm/tools/overpass/api/interpreter', 'https://overpass.kumi.systems/api/interpreter',
               'https://overpass.private.coffee/api/interpreter')
    for attempt in range(3):                                   # the public instances are overloaded at times: retry with a pause
        for ep in mirrors:
            try:
                return json.loads(cached(key, lambda: json.dumps(http_json(ep, data=urllib.parse.urlencode({'data': q}).encode(), timeout=90)).encode()))
            except Exception as ex:
                print('  overpass', ep.split('/')[2], 'failed:', ex)
        time.sleep(8 * (attempt + 1))
    return None


def osm_height(tags):
    for k in ('height', 'building:height'):
        try:
            return float(str(tags[k]).replace('m', '').strip()), 'tag'
        except Exception:
            pass
    try:
        return float(tags['building:levels']) * 3.2, 'levels'
    except Exception:
        return 6.0, 'default'


def point_in_poly(x, y, poly):
    inside = False
    for i in range(len(poly)):
        x1, y1 = poly[i]; x2, y2 = poly[(i + 1) % len(poly)]
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1 + 1e-12) + x1:
            inside = not inside
    return inside


# ── build ─────────────────────────────────────────────────────────────────────────────────────────
def fragments_step(stage, ifc, model, check, allowed=()):
    """IFC -> Fragments with the Panel Station importer (scripts/convert.mjs), then identity coverage: every exported element's IFC GlobalId against the IFC."""
    import subprocess, re, collections
    node = shutil.which('node')
    if not node:
        raise RuntimeError('node is not installed: the IFC to Fragments conversion needs it')
    out = os.path.join(stage, 'model.frag')
    t = time.time()
    r = subprocess.run([node, os.path.join(HERE, 'scripts', 'convert.mjs'), ifc, out], capture_output=True, text=True, cwd=HERE)
    secs = time.time() - t
    if r.returncode or not os.path.exists(out):
        raise RuntimeError('IFC to Fragments conversion failed: ' + (r.stderr or r.stdout)[-400:])
    ids = set()
    with open(ifc, encoding='latin-1') as f:                   # line by line: a whole-model IFC can be hundreds of MB
        for line in f:
            m = IFC_ROOT.match(line)
            if m: ids.add(m.group(1))
    els = [e for e in model['elements'] if e.get('ifc')]
    miss = [e for e in els if e['ifc'] not in ids]
    expected = [e for e in miss if e.get('detail') == 'BoundingBoxProxy' or e['cat'] == 'Top Rails']
    unexpected = [e for e in miss if e not in expected]
    check('Fragments conversion', 'PASS', f"{os.path.getsize(out) / 1024:.0f} KB from a {os.path.getsize(ifc) / 1024:.0f} KB IFC in {secs:.1f} s")
    by = collections.Counter(e['cat'] for e in miss)
    cats = collections.Counter(e['cat'] for e in els)
    per_cat = {c: {'exported': n, 'inIfc': n - by.get(c, 0)} for c, n in cats.most_common()}
    none = sorted(c for c, v in per_cat.items() if v['inIfc'] == 0)
    # missing elements with solid geometry FAIL the build unless their category is listed for the project in projects.json
    # ("ifcMissingAllowed": categories the Revit IFC exporter is known to leave out of this model, each with its count measured)
    blocking = [e for e in unexpected if e['cat'] not in allowed]
    check('Fragments identity', 'FAIL' if blocking else ('WARN' if miss else 'PASS'),
          f"{len(els) - len(miss)} of {len(els)} exported elements have their IFC GlobalId in the IFC" + (f"; without an IFC entity: {dict(by)}" if miss else '')
          + (f"; categories with NO IFC entity: {', '.join(none)}" if none else '')
          + (f". {len(unexpected)} of the missing have solid geometry (not bounding-box proxies / Top Rails)" if unexpected else '')
          + (f"; allowed for this project: {', '.join(sorted(allowed))}" if unexpected and allowed else '')
          + (f". BLOCKING: {len(blocking)} in {dict(collections.Counter(e['cat'] for e in blocking))}" if blocking else ''))
    return {'bytes': os.path.getsize(out), 'seconds': round(secs, 2), 'ifcBytes': os.path.getsize(ifc), 'matched': len(els) - len(miss), 'exported': len(els),
            'withoutIfc': dict(by), 'perCategory': per_cat, 'categoriesWithoutIfc': none, 'missingWithGeometry': len(unexpected)}, ids


IFC_ROOT = __import__('re').compile(r"^#\d+=IFC[A-Z0-9]+\('([0-9A-Za-z_$]{22})'")


def qaqc_coverage(path, model, ifc_ids, check):
    """Identity of the QA/QC-checked elements (hold downs, shear walls, columns, beams of a real QA/QC run): PRESENT rows' element ids
    (with their parts) -> in the export -> their IFC GlobalId in the IFC. Measured on the QA/QC run's own ids, not on name heuristics."""
    q = rjson(path)
    by_id = {e['id']: e for e in model['elements'] if not e.get('link')}
    out = {}
    for c in q['categories']:
        rows = [r for r in c['rows'] if r.get('verdict') == 'PRESENT']
        if not rows: continue
        ids = sorted({i for r in rows for i in (r.get('elementIds') or [r['elementId']])})
        exp = [i for i in ids if i in by_id]
        inifc = [i for i in exp if by_id[i].get('ifc') in ifc_ids]
        fam = collections.Counter(by_id[i]['cat'] for i in exp)
        out[c['name']] = {'presentRows': len(rows), 'elementIds': len(ids), 'exported': len(exp), 'inIfc': len(inifc), 'categories': dict(fam),
                          'notExported': [i for i in ids if i not in by_id][:20], 'exportedNotInIfc': [i for i in exp if i not in set(inifc)][:20]}
        o = out[c['name']]
        check(f"QA/QC identity: {c['name']}", 'PASS' if o['inIfc'] == o['elementIds'] else 'WARN',
              f"{o['elementIds']} element ids of {o['presentRows']} PRESENT rows: {o['exported']} in the export, {o['inIfc']} with their GlobalId in the IFC ({dict(fam)})"
              + (f"; not exported: {o['notExported']}" if o['notExported'] else '') + (f"; not in the IFC: {o['exportedNotInIfc']}" if o['exportedNotInIfc'] else ''))
    return {'source': path, 'run': q.get('runAtUtc'), 'model': q.get('model'), 'categories': out}


def build(a):
    proj = project(getattr(a, 'project', None))
    D = pdir(proj)
    a.address = a.address or proj.get('address')
    if not a.survey and proj.get('survey'):
        a.survey = os.path.join(HERE, proj['survey'])
    export = os.path.abspath(a.export)
    rid = time.strftime('%Y%m%d-%H%M%S')
    os.makedirs(D, exist_ok=True)
    stage = os.path.join(D, '.staging-' + rid)
    os.makedirs(stage)
    ident = {'id': proj['id'], 'name': proj['name'], 'address': proj.get('address')}
    checks = []
    def check(name, status, detail):
        checks.append({'check': name, 'status': status, 'detail': detail})
        print(f'  [{status:4}] {name}: {detail}')

    try:
        print('1. export integrity')
        meta, model, batches, errs = load_export(export)
        check('Export integrity', 'FAIL' if errs else 'PASS', '; '.join(errs) or f"{meta['elements']} elements, {meta['triangles']:,} triangles, {len(model['materials'])} materials, geometry {model['bytes'] / 1e6:.0f} MB" + (' (mesh-less export: bounding boxes, ids and properties only; the shapes come from the Fragments model)' if model.get('mesh') is False else ''))
        if errs:
            raise RuntimeError('export failed validation')
        audit = rjson(os.path.join(export, 'audit.json'))
        geo_err = sum(v for k, v in audit['byReason'].items() if k.startswith('geometry error'))
        check('Skipped-element audit', 'WARN' if geo_err else 'PASS',
              f"{audit['skipped']} model elements not exported: " + '; '.join(f'{k} {v}' for k, v in list(audit['byReason'].items())[:6]))

        print('2. internal -> shared')
        A, t, how, resid = internal_to_shared(meta)
        rot = math.degrees(math.atan2(A[1, 0], A[0, 0]))
        worst = max(resid.values())
        check('Internal -> shared transform', 'PASS' if worst < 0.01 else 'WARN',
              f"from {how}; rotation internal->shared {rot:+.4f} deg (true-north angle {math.degrees(meta['projectPositionProbes'][0]['angleRad']):.4f} deg); "
              f"base-point residuals PBP {resid['projectBasePoint']:.4f} ft, SP {resid['surveyPoint']:.4f} ft")
        degenerate = all(np.allclose(meta[k]['position'][:2], [0, 0], atol=1e-6) for k in ('projectBasePoint', 'surveyPoint'))
        if degenerate and how != 'project-position probes':
            check('Rotation direction', 'WARN', 'both base points sit at the internal origin, so the rotation direction is not independently verifiable')

        fp = footprint(batches, A, t, model)
        survey = rjson(a.survey) if a.survey else None
        if survey:
            # model +x runs along the surveyed lot bearing (or the survey's own modelXAzimuthDeg when the axes are not along that bearing): angle from east
            want = 90.0 - survey.get('modelXAzimuthDeg', survey['lotBearing']['azimuthDeg'])
            diff = ((want - rot + 180.0) % 360.0) - 180.0
            if abs(diff) <= 1.0:
                check('Orientation vs survey bearing', 'PASS', f"Revit's rotation {rot:+.2f} deg agrees with the surveyed lot bearing {survey['lotBearing']['text']} ({want:+.2f} deg) within 1 deg")
            else:
                th = math.radians(diff)
                R = np.array([[math.cos(th), -math.sin(th), 0], [math.sin(th), math.cos(th), 0], [0, 0, 1]])
                c3 = np.array([fp['centerFt'][0], fp['centerFt'][1], 0.0])
                A, t = R @ A, R @ (t - c3) + c3
                rot = math.degrees(math.atan2(A[1, 0], A[0, 0]))
                fp = footprint(batches, A, t, model)
                check('Orientation vs survey bearing', 'WARN', f"the model has no true north ({rot - diff:+.2f} deg) but the surveyed lot bearing {survey['lotBearing']['text']} needs {want:+.2f} deg; "
                      f"rotated by {diff:+.2f} deg about the footprint centre at publication (recorded here; the Revit model is unchanged). {survey['lotBearing']['where']}. Model axes: +x {survey['modelAxes']['+x']}; +y {survey['modelAxes']['+y']}.")
            for d in survey.get('discrepancies', []):
                check('Source discrepancy', 'WARN', d)
            for d in survey.get('notVerified', []):
                check('Not verified', 'WARN', d)
        check('Footprint', 'WARN' if fp['outliers'] else 'PASS', f"{fp['rectLengthFt']:.1f} x {fp['rectWidthFt']:.1f} ft from {fp['coreElements']} core elements; "
              + (f"{len(fp['outliers'])} element(s) more than {OUTLIER_FT:.0f} ft from the building were left out of it: " + ', '.join(f"{o['id']} {o['cat']}" for o in fp['outliers'][:8]) if fp['outliers'] else 'no outliers'))
        if meta.get('links'):
            check('Linked models', 'PASS', '; '.join(f"{l['document']}: {l['elements']} elements" for l in meta['links']))
        print(f"   footprint {fp['rectLengthFt']:.1f} x {fp['rectWidthFt']:.1f} ft, long side {fp['rectAngleDeg']:.1f} deg from east, z {fp['zMinFt']:.1f}..{fp['zMaxFt']:.1f} ft (shared)")

        print('3. georeference')
        site = meta['siteLocation']
        geo = geocode(a.address) if a.address else []
        for g in geo:
            print(f"   geocode {g['source']}: {g['lat']:.6f}, {g['lon']:.6f}  {g['label']}")
        sp_shared = np.array(meta['surveyPoint']['shared'][:2], float)
        if survey and survey.get('modelTie'):
            mt = survey['modelTie']
            anchor_ll, anchor_shared = (mt['lat'], mt['lon']), (A @ np.array([mt['modelFt'][0], mt['modelFt'][1], 0.0]) + t)[:2]
            mode = f"model point {mt['modelFt']} (internal ft) placed at {mt['lat']:.7f}, {mt['lon']:.7f} ({mt['how']}); rotation from the survey. The Revit Site Location is not used."
            check('Georeference', 'WARN', mode + f" Expected horizontal error {mt.get('accuracyM', '?')} m (not a monument tie).")
        elif survey and survey.get('buildingCentre'):
            bc = survey['buildingCentre']
            anchor_ll, anchor_shared = (bc['lat'], bc['lon']), np.array(fp['centerFt'])
            mode = f"model footprint centre placed at the surveyed building centre {bc['lat']:.7f}, {bc['lon']:.7f} ({bc['how']}); rotation from the survey. The Revit Site Location is not used."
            check('Georeference', 'WARN', mode + f" Expected horizontal error {bc.get('accuracyM', '?')} m (not a monument tie).")
        elif survey and geo and geo[0]['precise']:
            off = survey['buildingCentreOffsetFromLotCentreFt']
            d_shared = A[:2, :2] @ np.array([off['x'], off['y']])
            anchor_ll, anchor_shared = (geo[0]['lat'], geo[0]['lon']), np.array(fp['centerFt']) - d_shared
            mode = (f"building centre = lot centre ({geo[0]['source']}: {geo[0]['label']}) + the civil-plan offset ({off['x']:+.1f}, {off['y']:+.1f} ft in model axes, C-3.0); "
                    f"rotation from the surveyed lot bearing. The Revit Site Location is not used.")
            check('Georeference', 'WARN', mode + ' NOT survey-grade: no monument or lot-corner coordinates are tied to the Revit model; expect a few metres of error.')
        elif a.site:
            s = rjson(a.site)
            anchor_ll, anchor_shared = (s['lat'], s['lon']), np.array(s.get('shared', [0, 0]), float)
            mode = f"surveyed reference ({s.get('source', 'site.json')}, accuracy {s.get('accuracyM', '?')} m)"
            check('Georeference', 'PASS', mode)
        else:
            is_default = abs(site['latitude'] - REVIT_DEFAULT_SITE[0]) < 0.01 and abs(site['longitude'] - REVIT_DEFAULT_SITE[1]) < 0.01
            d_addr = haversine((site['latitude'], site['longitude']), (geo[0]['lat'], geo[0]['lon'])) if geo else None
            if not is_default and (d_addr is None or d_addr < 1000):
                anchor_ll, anchor_shared = (site['latitude'], site['longitude']), sp_shared
                mode = 'Revit Site Location, assumed to be the survey point (no surveyed reference supplied)'
            elif geo:
                # the model is not georeferenced: put the footprint centre on the geocoded address (approximate by construction)
                anchor_ll, anchor_shared = (geo[0]['lat'], geo[0]['lon']), np.array(fp['centerFt'])
                mode = (f"footprint centre placed on the geocoded address ({geo[0]['source']}: {geo[0]['label']}); Revit Site Location "
                        + ('is the factory default' if is_default else f'is {d_addr:.0f} m away') + ' and was not used; rotation = Revit true north '
                        + f"({math.degrees(meta['projectPositionProbes'][0]['angleRad']):.2f} deg)" + ('' if geo[0]['precise'] else '. The geocode is NOT address-precise'))
            else:
                raise RuntimeError('model is not georeferenced and no address could be geocoded; pass --address or --site')
            check('Georeference', 'WARN', mode + '. UNSURVEYED: horizontal accuracy is not verified (D-02 open).')
        mlat, mlon = m_per_deg(anchor_ll[0])
        def shared_to_ll(x, y):
            de, dn = (x - anchor_shared[0]) * FT, (y - anchor_shared[1]) * FT
            return anchor_ll[0] + dn / mlat, anchor_ll[1] + de / mlon
        lat0, lon0 = shared_to_ll(*fp['centerFt'])
        for g in geo:
            dd = haversine((lat0, lon0), (g['lat'], g['lon']))
            check(f"Building centre vs {g['source'].split(' (')[0]}", 'INFO' if g is geo[0] and anchor_shared is not sp_shared else ('PASS' if dd < 30 else 'WARN'),
                  f"{dd:.1f} m ({g['label']})" + (' - this geocode is the anchor, so the distance is 0 by construction' if dd < 0.01 else ''))

        print('4. terrain + vertical')
        z_usgs = usgs_elev(lat0, lon0)
        grids = {}
        for name, half, n in TERRAIN:
            grids[name] = terrarium_grid(lat0, lon0, half, n)
        z_tr = float(grids['fine'][60, 60])
        z0 = z_usgs if z_usgs is not None else z_tr
        datum = 'NAVD88 (USGS 3DEP)' if z_usgs is not None else 'terrarium (SRTM/NED mix)'
        check('Terrain source', 'PASS' if z_usgs is not None else 'WARN',
              f"USGS 3DEP {z_usgs:.2f} m NAVD88 at the building centre; Terrarium z15 grid {z_tr:.2f} m there, shifted by {z0 - z_tr:+.2f} m to match" if z_usgs is not None else 'USGS 3DEP unavailable; Terrarium heights used as they are')
        corners_m = []
        bx0, by0, bx1, by1 = fp['bboxFt']
        for x, y in ((bx0, by0), (bx1, by0), (bx1, by1), (bx0, by1)):
            v = usgs_elev(*shared_to_ll(x, y))
            if v is not None: corners_m.append(v)
        levels = meta['levels']
        lvl1 = next((l for l in levels if abs(l['elevationFt']) < 1e-6), None) or min(levels, key=lambda l: abs(l['elevationFt']))
        lvl1_shared_m = (A @ np.array([0, 0, lvl1['elevationFt']]) + t)[2] * FT
        terrain_at = z_usgs if z_usgs is not None else z_tr
        if survey and survey.get('firstFloor'):
            ff = survey['firstFloor']
            lv = next((l for l in levels if l['name'].strip().upper() == ff['level'].upper()), None)
            if lv is None:
                raise RuntimeError(f"survey first-floor level {ff['level']!r} is not a level of the model")
            lv_shared_m = (A @ np.array([0, 0, lv['elevationFt']]) + t)[2] * FT
            ffe_m = ff['ffeFt'] * FT
            vertical = {'mode': f"{lv['name']} = {ff['ffeFt']:.2f} ft {ff['datum']} ({ff.get('sheet', 'civil plan C-3.0')})", 'modelUpAtSharedZ0M': ffe_m - lv_shared_m - z0}
            check('Vertical alignment', 'PASS', f"{lv['name']} set to the surveyed first-floor elevation {ff['ffeFt']:.2f} ft ({ffe_m:.3f} m) {ff['datum']} ({ff['source']}); "
                  f"{(ffe_m - terrain_at):+.2f} m against the USGS ground at the building centre ({terrain_at:.2f} m)")
            gs = survey.get('garageSlab')
            if gs:
                gl = next((l for l in levels if l['name'].strip().upper() == gs['level'].upper()), None)
                if gl:
                    gl_m = (A @ np.array([0, 0, gl['elevationFt']]) + t)[2] * FT + vertical['modelUpAtSharedZ0M'] + z0
                    dd = gl_m - gs['elevationFt'] * FT
                    check('Basement level vs civil garage slab', 'PASS' if abs(dd) < 0.4 else 'WARN',
                          f"{gl['name']} lands at {gl_m / FT:.2f} ft {gs['datum']}; civil garage level slab {gs['elevationFt']:.2f} ft; difference {dd / FT:+.2f} ft ({gs['source']})")
            if survey.get('lotSpotGradeRangeFt'):
                lo, hi = survey['lotSpotGradeRangeFt']
                check('Ground vs surveyed spot grades', 'PASS' if lo * FT - 0.3 <= terrain_at <= hi * FT + 0.3 else 'WARN',
                      f"USGS ground {terrain_at / FT:.2f} ft at the building centre; spot grades on the lot {lo:.2f} to {hi:.2f} ft {survey.get('lotSpotGradeDatum', 'NAVD88')} ({survey.get('lotSpotGradeSource', 'SU-3, C-3.0')})")
        elif a.site and rjson(a.site).get('elevationM') is not None:
            s = rjson(a.site)
            vmode = f"surveyed elevation {s['elevationM']} m {s.get('datum', '')} at the reference point"
            vertical = {'mode': 'surveyed', 'modelUpAtSharedZ0M': s['elevationM'] - meta['surveyPoint']['shared'][2] * FT - z0}
            check('Vertical alignment', 'PASS', vmode)
        elif abs(lvl1_shared_m - terrain_at) < 3.0:
            vertical = {'mode': 'shared elevation is a real datum', 'modelUpAtSharedZ0M': -z0}
            check('Vertical alignment', 'WARN', f"shared elevation used as-is: {lvl1['name']} at {lvl1_shared_m:.2f} m vs terrain {terrain_at:.2f} m ({datum}); difference {lvl1_shared_m - terrain_at:+.2f} m. Not survey-verified.")
        else:
            vertical = {'mode': f"{lvl1['name']} placed on the terrain at the building centre", 'modelUpAtSharedZ0M': terrain_at - z0 + a.floor_above_grade - lvl1_shared_m}
            check('Vertical alignment', 'WARN', f"the model's shared elevation is not a real datum ({lvl1['name']} shared {lvl1_shared_m:.2f} m vs terrain {terrain_at:.2f} m {datum}), "
                  f"so {lvl1['name']} is set {a.floor_above_grade:+.2f} m above the provider terrain at the building centre. Not survey-verified.")
        if len(corners_m) == 4:
            check('Terrain across the footprint', 'PASS' if max(corners_m) - min(corners_m) < 1.5 else 'WARN',
                  'USGS corners ' + ', '.join(f'{c:.2f}' for c in corners_m) + f' m (range {max(corners_m) - min(corners_m):.2f} m)')

        print('5. surroundings + orientation')
        osm = overpass(lat0, lon0)
        mlat0, mlon0 = m_per_deg(lat0)
        def ll_to_en(la, lo): return ((lo - lon0) * mlon0, (la - lat0) * mlat0)
        hull_en = [(((x - fp['centerFt'][0]) * FT), ((y - fp['centerFt'][1]) * FT)) for x, y in fp['hullFt']]
        buildings, hidden, roads = [], [], []
        if osm:
            for el in osm.get('elements', []):
                g = el.get('geometry')
                if not g: continue
                pts = [ll_to_en(p['lat'], p['lon']) for p in g]
                tags = el.get('tags', {})
                if 'building' in tags:
                    if len(pts) < 4: continue
                    cx, cy = np.mean([p[0] for p in pts[:-1]]), np.mean([p[1] for p in pts[:-1]])
                    overlaps = point_in_poly(cx, cy, hull_en) or any(point_in_poly(px, py, pts) for px, py in hull_en[::max(1, len(hull_en) // 12)])
                    h, hs = osm_height(tags)
                    rec = {'id': el['id'], 'pts': [[round(x, 2), round(y, 2)] for x, y in pts[:-1]], 'h': round(h, 1), 'hs': hs,
                           'min': float(tags.get('min_height', 0) or 0), 'name': tags.get('name', ''), 'addr': (tags.get('addr:housenumber', '') + ' ' + tags.get('addr:street', '')).strip()}
                    (hidden if overlaps else buildings).append(rec)
                elif 'highway' in tags:
                    roads.append({'name': tags.get('name'), 'pts': [[round(x, 2), round(y, 2)] for x, y in pts]})
            check('Surroundings', 'PASS', f"{len(buildings)} OpenStreetMap buildings within {SURROUND_M} m; {len(hidden)} existing OSM building(s) on the project footprint hidden: "
                  + (', '.join(f"#{b['id']} {b['addr'] or b['name']}".strip() for b in hidden) or 'none'))
            # orientation: the model's long side vs the nearest named street
            best = None
            for r in roads:
                for (x1, y1), (x2, y2) in zip(r['pts'], r['pts'][1:]):
                    L2 = (x2 - x1) ** 2 + (y2 - y1) ** 2
                    if L2 < 1: continue
                    u = max(0, min(1, (-x1 * (x2 - x1) - y1 * (y2 - y1)) / L2))
                    d = math.hypot(x1 + u * (x2 - x1), y1 + u * (y2 - y1))
                    if best is None or d < best[0]:
                        best = (d, r['name'], math.degrees(math.atan2(y2 - y1, x2 - x1)) % 180)
            if best:
                delta = abs(((fp['rectAngleDeg'] - best[2]) + 45) % 90 - 45)
                check('Orientation vs street frontage', 'PASS' if delta <= 3 else 'WARN',
                      f"model long side {fp['rectAngleDeg']:.1f} deg, nearest street {best[1]} ({best[0]:.0f} m away) {best[2]:.1f} deg from east: "
                      f"{delta:.1f} deg off parallel/perpendicular. Checks rotation only (a 180 deg flip is not detectable this way)."
                      + (' Independent of the survey bearing (OpenStreetMap geometry).' if survey else ''))
        else:
            check('Surroundings', 'WARN', 'OpenStreetMap (Overpass) unavailable: no surrounding buildings, no orientation check')

        # ── internal feet -> viewer local metres (x east, y up, z south) as a column-major 4x4 for three.js ──
        c = np.array(fp['centerFt'])
        L = np.zeros((4, 4)); L[3, 3] = 1
        Ae, An, Au = A[0] * FT, A[1] * FT, A[2] * FT
        te, tn, tu = (t[0] - c[0]) * FT, (t[1] - c[1]) * FT, t[2] * FT + vertical['modelUpAtSharedZ0M']
        L[0, :3], L[0, 3] = Ae, te
        L[1, :3], L[1, 3] = Au, tu
        L[2, :3], L[2, 3] = -An, -tn
        matrix = L.T.flatten().tolist()

        lot = None
        if survey and survey.get('lot', {}).get('cornersLatLon'):
            sl = survey['lot']
            lot = {'cornersLocalEN_m': [[round(v, 3) for v in ll_to_en(la, lo)] for la, lo in sl['cornersLatLon']], 'source': sl['source'], 'bearing': survey['lotBearing']['text'],
                   'areaSqFt': sl.get('areaSqFt')}
            fp_in = sum(point_in_poly(x, y, lot['cornersLocalEN_m']) for x, y in hull_en)
            check('Footprint inside the lot', 'PASS' if fp_in == len(hull_en) else 'WARN', f"{fp_in} of {len(hull_en)} footprint hull points inside the lot polygon ({sl['source']})")
        elif survey and survey.get('lotSizeFt') and survey.get('buildingCentreOffsetFromLotCentreFt'):
            off = survey['buildingCentreOffsetFromLotCentreFt']; w, h = survey['lotSizeFt']
            corners = [[-off['x'] + sx * w / 2, -off['y'] + sy * h / 2] for sx, sy in ((-1, -1), (1, -1), (1, 1), (-1, 1))]      # model axes, relative to the building centre
            lot = {'cornersLocalEN_m': [(A[:2, :2] @ np.array(c)) * FT for c in corners], 'sizeFt': [w, h], 'source': survey.get('lotSizeNote', ''), 'bearing': survey['lotBearing']['text']}
            lot['cornersLocalEN_m'] = [[round(float(v), 3) for v in c] for c in lot['cornersLocalEN_m']]
        fragments = None
        if getattr(a, 'ifc', None):
            print('6. fragments')
            fragments, ifc_ids = fragments_step(stage, os.path.abspath(a.ifc), model, check, set(proj.get('ifcMissingAllowed', {})))
            if proj.get('qaqcResult') and os.path.exists(proj['qaqcResult']):
                fragments['qaqc'] = qaqc_coverage(proj['qaqcResult'], model, ifc_ids, check)
        fails = [c for c in checks if c['status'] == 'FAIL']
        warns = [c for c in checks if c['status'] == 'WARN']
        alignment = {
            'origin': {'lat': lat0, 'lon': lon0, 'elevationM': z0, 'datum': datum, 'what': 'model footprint centre'},
            'anchor': {'lat': anchor_ll[0], 'lon': anchor_ll[1], 'sharedFt': anchor_shared.tolist(), 'mode': mode},
            'internalToSharedFt': {'A': A.tolist(), 't': t.tolist(), 'how': how, 'residualsFt': resid, 'rotationDeg': rot},
            'internalToLocalM': matrix,
            'vertical': {**vertical, 'lvl1': lvl1['name'], 'lvl1SharedM': lvl1_shared_m, 'terrainM': terrain_at, 'footprintCornersM': corners_m},
            'footprint': {k: fp[k] for k in ('rectAngleDeg', 'rectWidthFt', 'rectLengthFt', 'centerFt', 'zMinFt', 'zMaxFt')},
            'geocode': geo, 'lot': lot, 'survey': ({k: survey[k] for k in ('project', 'sources', 'lotBearing', 'firstFloor', 'benchmarks')} if survey else None),
            'terrain': {name: {'halfM': half, 'n': n} for name, half, n in TERRAIN},
            'checks': checks,
        }
        # terrain.bin: fine then coarse grid, float32 heights relative to origin.elevationM, row 0 = south
        with open(os.path.join(stage, 'terrain.bin'), 'wb') as f:
            for name, _, _ in TERRAIN:
                f.write(((grids[name] + (z0 - z_tr)) - z0).astype(np.float32).tobytes())
        wjson(os.path.join(stage, 'surroundings.json'), {'buildings': buildings, 'hidden': hidden, 'roads': roads, 'source': '© OpenStreetMap contributors (ODbL)'})
        # visual demolition footprint (docs/DEMOLITION.md): measured once per site, carried into every revision of the project
        if proj.get('demolition') and os.path.exists(os.path.join(HERE, proj['demolition'])):
            shutil.copyfile(os.path.join(HERE, proj['demolition']), os.path.join(stage, 'demolition.json'))
        for n in ('geometry.bin.gz', 'model.json', 'props.json.gz', 'audit.json', 'meta.json'):
            shutil.copy2(os.path.join(export, n), stage)
        wjson(os.path.join(stage, 'alignment.json'), alignment, indent=1)
        status = 'failed' if fails else 'validated'
        revision = {'id': rid, 'project': ident, 'status': status, 'createdUtc': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'document': getattr(a, 'document', None) or meta['document'],
                    'sourceModel': getattr(a, 'source_model', None), 'fragments': fragments,
                    'sourceExport': export, 'exportedUtc': meta['exportedUtc'], 'elements': meta['elements'], 'triangles': meta['triangles'],
                    'warnings': len(warns), 'failures': len(fails), 'published': False}
        wjson(os.path.join(stage, 'revision.json'), revision, indent=1)
    except Exception as ex:
        checks.append({'check': 'Build', 'status': 'FAIL', 'detail': f'{type(ex).__name__}: {ex}'})
        print('  [FAIL] build:', ex)
        revision = {'id': rid, 'project': ident, 'status': 'failed', 'createdUtc': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'sourceExport': export, 'published': False}
        wjson(os.path.join(stage, 'revision.json'), revision, indent=1)
        wjson(os.path.join(stage, 'checks.json'), checks, indent=1)
    if revision['status'] != 'validated' and not os.path.exists(os.path.join(stage, 'checks.json')):
        wjson(os.path.join(stage, 'checks.json'), checks, indent=1)

    dest = os.path.join(D, rid) if revision['status'] == 'validated' else os.path.join(D, '_failed', rid)
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    os.replace(stage, dest)
    update_index(proj)
    print(f"\ncandidate revision {proj['id']}/{rid}: {revision['status'].upper()}" + (f" ({revision.get('warnings', 0)} warnings)" if revision['status'] == 'validated' else ''))
    print(f"   preview : http://localhost:8766/viewer/?project={proj['id']}&rev={rid}" if revision['status'] == 'validated' else f'   report  : {dest}')
    print(f"   publish : python publish.py --project {proj['id']} publish {rid}" if revision['status'] == 'validated' else '   the published revision was NOT changed')
    return 0 if revision['status'] == 'validated' else 1


def export(a):
    """Revit -> geometry: the installed 4898 add-in runs its own 'siteexport' harness step on a SCRATCH copy of the model."""
    import subprocess
    runner = os.path.abspath(a.runner)
    repo = os.path.dirname(os.path.dirname(runner))
    runs = os.path.join(repo, 'autotest-runs')
    before = set(os.listdir(runs)) if os.path.isdir(runs) else set()
    print('Revit starts and shows "Security - Unsigned Add-In" for 4898: a person must choose Load Once.')
    cmd = ['powershell', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', runner, '-StagingSource', os.path.abspath(a.rvt), '-Steps', 'startup,' + ('fragexport-lite' if a.lite else 'fragexport' if a.fragments else 'siteexport')]
    cand = [d for d in (a.project_root, project(getattr(a, 'project', None)).get('harnessProjectRoot'), os.path.join(os.path.dirname(repo), 'projects', 'ARON_TERRACE')) if d]
    proj = next((d for d in cand if os.path.exists(os.path.join(d, '4898.project.json'))), None)
    if proj:
        cmd += ['-ProjectRoot', proj]          # the harness needs a 4898 project to register the scratch copy against (the scratch copy is registered, the project file is copied)
    if a.timeout_min:
        cmd += ['-TimeoutMin', str(a.timeout_min)]
    r = subprocess.run(cmd)
    new = sorted(set(os.listdir(runs)) - before) if os.path.isdir(runs) else []
    out = next((os.path.join(runs, n, 'site-export') for n in reversed(new) if os.path.exists(os.path.join(runs, n, 'site-export', 'meta.json'))), None)
    if not out:
        print(f'export FAILED (runner exit {r.returncode}): no complete site-export in {runs}; the published revision is unchanged')
        return 1
    print('export complete:', out)
    if a.fragments or a.lite:
        ifc = os.path.join(os.path.dirname(out), 'ifc', 'model.ifc')
        if not os.path.exists(ifc):
            print('export FAILED: the harness wrote no IFC; nothing was built')
            return 1
        a.ifc = ifc
    import hashlib
    h = hashlib.sha256()
    with open(a.rvt, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    a.document = os.path.splitext(os.path.basename(a.rvt))[0]
    a.source_model = {'path': os.path.abspath(a.rvt), 'sha256': h.hexdigest(), 'bytes': os.path.getsize(a.rvt), 'note': 'exported from a scratch copy by the 4898 harness; the source file is never opened or changed'}
    a.export = out
    return build(a)


def update_index(p=None):
    """Rewrites the project's indexes from its folders: <project>/index.json (+ the legacy top-level index.json for the legacy
    project only) and the catalogue projects.json. Another project's files are never written."""
    p = p or project()
    D = pdir(p)
    os.makedirs(D, exist_ok=True)
    rows = []
    for d in sorted(os.listdir(D)):
        f = os.path.join(D, d, 'revision.json')
        if not d.startswith(('.', '_')) and os.path.exists(f):
            rows.append(rjson(f))
    pub = rjson(os.path.join(D, 'published.json')) if os.path.exists(os.path.join(D, 'published.json')) else None
    if p.get('legacy'):           # the exact pre-project format, which older branches and the production viewer read
        wjson_atomic(os.path.join(REV, 'index.json'), {'published': pub and pub['revision'], 'revisions': rows[::-1]})
    failed = []
    fd = os.path.join(D, '_failed')
    for d in sorted(os.listdir(fd)) if os.path.isdir(fd) else []:
        rj, cj = os.path.join(fd, d, 'revision.json'), os.path.join(fd, d, 'checks.json')
        r = rjson(rj) if os.path.exists(rj) else {}
        cs = rjson(cj) if os.path.exists(cj) else []
        failed.append({'id': d, 'path': prel(p) + '_failed/' + d + '/', 'createdUtc': r.get('createdUtc'),
                       'reasons': [f"{c['check']}: {c['detail']}" for c in cs if c.get('status') == 'FAIL'][:5]})
    rel = prel(p)
    os.makedirs(os.path.join(REV, p['id']), exist_ok=True)
    wjson_atomic(os.path.join(REV, p['id'], 'index.json'), {
        'schema': 'lsv-project-index/1', 'project': {'id': p['id'], 'name': p['name'], 'address': p.get('address')},
        'published': pub and pub['revision'], 'publishedUtc': pub and pub.get('publishedUtc'),
        'revisions': [{**r, 'project': r.get('project') or {'id': p['id'], 'name': p['name'], 'address': p.get('address')}, 'path': rel + r['id'] + '/'} for r in rows[::-1]],
        'failed': failed[::-1]})
    write_catalogue()


def write_catalogue():
    """<revisions>/projects.json: every configured project with its published / latest revision (read from each project's index)."""
    cfg = rjson(PROJECTS)
    out = []
    for p in cfg['projects']:
        f = os.path.join(REV, p['id'], 'index.json')
        ix = rjson(f) if os.path.exists(f) else {'published': None, 'revisions': [], 'failed': []}
        out.append({'id': p['id'], 'name': p['name'], 'address': p.get('address'), 'index': p['id'] + '/index.json',
                    'published': ix['published'], 'publishedUtc': ix.get('publishedUtc'), 'latest': ix['revisions'][0]['id'] if ix['revisions'] else None,
                    'revisions': len(ix['revisions']), 'failed': len(ix.get('failed', []))})
    wjson_atomic(os.path.join(REV, 'projects.json'), {'schema': 'lsv-projects/1', 'default': cfg['default'], 'projects': out})


def publish(a):
    pr = project(getattr(a, 'project', None))
    D = pdir(pr)
    d = os.path.join(D, a.revision)
    p = os.path.join(d, 'revision.json')
    if not os.path.exists(p):
        sys.exit(f"no revision {a.revision} in project {pr['id']} (failed builds live in {prel(pr)}_failed and cannot be published)")
    r = rjson(p)
    owner = (r.get('project') or {}).get('id') or (pr['id'] if pr.get('legacy') else None)
    if owner != pr['id']:
        sys.exit(f"revision {a.revision} belongs to project {owner!r}, not {pr['id']!r}; not published")
    if r['status'] != 'validated':
        sys.exit(f"revision {a.revision} is {r['status']}; only validated revisions can be published")
    for n in ('geometry.bin.gz', 'model.json', 'props.json.gz', 'alignment.json', 'terrain.bin', 'surroundings.json') + (('model.frag',) if r.get('fragments') else ()):
        if not os.path.exists(os.path.join(d, n)):
            sys.exit(f'revision {a.revision} is missing {n}; not published')
    r['published'] = True
    r['publishedUtc'] = time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())
    wjson(p, r, indent=1)
    wjson_atomic(os.path.join(D, 'published.json'), {'revision': a.revision, 'publishedUtc': r['publishedUtc'], **({} if pr.get('legacy') else {'project': pr['id']})}, indent=None)
    update_index(pr)
    print(f"published {pr['id']}/{a.revision}: http://localhost:8766/viewer/?project={pr['id']}")


def list_(a):
    pr = project(getattr(a, 'project', None))
    update_index(pr)
    ix = rjson(os.path.join(REV, pr['id'], 'index.json'))
    print(f"project {pr['id']} ({pr['name']}): {len(ix['revisions'])} revisions, published {ix['published']}, {len(ix['failed'])} failed")
    for r in ix['revisions']:
        print(f"{r['id']}  {r['status']:9}  {'PUBLISHED' if r['id'] == ix['published'] else '         '}  {r.get('document', '')}  {r.get('elements', '')} elements  {r.get('warnings', '')} warnings")
    for f in ix['failed']:
        print(f"{f['id']}  failed     ({f['path']})  {'; '.join(f['reasons'])[:160]}")


def selftest(_=None):
    # probes of a model rotated 30 deg with a shared offset: the derived transform must reproduce them
    th = math.radians(30)
    R = np.array([[math.cos(th), -math.sin(th)], [math.sin(th), math.cos(th)]])
    off = np.array([1000.0, -250.0])
    pr = [{'eastWest': (R @ p + off)[0], 'northSouth': (R @ p + off)[1], 'elevation': 12.0, 'angleRad': th} for p in (np.zeros(2), np.array([100.0, 0]), np.array([0, 100.0]))]
    meta = {'projectPositionProbes': pr, 'projectBasePoint': {'position': [10, 20, 0], 'shared': list(R @ [10, 20] + off) + [12.0]},
            'surveyPoint': {'position': [0, 0, 0], 'shared': list(off) + [12.0]}}
    A, t, how, res = internal_to_shared(meta)
    assert how == 'project-position probes' and max(res.values()) < 1e-9, res
    assert abs(math.degrees(math.atan2(A[1, 0], A[0, 0])) - 30) < 1e-9
    # minimum rectangle of a 40 x 10 box rotated 25 deg
    c, s = math.cos(math.radians(25)), math.sin(math.radians(25))
    box = [(x * c - y * s, x * s + y * c) for x, y in ((0, 0), (40, 0), (40, 10), (0, 10))]
    ang, w, l, _ = min_rect(hull(box))
    assert abs(ang - 25) < 1e-6 and abs(w - 10) < 1e-6 and abs(l - 40) < 1e-6, (ang, w, l)
    assert point_in_poly(1, 1, [(0, 0), (2, 0), (2, 2), (0, 2)]) and not point_in_poly(3, 1, [(0, 0), (2, 0), (2, 2), (0, 2)])
    selftest_projects()
    print('selftest passed')


def selftest_projects():
    """Project layout in a temp folder (no network, no real data): a legacy project 'a' and a namespaced project 'b'."""
    import tempfile
    global REV, PROJECTS
    saved, tmp = (REV, PROJECTS), tempfile.mkdtemp(prefix='lsv-selftest-')
    A = argparse.Namespace
    try:
        REV, PROJECTS = os.path.join(tmp, 'rev'), os.path.join(tmp, 'projects.json')
        os.makedirs(REV)
        wjson(PROJECTS, {'default': 'a', 'projects': [{'id': 'a', 'name': 'A', 'legacy': True}, {'id': 'b', 'name': 'B'}]})

        def fake(parent, rid, proj=None):
            d = os.path.join(parent, rid)
            os.makedirs(d)
            for n in ('geometry.bin.gz', 'model.json', 'props.json.gz', 'alignment.json', 'terrain.bin', 'surroundings.json'):
                open(os.path.join(d, n), 'wb').write(b'x')
            wjson(os.path.join(d, 'revision.json'), {'id': rid, 'status': 'validated', 'published': False, **({'project': {'id': proj}} if proj else {})}, indent=1)

        def legacy_bytes():
            return {f: open(os.path.join(REV, *f.split('/')), 'rb').read() for f in ('index.json', 'published.json', 'L1/revision.json', 'L1/model.json')}

        fake(REV, 'L1')                                             # like the existing Vestibule revisions: no project field
        publish(A(project='a', revision='L1'))
        ix = rjson(os.path.join(REV, 'index.json'))
        assert set(ix) == {'published', 'revisions'} and ix['published'] == 'L1', ix          # legacy format unchanged
        before = legacy_bytes()
        fake(os.path.join(REV, 'b'), 'B1', 'b')
        publish(A(project='b', revision='B1'))
        assert legacy_bytes() == before, 'publishing b changed project a'
        for pid, rid in (('b', 'L1'), ('a', 'B1'), ('b', 'nope')):            # cross-project / unknown: refused
            try:
                publish(A(project=pid, revision=rid))
                raise AssertionError(f'{pid} published {rid}')
            except SystemExit:
                pass
        broken = os.path.join(tmp, 'broken')
        os.makedirs(broken)
        wjson(os.path.join(broken, 'meta.json'), {'format': 'x'})
        rc = build(A(project='b', export=broken, address=None, survey=None, site=None, ifc=None, floor_above_grade=0.0))
        assert rc == 1 and len(os.listdir(os.path.join(REV, 'b', '_failed'))) == 1
        assert rjson(os.path.join(REV, 'b', 'published.json'))['revision'] == 'B1', 'a failed build changed the published revision'
        bx = rjson(os.path.join(REV, 'b', 'index.json'))
        assert bx['published'] == 'B1' and [r['path'] for r in bx['revisions']] == ['b/B1/'] and len(bx['failed']) == 1 and bx['failed'][0]['reasons'], bx
        assert legacy_bytes() == before, 'a failed build of b changed project a'
        cat = {p['id']: p for p in rjson(os.path.join(REV, 'projects.json'))['projects']}
        assert cat['a']['published'] == 'L1' and cat['b']['published'] == 'B1' and cat['b']['failed'] == 1 and cat['a']['index'] == 'a/index.json', cat
        assert [r['path'] for r in rjson(os.path.join(REV, 'a', 'index.json'))['revisions']] == ['L1/']
    finally:
        REV, PROJECTS = saved
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == '__main__':
    sys.stdout.reconfigure(errors="replace")      # survey text (Δ, °) must never crash a build on a cp1252 console
    ap = argparse.ArgumentParser()
    ap.add_argument('--project', help='project id from projects.json (default: its "default", the legacy Vestibule project)')
    sp = ap.add_subparsers(dest='cmd', required=True)
    b = sp.add_parser('build'); b.add_argument('export'); b.add_argument('--address', help="default: the project's address in projects.json")
    b.add_argument('--site'); b.add_argument('--floor-above-grade', type=float, default=0.0)
    b.add_argument('--survey', help='survey reference (surveys/*.json): surveyed lot bearing, civil first-floor elevation, offsets, with provenance')
    b.add_argument('--document', help='display name of the source model (the harness scratch copy has another name)')
    b.add_argument('--ifc', help='whole-model IFC from the fragexport harness step: converted to Fragments and checked against the exported GlobalIds')
    p = sp.add_parser('publish'); p.add_argument('revision')
    e = sp.add_parser('export', help='run Revit through the 4898 test harness on a scratch copy of the .rvt, then build a candidate revision')
    e.add_argument('rvt'); e.add_argument('--address'); e.add_argument('--site'); e.add_argument('--survey')
    e.add_argument('--floor-above-grade', type=float, default=0.0); e.add_argument('--project-root'); e.add_argument('--timeout-min', type=int, help='harness timeout (a large model needs more than the default 90)')
    e.add_argument('--fragments', action='store_true', help='also export a whole-model IFC and build the Fragments model (needs the fragments-poc add-in build)')
    e.add_argument('--lite', action='store_true', help='fragexport-lite: background open, no meshes (bounding boxes, ids, properties) + IFC, for a model too heavy to triangulate (MADERA)')
    e.add_argument('--runner', default=r'C:\4898_project\astra_app\4898-automation\4898-fragpoc\scripts\run-revit-regression.ps1')
    sp.add_parser('list'); sp.add_parser('selftest')
    a = ap.parse_args()
    sys.exit({'build': build, 'export': export, 'publish': publish, 'list': list_, 'selftest': selftest}[a.cmd](a) or 0)
