"""Demolition footprint + site-registration evidence for VESTIBULE (4898 El Camino Real). See docs/DEMOLITION.md.

Inputs
  --capture DIR   output of scripts/demolition-capture.mjs (Google mesh DSM/colour + survey-terrain DTM, top-down, scratch only)
  --pdf FILE      the permit set (SU-3 = page 95, read as vectors; never modified)
  --rev DIR       revision folder (alignment.json; demolition.json is written there)
  --cache DIR     scratch folder for Esri World Imagery tiles (the same public tiles the viewer drapes on the terrain)
Outputs
  <rev>/demolition.json                      polygons in local E,N metres (+ WGS84), provenance, confidence, registration evidence
  surveys/demolition/vestibule-evidence.json the measured numbers only (no Google- or Esri-derived rasters are committed)

Everything here is a measurement on a raster or a vector; the only authored parts are the edge topology of the footprint
(which faces exist, read off the DSM) and the role of each survey line (flagged as interpretation in the output).
Python stdlib + numpy + PyMuPDF + Pillow.
"""
import argparse, json, math, os, urllib.request
import numpy as np
import fitz
from PIL import Image, ImageDraw

FT = 0.3048
SU3_PAGE = 95                       # 1-based page of the ALTA survey sheet SU-3 in the permit set
PT_PER_FT = 4.5                     # SU-3 is 1" = 16' (72 pt = 16 ft), checked below against the 100 ft lot depth


def m_per_deg(lat):
    a, e2, phi = 6378137.0, 6.69437999014e-3, math.radians(lat)
    s = 1 - e2 * math.sin(phi) ** 2
    return (math.pi / 180) * a * (1 - e2) / s ** 1.5, (math.pi / 180) * a * math.cos(phi) / math.sqrt(s)


# ── SU-3 vectors (survey frame: u along the SE lot line from the S corner toward El Camino Real, v toward Jordan Avenue) ──
def su3(pdf):
    page = fitz.open(pdf)[SU3_PAGE - 1]
    rot = page.rotation_matrix                       # page is /Rotate 270: drawings come unrotated
    segs = []
    for d in page.get_drawings():
        for it in d['items']:
            if it[0] == 'l':
                a, b = it[1] * rot, it[2] * rot
                segs.append((a.x, a.y, b.x, b.y, d.get('width') or 0))
    S = np.array(segs)
    horiz = lambda y, w, x0, x1, tol=0.3: S[(abs(S[:, 1] - y) < tol) & (abs(S[:, 3] - y) < tol) & (abs(S[:, 4] - w) < 0.02) & (np.minimum(S[:, 0], S[:, 2]) > x0 - 2) & (np.maximum(S[:, 0], S[:, 2]) < x1 + 2)]
    # lot lines: the two long thick (2.16) lines; Jordan side and SE side
    thick = S[S[:, 4] > 2.0]
    hy = thick[abs(thick[:, 1] - thick[:, 3]) < 0.05]
    ys = sorted({round(y, 1) for y in hy[:, 1]})
    long_rows = [y for y in ys if np.ptp(hy[abs(hy[:, 1] - y) < 0.06][:, [0, 2]]) > 700]
    y_jordan, y_se = min(long_rows), max(long_rows)
    depth_ft = (y_se - y_jordan) / PT_PER_FT
    se = hy[abs(hy[:, 1] - y_se) < 0.06]; x_s, x_e = se[:, [0, 2]].min(), se[:, [0, 2]].max()
    assert abs(depth_ft - 100.0) < 0.2 and abs((x_e - x_s) / PT_PER_FT - 190.0) < 0.3, (depth_ft, (x_e - x_s) / PT_PER_FT)
    u = lambda x: (x - x_s) / PT_PER_FT * FT
    v = lambda y: (y_se - y) / PT_PER_FT * FT
    # neighbouring structure (Lands of Baliweed LLC): thick outline 0.2 ft clear of the SE line
    nb = thick[(abs(thick[:, 1] - thick[:, 3]) < 0.1) & (thick[:, 1] > y_se + 0.3) & (thick[:, 1] < y_se + 2)]
    nb_y, nb_x0, nb_x1 = float(nb[:, 1].mean()), float(nb[:, [0, 2]].min()), float(nb[:, [0, 2]].max())
    # broken edge of pavement (zigzag: 1.14 pt strokes at +-45 deg, 1.5..4.5 pt long) inside the lot
    L = np.hypot(S[:, 2] - S[:, 0], S[:, 3] - S[:, 1]); ang = np.degrees(np.arctan2(S[:, 3] - S[:, 1], S[:, 2] - S[:, 0])) % 180
    zz = S[(abs(S[:, 4] - 1.14) < 0.01) & (L > 1.5) & (L < 4.5) & ((abs(ang - 45) < 12) | (abs(ang - 135) < 12))
           & (np.minimum(S[:, 0], S[:, 2]) > x_s - 5) & (np.maximum(S[:, 0], S[:, 2]) < x_e + 5) & (S[:, 1] > y_jordan - 5) & (S[:, 1] < y_se + 5)]
    zu, zv = u((zz[:, 0] + zz[:, 2]) / 2), v((zz[:, 1] + zz[:, 3]) / 2)
    med = lambda m, c: float(np.median(c[m]))
    bep = {  # each value: median of the zigzag strokes in a band around that edge
        'top_v': med(zv > 29, zv), 'left_u': med((zu > 10) & (zu < 14) & (zv > 12) & (zv < 29), zu), 'right_u': med((zu > 41) & (zu < 44) & (zv > 1) & (zv < 29), zu),
        'bottomleft_v': med((zu > 12.5) & (zu < 17.5) & (zv > 10) & (zv < 13.5), zv), 'notchW_u': med((zu > 17) & (zu < 19.5) & (zv > 12.5) & (zv < 16), zu),
        'notchTop_v': med((zu > 19) & (zu < 28.5) & (zv > 15.5) & (zv < 18), zv), 'notchE_u': med((zu > 28) & (zu < 30) & (zv > 9.5) & (zv < 16), zu),
        'step_v': med((zu > 29.5) & (zu < 34.5) & (zv > 7) & (zv < 9.5), zv), 'legW_u': med((zu > 34) & (zu < 36) & (zv > 1) & (zv < 8), zu),
        'bottom_v': med((zu > 35.5) & (zu < 42) & (zv < 1.5), zv), 'strokes': int(len(zz))}
    b = bep
    bep_poly = [(b['left_u'], b['top_v']), (b['right_u'], b['top_v']), (b['right_u'], b['bottom_v']), (b['legW_u'], b['bottom_v']), (b['legW_u'], b['step_v']),
                (b['notchE_u'], b['step_v']), (b['notchE_u'], b['notchTop_v']), (b['notchW_u'], b['notchTop_v']), (b['notchW_u'], b['bottomleft_v']), (b['left_u'], b['bottomleft_v'])]
    return {'page': SU3_PAGE, 'scalePtPerFt': PT_PER_FT, 'lotDepthFt': round(depth_ft, 3), 'lotSELineFt': round((x_e - x_s) / PT_PER_FT, 3),
            'neighbour': {'clearM': round(-v(nb_y), 3), 'clearFt': round((nb_y - y_se) / PT_PER_FT, 3), 'swEndU': round(u(nb_x0), 3), 'neEndU': round(u(nb_x1), 3),
                          'roofFt': {'swPart': 110.8, 'nePart': 97.3}, 'label': 'NEIGHBORING STRUCTURE, LANDS OF BALIWEED LLC APN 170-03-077 (0.2\' CLEAR)'},
            'brokenEdgeOfPavement': {k: round(x, 3) if isinstance(x, float) else x for k, x in bep.items()}, 'brokenEdgePolygonUV': [[round(a, 3), round(c, 3)] for a, c in bep_poly]}


# ── capture rasters -> lot frame ──────────────────────────────────────────────────────────────────
class Capture:
    def __init__(self, d, frame):
        m = json.load(open(os.path.join(d, 'meta.json')))
        self.px, self.half, self.cx, self.cz = m['px'], m['half'], m['cx'], m['cz']; self.mpp = 2 * self.half / self.px
        rd = lambda n, dt: np.fromfile(os.path.join(d, n), dt)
        self.ndsm = (rd('dsm.f32', np.float32) - rd('dtm.f32', np.float32)).reshape(self.px, self.px)
        lin = rd('ortho.rgba', np.uint8).reshape(self.px, self.px, 4)[..., :3] / 255.0
        self.lum = (np.where(lin <= 0.0031308, 12.92 * lin, 1.055 * lin ** (1 / 2.4) - 0.055) * 255).mean(axis=2)
        self.meta, self.frame = m, frame

    def sample(self, img, U, V):
        E, N = self.frame.en(U, V)
        col = (E - self.cx + self.half) / self.mpp - 0.5; row = (self.half - N - self.cz) / self.mpp - 0.5
        c0 = np.clip(np.floor(col).astype(int), 0, self.px - 2); r0 = np.clip(np.floor(row).astype(int), 0, self.px - 2); fc, fr = col - c0, row - r0
        return (img[r0, c0] * (1 - fc) + img[r0, c0 + 1] * fc) * (1 - fr) + (img[r0 + 1, c0] * (1 - fc) + img[r0 + 1, c0 + 1] * fc) * fr


class Frame:   # viewer lot frame: origin = lot S corner, u along the SE side, v toward Jordan Avenue
    def __init__(self, align):
        c = np.array(align['lot']['cornersLocalEN_m']); self.c0 = c[0]
        self.ue = (c[1] - c[0]) / np.linalg.norm(c[1] - c[0]); self.ve = np.array([-self.ue[1], self.ue[0]])
    def en(self, U, V): return self.c0[0] + U * self.ue[0] + V * self.ve[0], self.c0[1] + U * self.ue[1] + V * self.ve[1]
    def uv_of(self, d_en): return float(np.dot(d_en, self.ue)), float(np.dot(d_en, self.ve))


def crossing(xs, ys, level):
    for k in range(1, len(xs)):
        a, b = ys[k - 1], ys[k]
        if np.isfinite(a) and np.isfinite(b) and (a - level) * (b - level) <= 0 and a != b:
            return xs[k - 1] + (level - a) / (b - a) * (xs[k] - xs[k - 1])
    return None


def edge(cap, along, band, scan, level, step=0.05):
    """Median crossing of `level` (m above the survey terrain) along `along` ('u'|'v') for lines across `band`; scan = (from, to)."""
    hits = []
    for t in np.arange(band[0], band[1], 0.2):
        xs = np.arange(scan[0], scan[1], step if scan[1] > scan[0] else -step)
        U, V = (xs, np.full_like(xs, t)) if along == 'u' else (np.full_like(xs, t), xs)
        c = crossing(xs, cap.sample(cap.ndsm, U, V), level)
        if c is not None: hits.append(c)
    hits = np.array(hits)
    if len(hits) < 3: raise RuntimeError(f'edge not found: {along} {band} {scan} {level}')
    m = np.median(hits); keep = abs(hits - m) < max(3 * np.median(abs(hits - m)), 0.05)
    return {'value': round(float(np.median(hits[keep])), 3), 'spread': round(float(np.percentile(hits[keep], 90) - np.percentile(hits[keep], 10)), 3), 'n': int(keep.sum()), 'of': int(len(hits))}


def footprint(cap):
    """The existing building inside the lot, measured face by face on the Google mesh height (DSM - survey terrain)."""
    roof = 5.9; annex = 3.4
    e = {
        'SW face u': edge(cap, 'u', (14, 28), (9.5, 12.5), roof / 2),
        'NE face (main roof) u': edge(cap, 'u', (12, 18), (40.5, 43), roof / 2),
        'NE face (low annex) u': edge(cap, 'u', (20, 30), (40.5, 43), annex / 2),
        'annex/main roof step u': edge(cap, 'u', (20, 30), (37.5, 40.5), (roof + annex) / 2),
        'annex south end v': edge(cap, 'v', (39.4, 40.8), (17, 20), (6.2 + annex) / 2),
        'NW face (main roof -> trees) v': edge(cap, 'v', (12, 24), (30.0, 32.5), 5.5),
        'NW face (annex -> low strip) v': edge(cap, 'v', (36, 40.4), (31.4, 32.8), 2.5),
        'courtyard north face v': edge(cap, 'v', (16, 30), (13, 10.5), roof / 2),
        'courtyard east face (leg) u': edge(cap, 'u', (4, 10), (30.5, 32.8), roof / 2),
        'leg / neighbour roof step v': edge(cap, 'v', (33, 40), (3.0, 0.6), 5.7),
    }
    # where the low annex starts along the NW face: scan west along v=31.7 until the height leaves annex level +-0.4
    xs = np.arange(41.0, 30.0, -0.05); hs = cap.sample(cap.ndsm, xs, np.full_like(xs, 31.7))
    bad = np.where(abs(hs - annex) > 0.4)[0]; e['annex west end (NW strip) u'] = {'value': round(float(xs[bad[0]]), 3) if len(bad) else 34.0, 'spread': None, 'n': 1, 'of': 1}
    g = {k: v['value'] for k, v in e.items()}
    b = 0.25      # outward buffer for photogrammetric wall skirts; 0 on the face shared with the neighbour
    uSW, uNEm, uNEa, uAs = g['SW face u'] - b, g['NE face (main roof) u'] + b, g['NE face (low annex) u'] + b, g['annex south end v'] + b
    vNWm, vNWa, uAw = g['NW face (main roof -> trees) v'] + b, g['NW face (annex -> low strip) v'] + b, g['annex west end (NW strip) u'] - b
    vCN, uLW, vSE = g['courtyard north face v'] - b, g['courtyard east face (leg) u'] - b, g['leg / neighbour roof step v']
    poly = [(uSW, vCN), (uLW, vCN), (uLW, vSE), (uNEm, vSE), (uNEm, uAs), (uNEa, uAs), (uNEa, vNWa), (uAw, vNWa), (uAw, vNWm), (uSW, vNWm)]
    return e, poly, b


def poly_area(p):
    return 0.5 * abs(sum(x0 * y1 - x1 * y0 for (x0, y0), (x1, y1) in zip(p, p[1:] + p[:1])))


def raster(poly, U, V, step):
    im = Image.new('L', (len(U), len(V)), 0)
    ImageDraw.Draw(im).polygon([((u - U[0]) / step, (V[0] - v) / step) for u, v in poly], fill=1)
    return np.asarray(im).astype(bool)


# ── registration features: survey position vs Google mesh / Esri imagery position, in the viewer lot frame ──
def google_features(cap, sv):
    out = {}
    us, vs = [], []
    for u in np.arange(1, 42, 0.2):
        xs = np.arange(-8, -3, 0.1); roof = np.nanmedian(cap.sample(cap.ndsm, np.full_like(xs, u), xs))
        if not roof > 3: continue
        xs = np.arange(-6, 8, 0.05); c = crossing(xs, cap.sample(cap.ndsm, np.full_like(xs, u), xs), roof / 2)
        if c is not None: us.append(u); vs.append(c)
    us, vs = np.array(us), np.array(vs); p = np.polyfit(us, vs, 1); r = vs - np.polyval(p, us); k = abs(r) < 3 * np.median(abs(r)) + 0.05
    p = np.polyfit(us[k], vs[k], 1); r = vs[k] - np.polyval(p, us[k])
    out['neighbour NW wall'] = {'axis': 'v', 'google': round(float(np.median(vs[k])), 3), 'survey': round(-sv['neighbour']['clearM'], 3),
                                'rotationDeg': round(float(np.degrees(np.arctan(p[0]))), 3), 'rmsM': round(float(np.sqrt((r ** 2).mean())), 3), 'n': int(k.sum()),
                                'how': 'half-roof-height crossing of the Google mesh, 205 transects along the SE lot line; survey: thick outline 0.2 ft outside the SE line (SU-3)'}
    for name, scan, surv in (('neighbour NE end', (36, 52), sv['neighbour']['neEndU']), ('neighbour SW end', (8, -12), sv['neighbour']['swEndU'])):
        hits = []
        for t in np.arange(-14, -2, 0.2):
            ref = np.arange(30, 38, 0.1) if 'NE' in name else np.arange(3, 10, 0.1)
            roof = np.nanmedian(cap.sample(cap.ndsm, ref, np.full_like(ref, t)))
            xs = np.arange(scan[0], scan[1], 0.05 if scan[1] > scan[0] else -0.05); c = crossing(xs, cap.sample(cap.ndsm, xs, np.full_like(xs, t)), roof / 2)
            if c is not None: hits.append(c)
        out[name] = {'axis': 'u', 'google': round(float(np.median(hits)), 3), 'survey': surv, 'n': len(hits), 'how': 'half-roof-height crossing; survey: end of the thick neighbour outline (SU-3)'}
    return out


def esri_fit(frame, align, sv, cache):
    """Ground-level check with a second imagery source: the SU-3 broken edge of pavement is the outline of the cleared pad, which is
    bare soil in the current Esri World Imagery. Grid search of the polygon offset maximising IoU with a soil-colour mask."""
    lat0, lon0 = align['origin']['lat'], align['origin']['lon']; mlat, mlon = m_per_deg(lat0); Z = 19; s = 256 * 2 ** Z
    st = 0.1; U = np.arange(-10, 70, st); V = np.arange(45, -15, -st); UU, VV = np.meshgrid(U, V); E, N = frame.en(UU, VV)
    lat = lat0 + N / mlat; lon = lon0 + E / mlon
    X = (lon + 180) / 360 * s; Y = (1 - np.log(np.tan(np.radians(lat)) + 1 / np.cos(np.radians(lat))) / math.pi) / 2 * s
    tx0, ty0, tx1, ty1 = int(X.min() // 256), int(Y.min() // 256), int(X.max() // 256), int(Y.max() // 256)
    mos = np.zeros(((ty1 - ty0 + 1) * 256, (tx1 - tx0 + 1) * 256, 3), np.uint8); os.makedirs(cache, exist_ok=True)
    for tx in range(tx0, tx1 + 1):
        for ty in range(ty0, ty1 + 1):
            f = os.path.join(cache, f'{Z}_{tx}_{ty}.jpg')
            if not os.path.exists(f):
                req = urllib.request.Request(f'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{Z}/{ty}/{tx}', headers={'User-Agent': 'lsv-demolition-evidence'})
                open(f, 'wb').write(urllib.request.urlopen(req, timeout=30).read())
            mos[(ty - ty0) * 256:(ty - ty0 + 1) * 256, (tx - tx0) * 256:(tx - tx0 + 1) * 256] = np.asarray(Image.open(f).convert('RGB'))
    R = mos[(Y - ty0 * 256).astype(int), (X - tx0 * 256).astype(int)].astype(float)
    soil = (R[..., 0] - R[..., 2] > 18) & (R[..., 0] > 70) & (R[..., 1] - R[..., 2] > 5)
    roi = (UU > 0) & (UU < 57.9) & (VV > -3) & (VV < 33); poly = [tuple(p) for p in sv['brokenEdgePolygonUV']]
    iou = lambda du, dv: (lambda m: (m & soil & roi).sum() / ((m | soil) & roi).sum())(raster([(a + du, b + dv) for a, b in poly], U, V, st))
    best = max(((iou(du, dv), du, dv) for du in np.arange(-4, 4.01, 0.2) for dv in np.arange(-4, 4.01, 0.2)))
    best = max([best] + [(iou(du, dv), du, dv) for du in np.arange(best[1] - 0.3, best[1] + 0.31, 0.05) for dv in np.arange(best[2] - 0.3, best[2] + 0.31, 0.05)])
    return {'iouBest': round(float(best[0]), 3), 'du': round(float(best[1]), 2), 'dv': round(float(best[2]), 2), 'iouAtZero': round(float(iou(0, 0)), 3),
            'how': 'Esri World Imagery z19 (0.24 m/px) resampled into the lot frame; soil = R-B>18, R>70, G-B>5; IoU with the SU-3 broken-edge polygon over the lot; '
                   'shadows on the pad lower the IoU, the NW edge dominates the v estimate'}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--capture', required=True); ap.add_argument('--pdf', required=True); ap.add_argument('--rev', required=True); ap.add_argument('--cache', required=True)
    a = ap.parse_args()
    align = json.load(open(os.path.join(a.rev, 'alignment.json')))
    frame = Frame(align); cap = Capture(a.capture, frame); sv = su3(a.pdf)
    edges, poly_uv, buf = footprint(cap)
    feats = google_features(cap, sv)
    ez = esri_fit(frame, align, sv, a.cache)
    feats['Esri soil pad vs SU-3 broken edge (u)'] = {'axis': 'u', 'google': None, 'survey': None, 'delta': ez['du'], 'how': ez['how']}
    feats['Esri soil pad vs SU-3 broken edge (v)'] = {'axis': 'v', 'google': None, 'survey': None, 'delta': ez['dv'], 'how': ez['how']}
    for f in feats.values():
        if f.get('google') is not None: f['delta'] = round(f['google'] - f['survey'], 3)
    use_u = [f['delta'] for k, f in feats.items() if f['axis'] == 'u']; use_v = [f['delta'] for k, f in feats.items() if f['axis'] == 'v']
    mad = lambda x: 1.4826 * float(np.median(abs(np.array(x) - np.median(x))))
    du, dv = float(np.median(use_u)), float(np.median(use_v))
    d_en = du * frame.ue + dv * frame.ve
    # footprint polygon -> local E,N and WGS84
    lat0, lon0 = align['origin']['lat'], align['origin']['lon']; mlat, mlon = m_per_deg(lat0)
    en = [frame.en(u, v) for u, v in poly_uv]
    # height cap: highest roof equipment inside the footprint + 0.5 m (tree crowns above it are kept)
    st = 0.1; U = np.arange(0, 60, st); V = np.arange(40, -5, -st); UU, VV = np.meshgrid(U, V)
    H = cap.sample(cap.ndsm, UU, VV); inside = raster(poly_uv, U, V, st)
    cap_h = float(np.nanpercentile(H[inside], 99.5)) + 0.5
    # the face shared with the neighbour is exposed once the building is gone: a neutral wall up to the neighbour's roof there
    xs = np.arange(poly_uv[2][0] + 0.3, poly_uv[3][0] - 0.3, 0.1); wall_top = float(np.nanmedian(cap.sample(cap.ndsm, xs, np.full_like(xs, poly_uv[2][1] - 0.6))))
    # designation cross-checks: SU-3 broken edge (post-demolition outline) vs this footprint after the proposed shift
    bep = [(p[0] + du, p[1] + dv) for p in sv['brokenEdgePolygonUV']]
    m_fp, m_bep = inside, raster(bep, U, V, st)
    lot_m = raster([(0, 0), (57.912, 0), (57.912, 30.48), (0, 30.48)], U, V, st)
    lot_true = raster([(du, dv), (57.912 + du, dv), (57.912 + du, 30.48 + dv), (du, 30.48 + dv)], U, V, st)
    checks = {'footprintAreaM2': round(poly_area(poly_uv), 2), 'iouWithBrokenEdgePolygonShifted': round(float((m_fp & m_bep).sum() / (m_fp | m_bep).sum()), 3),
              'footprintInsideViewerLot': round(float((m_fp & lot_m).sum() / m_fp.sum()), 3), 'footprintInsideShiftedLot': round(float((m_fp & lot_true).sum() / m_fp.sum()), 3),
              'convexHullAreaM2': None}
    checks['convexHullAreaM2'] = round(poly_area(_hull(poly_uv)), 2)
    out = {
        'schema': 'lsv-demolition/1', 'project': 'Aron Terrace Apartment, 4898 El Camino Real, Los Altos CA (APN 170-03-085)',
        'frame': {'what': 'viewer local frame: E,N metres from the revision origin (x east, z = -N in the scene); heights relative to the survey ground', 'origin': {'lat': lat0, 'lon': lon0}},
        'polygons': [{
            'id': 'existing-building-1', 'name': 'Existing one-storey commercial building on the lot (to be demolished)',
            'designation': {'status': 'from the drawings', 'sheets': [
                {'sheet': 'C-2.0 Demolition Plan', 'pdfPage': 75, 'text': 'NOTE: ALL EXISTING BUILDINGS, STRUCTURES, AND ON-SITE IMPROVEMENTS ARE PROPOSED TO BE REMOVED; hatched limits of demolition = the lot; keynote 41 DEMOLISH (E) IMPROVEMENTS'},
                {'sheet': 'SU-3 ALTA/NSPS survey (2025-07-23, topo 2025-11-05)', 'pdfPage': 95, 'text': 'no building on the lot any more: BROKEN EDGE OF PAVEMENT outlines the cleared pad; the adjoining NEIGHBORING STRUCTURE (Lands of Baliweed LLC, APN 170-03-077, 0.2 ft clear, RF=110.8 / RF=97.3) is outside the limits of demolition'},
                {'sheet': 'C-? development areas table', 'pdfPage': 81, 'text': 'existing impervious 12,100 sq ft REMOVED'}],
                'note': 'The drawings designate everything on the lot; the viewer removes only the building (the user asked to keep trees, roads and neighbours). The building no longer exists on site (SU-3, current Esri imagery: bare soil); Google\'s mesh predates the demolition.'},
            'method': 'Google Photorealistic 3D Tiles mesh height above the survey terrain (top-down orthographic capture, 0.1 m), each face located by a half-height crossing (median of transects); '
                      f'outward buffer {buf} m except on the face shared with the neighbour; face topology read off the DSM',
            'confidence': 'high for the designation (drawings + three independent sources); footprint faces +-0.15 m in the Google mesh frame',
            'localEN_m': [[round(float(e), 3), round(float(n), 3)] for e, n in en],
            'wgs84': [[round(lat0 + n / mlat, 8), round(lon0 + e / mlon, 8)] for e, n in en],
            'lotFrameUV_m': [[round(u, 3), round(v, 3)] for u, v in poly_uv],
            'maxHeightM': round(cap_h, 2), 'areaM2': checks['footprintAreaM2'],
            'exposedWalls': [{'id': 'party-wall-SE', 'why': 'the building abutted the neighbour here; once removed, the neighbour\'s unseen wall is shown as a neutral wall',
                              'a': [round(float(x), 3) for x in frame.en(poly_uv[2][0], poly_uv[2][1])], 'b': [round(float(x), 3) for x in frame.en(poly_uv[3][0], poly_uv[3][1])], 'topM': round(wall_top, 2)}],
            'faces': edges,
        }],
        'fill': {'material': 'cleared ground (graded soil pad), flat neutral colour #9c8f7c, Lambert, no texture: not imagery (the Esri imagery inside the pad is the photo of the site, the Google texture is the old roof)', 'color': '#9c8f7c', 'wallColor': '#b7b1a6'},
        'registration': {
            'what': 'Where real features (Google mesh, Esri imagery) are relative to where the viewer puts the surveyed lot and the model. delta = google - survey in the viewer lot frame '
                    '(u along the SE lot line toward El Camino Real, v toward Jordan Avenue).',
            'features': feats,
            'estimate': {'du': round(du, 3), 'dv': round(dv, 3), 'sigmaU': round(mad(use_u), 3), 'sigmaV': round(mad(use_v), 3), 'method': 'median of the per-feature deltas, sigma = 1.4826 MAD'},
            'proposedOffsetEN_m': [round(float(d_en[0]), 3), round(float(d_en[1]), 3)], 'proposedOffsetM': round(float(np.hypot(*d_en)), 3),
            'rotationResidualDeg': feats['neighbour NW wall']['rotationDeg'],
            'default': 'not applied (switchable in the viewer: Site > "Registration: shift to the photoreal mesh")',
        },
        'checks': checks,
        'survey': {k: sv[k] for k in sv if k != 'brokenEdgePolygonUV'} | {'brokenEdgePolygonUV': sv['brokenEdgePolygonUV']},
        'generator': 'surveys/demolition/vestibule.py', 'capture': {k: cap.meta.get(k) for k in ('when', 'half', 'px', 'errorTarget', 'calibration', 'gl')},
    }
    json.dump(out, open(os.path.join(a.rev, 'demolition.json'), 'w'), indent=1)
    ev = {k: out[k] for k in ('registration', 'checks', 'survey', 'capture')} | {'faces': edges, 'polygonLotFrameUV_m': out['polygons'][0]['lotFrameUV_m'], 'maxHeightM': out['polygons'][0]['maxHeightM']}
    json.dump(ev, open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'vestibule-evidence.json'), 'w'), indent=1)
    print(json.dumps({'polygonUV': out['polygons'][0]['lotFrameUV_m'], 'checks': checks, 'estimate': out['registration']['estimate'], 'offsetEN': out['registration']['proposedOffsetEN_m'],
                      'deltas': {k: f['delta'] for k, f in feats.items()}, 'maxHeightM': cap_h, 'wallTop': wall_top}, indent=1))


def _chain(P):
    h = []
    for p in P:
        while len(h) >= 2 and (h[-1][0] - h[-2][0]) * (p[1] - h[-2][1]) - (h[-1][1] - h[-2][1]) * (p[0] - h[-2][0]) <= 0: h.pop()
        h.append(p)
    return h


def _hull(pts):
    P = sorted(pts); lo, up = _chain(P), _chain(P[::-1]); return lo[:-1] + up[:-1]


if __name__ == '__main__':
    main()
