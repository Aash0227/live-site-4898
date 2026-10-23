// Project-namespaced revisions: Madera end to end + isolation from Vestibule. Exits non-zero on any failed check.
//   node scripts/test-projects.mjs [--revisions data/revisions] [--project madera] [--no-isolation]
// 1. catalogue + per-project index contract (docs/PROJECTS.md), legacy index.json format kept
// 2. identity: every exported GlobalId -> Fragments localId (SingleThreadedFragmentsModel, the viewer's library) -> its IFC Tag = the Revit ElementId,
//    per category and for the QA/QC-checked elements (hold downs, shear walls, columns, beams)
// 3. alignment sanity: footprint inside / near the lot polygon, ground vs Mapterhorn terrain at the geocoded point, first floor above ground
// 4. isolation (temp copy of the revisions): publishing / failing the project never changes Vestibule's files (SHA-256), a forced failure keeps
//    the last valid published revision, cross-project and failed publications are refused
import { readFile, mkdtemp, cp, rm, readdir, stat, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as F from '@thatopen/fragments';

const HERE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : d; };
const REV = path.resolve(arg('--revisions', path.join(HERE, 'data', 'revisions')));
const PID = arg('--project', 'madera');
const FT = 0.3048;
const results = [];
const check = (name, ok, detail) => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: ${detail}`); };
const rj = async (p) => JSON.parse(await readFile(p, 'utf8'));
const sha = async (p) => createHash('sha256').update(await readFile(p)).digest('hex');
async function files(dir, skip = () => false) {
  const out = [];
  for (const n of await readdir(dir)) {
    const p = path.join(dir, n);
    if (skip(n)) continue;
    if ((await stat(p)).isDirectory()) out.push(...(await files(p)).map((x) => path.join(n, x)));
    else out.push(n);
  }
  return out.sort();
}
// the legacy project's own files: top-level revision folders, index.json, published.json (never the project folders or the catalogue)
async function legacyHashes(rev, legacyIds) {
  const h = {};
  for (const n of ['index.json', 'published.json']) if (existsSync(path.join(rev, n))) h[n] = await sha(path.join(rev, n));
  for (const id of legacyIds) for (const f of await files(path.join(rev, id))) h[`${id}/${f}`] = await sha(path.join(rev, id, f));
  return h;
}
const diff = (a, b) => [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => a[k] !== b[k]);

// Mapterhorn terrain (terrarium WebP, z16) at a point, decoded by Python/PIL (node has no WebP decoder)
function mapterhorn(lat, lon) {
  const py = `import io,math,sys,urllib.request
from PIL import Image
lat,lon=float(sys.argv[1]),float(sys.argv[2]);z=16;n=2**z
x=(lon+180)/360*n;y=(1-math.log(math.tan(math.radians(lat))+1/math.cos(math.radians(lat)))/math.pi)/2*n
b=urllib.request.urlopen(urllib.request.Request(f'https://tiles.mapterhorn.com/{z}/{int(x)}/{int(y)}.webp',headers={'User-Agent':'livio-4898-site-viewer/0.2'}),timeout=30).read()
im=Image.open(io.BytesIO(b)).convert('RGB');S=im.size[0];r,g,bb=im.getpixel((int((x-int(x))*S),int((y-int(y))*S)))
print(r*256+g+bb/256-32768)`;
  return +execFileSync('python', ['-I', '-c', py, String(lat), String(lon)], { encoding: 'utf8' }).trim();
}

function pointInPoly(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [x1, y1] = poly[i], [x2, y2] = poly[j];
    if ((y1 > y) !== (y2 > y) && x < ((x2 - x1) * (y - y1)) / (y2 - y1 + 1e-12) + x1) inside = !inside;
  }
  return inside;
}
function distToPoly(x, y, poly) {
  let best = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [x1, y1] = poly[j], [x2, y2] = poly[i], dx = x2 - x1, dy = y2 - y1, L2 = dx * dx + dy * dy || 1e-12;
    const u = Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / L2));
    best = Math.min(best, Math.hypot(x - x1 - u * dx, y - y1 - u * dy));
  }
  return best;
}

const t0 = Date.now();
// ── 1. catalogue and index contract ──────────────────────────────────────────────────────────────
const cat = await rj(path.join(REV, 'projects.json'));
const byId = Object.fromEntries(cat.projects.map((p) => [p.id, p]));
check('catalogue lists vestibule and the project', byId.vestibule && byId[PID], cat.projects.map((p) => `${p.id}: published ${p.published}, ${p.revisions} revisions, ${p.failed} failed`).join('; '));
const legacy = await rj(path.join(REV, 'index.json'));
check('legacy index.json keeps its format', JSON.stringify(Object.keys(legacy).sort()) === '["published","revisions"]' && legacy.revisions.every((r) => existsSync(path.join(REV, r.id, 'revision.json'))),
  `{published: ${legacy.published}, revisions: [${legacy.revisions.map((r) => r.id)}]}`);
const vix = await rj(path.join(REV, 'vestibule', 'index.json'));
check('vestibule project index = the legacy revisions', JSON.stringify(vix.revisions.map((r) => r.id)) === JSON.stringify(legacy.revisions.map((r) => r.id)) && vix.published === legacy.published
  && vix.revisions.every((r) => r.path === r.id + '/'), vix.revisions.map((r) => r.path).join(', '));
const pix = await rj(path.join(REV, PID, 'index.json'));
const revId = pix.published || pix.revisions.find((r) => r.status === 'validated')?.id;
const base = path.join(REV, PID, revId || 'none');
check(`${PID} has a validated revision`, revId && pix.revisions.every((r) => r.path === `${PID}/${r.id}/` && r.project?.id === PID) && existsSync(path.join(base, 'model.frag')),
  `published ${pix.published}, using ${revId}; ${pix.revisions.length} revisions, ${pix.failed.length} failed`);
if (!revId) process.exit(1);
const rev = await rj(path.join(base, 'revision.json'));
const align = await rj(path.join(base, 'alignment.json'));
const model = await rj(path.join(base, 'model.json'));
check('revision.json carries the project identity', rev.project?.id === PID && rev.status === 'validated', JSON.stringify(rev.project));
const fails = align.checks.filter((c) => c.status === 'FAIL');
check('no FAIL check in the revision', fails.length === 0, `${align.checks.length} checks: ${['PASS', 'WARN', 'INFO', 'FAIL'].map((s) => `${align.checks.filter((c) => c.status === s).length} ${s}`).join(', ')}`);

// ── 2. identity: GlobalId -> Fragments localId -> IFC Tag (= Revit ElementId) ────────────────────
const fm = new F.SingleThreadedFragmentsModel('t', new Uint8Array(await readFile(path.join(base, 'model.frag'))));
const els = model.elements.filter((e) => e.ifc);
const lids = fm.getLocalIdsByGuids(els.map((e) => e.ifc));
const found = els.map((e, k) => [e, lids[k]]).filter(([, l]) => l != null);
const data = fm.getItemsData(found.map(([, l]) => l), { attributesDefault: false, attributes: ['Tag', 'Name'] });
const tagOk = found.filter(([e], k) => String(data[k]?.Tag?.value ?? '') === String(e.id));
const per = {};
for (const e of els) (per[e.cat] ??= { exported: 0, fragments: 0, tag: 0 }).exported++;
for (const [e] of found) per[e.cat].fragments++;
for (const [e] of tagOk) per[e.cat].tag++;
const proxies = els.filter((e) => e.detail === 'BoundingBoxProxy').length;
console.log('      per category (exported / in Fragments / Tag = ElementId):\n' + Object.entries(per).sort((a, b) => b[1].exported - a[1].exported).map(([c, v]) => `        ${c}: ${v.exported} / ${v.fragments} / ${v.tag}`).join('\n'));
check('every GlobalId found in Fragments has the right Revit ElementId (IFC Tag)', tagOk.length === found.length, `${tagOk.length} of ${found.length} (${els.length} exported with a GlobalId, ${proxies} bounding-box proxies)`);
check('Fragments coverage matches the build report', found.length === rev.fragments.matched, `${found.length} resolved here, ${rev.fragments.matched} in revision.json`);
const q = rev.fragments.qaqc?.categories || {};
const idsIn = new Set(found.map(([e]) => e.id));
for (const [name, v] of Object.entries(q)) {
  check(`QA/QC ${name}: element ids round-trip`, v.inIfc === v.elementIds, `${v.inIfc} of ${v.elementIds} ids of ${v.presentRows} PRESENT rows in the IFC (${JSON.stringify(v.categories)})`);
}
const qaqcIds = Object.values(q).length;
check('QA/QC reference categories present', qaqcIds >= 4, Object.keys(q).join(', ') || 'none (projects.json qaqcResult missing?)');

// ── 3. alignment sanity ──────────────────────────────────────────────────────────────────────────
const M = align.internalToLocalM;                           // column-major 4x4: internal feet -> local metres (x east, y up, z south)
const toLocal = (x, y, z) => [M[0] * x + M[4] * y + M[8] * z + M[12], M[1] * x + M[5] * y + M[9] * z + M[13], M[2] * x + M[6] * y + M[10] * z + M[14]];
const core = model.elements.filter((e) => ['Walls', 'Floors', 'Roofs', 'Structural Framing', 'Structural Columns', 'Structural Foundations'].includes(e.cat) && !e.link);
const pts = core.flatMap((e) => { const b = e.bb; return [[b[0], b[1]], [b[3], b[1]], [b[3], b[4]], [b[0], b[4]]].map(([x, y]) => toLocal(x, y, b[2])); }).map(([x, , z]) => [x, -z]);
const lot = align.lot?.cornersLocalEN_m;
if (lot) {
  const inside = pts.filter(([x, y]) => pointInPoly(x, y, lot)).length;
  const worst = Math.max(...pts.filter(([x, y]) => !pointInPoly(x, y, lot)).map(([x, y]) => distToPoly(x, y, lot)), 0);
  check('footprint inside / near the lot', inside / pts.length >= 0.95 && worst <= 3, `${inside} of ${pts.length} core bounding-box corners inside the lot polygon; worst outside ${worst.toFixed(2)} m (limit 3 m: placement is not survey-grade)`);
  check('footprint centre inside the lot', pointInPoly(0, 0, lot), `lot ${align.lot.source}`);
} else check('lot polygon present', false, 'alignment.lot missing');
const geo = align.geocode?.[0];
const zMt = mapterhorn(geo.lat, geo.lon), zOrigin = mapterhorn(align.origin.lat, align.origin.lon);
check('ground elevation vs Mapterhorn at the geocoded point', Math.abs(align.origin.elevationM - zMt) <= 3,
  `alignment ground ${align.origin.elevationM.toFixed(2)} m (${align.origin.datum}) at the footprint centre; Mapterhorn ${zMt.toFixed(2)} m at the geocode (${geo.source}), ${zOrigin.toFixed(2)} m at the footprint centre`);
const ff = align.vertical;
const lvlY = (elevFt) => toLocal(0, 0, elevFt)[1];
const minY = Math.min(...core.map((e) => toLocal(e.bb[0], e.bb[1], e.bb[2])[1]));
check('first floor sits plausibly above the ground', Number.isFinite(minY) && minY > -4 && minY < 3, `lowest core element at ${minY.toFixed(2)} m relative to the survey ground; vertical: ${ff.mode}`);

// ── 4. isolation in a temp copy ──────────────────────────────────────────────────────────────────
if (!process.argv.includes('--no-isolation')) {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'lsv-projects-'));
  try {
    const T = path.join(tmp, 'revisions');
    await mkdir(T);
    const legacyIds = legacy.revisions.map((r) => r.id);
    for (const n of ['index.json', 'published.json']) if (existsSync(path.join(REV, n))) await cp(path.join(REV, n), path.join(T, n));
    for (const id of legacyIds) await cp(path.join(REV, id), path.join(T, id), { recursive: true });
    await cp(base, path.join(T, PID, revId), { recursive: true });
    const env = { ...process.env, LSV_REVISIONS: T, LSV_CACHE: path.join(tmp, 'cache') };
    const py = (...a) => spawnSync('python', [path.join(HERE, 'publish.py'), ...a], { env, encoding: 'utf8', cwd: HERE });
    const before = await legacyHashes(T, legacyIds);
    const realBefore = await legacyHashes(REV, legacyIds);
    let r = py('--project', PID, 'publish', revId);
    const pub = await rj(path.join(T, PID, 'published.json'));
    check('publish the project revision (temp copy)', r.status === 0 && pub.revision === revId && pub.project === PID, (r.stdout + r.stderr).trim().split('\n').pop());
    const broken = path.join(tmp, 'broken-export');
    await mkdir(broken);
    await writeFile(path.join(broken, 'meta.json'), JSON.stringify({ format: 'site-export/2', complete: false }));
    r = py('--project', PID, 'build', broken);
    const failedDirs = await readdir(path.join(T, PID, '_failed')).catch(() => []);
    const pubAfter = await rj(path.join(T, PID, 'published.json'));
    check('forced failure goes to the project _failed and keeps the last valid revision', r.status === 1 && failedDirs.length === 1 && pubAfter.revision === revId && !existsSync(path.join(T, '_failed')),
      `exit ${r.status}; ${PID}/_failed: ${failedDirs}; published still ${pubAfter.revision}`);
    r = py('--project', PID, 'publish', failedDirs[0] || 'x');
    check('a failed revision cannot be published', r.status !== 0 && (await rj(path.join(T, PID, 'published.json'))).revision === revId, (r.stderr || r.stdout).trim().split('\n').pop());
    r = py('--project', 'vestibule', 'publish', revId);
    check('a Madera revision cannot be published as Vestibule', r.status !== 0, (r.stderr || r.stdout).trim().split('\n').pop());
    r = py('--project', PID, 'list');
    check('per-project list', r.status === 0 && r.stdout.includes(revId) && r.stdout.includes('failed'), r.stdout.trim().split('\n')[0]);
    const after = await legacyHashes(T, legacyIds);
    const d = diff(before, after);
    check('Vestibule files byte-identical after publishing + failing the project (temp copy)', d.length === 0, `${Object.keys(before).length} files hashed; changed: ${d.join(', ') || 'none'}`);
    const tix = await rj(path.join(T, PID, 'index.json'));
    check('project index after the failure', tix.published === revId && tix.failed.length === 1 && tix.failed[0].reasons.length > 0, tix.failed[0]?.reasons[0] || '');
    // the real data folder: rewrite the project's own indexes (list), Vestibule must not change
    r = spawnSync('python', [path.join(HERE, 'publish.py'), '--project', PID, 'list'], { env: { ...process.env, LSV_REVISIONS: REV }, encoding: 'utf8', cwd: HERE });
    const realAfter = await legacyHashes(REV, legacyIds);
    const d2 = diff(realBefore, realAfter);
    check('real data: Vestibule files byte-identical after a project index rewrite', r.status === 0 && d2.length === 0, `${Object.keys(realBefore).length} files hashed; changed: ${d2.join(', ') || 'none'}`);
  } finally { await rm(tmp, { recursive: true, force: true }); }
}

const failed = results.filter((r) => !r.ok);
console.log(JSON.stringify({ project: PID, revision: revId, checks: results.length, failed: failed.length, seconds: +((Date.now() - t0) / 1000).toFixed(1) }));
process.exit(failed.length ? 1 : 0);
