// Live-Site Viewer on Fragments: a published revision (Revit model as That Open Fragments, survey alignment, terrain and imagery
// as 3D Tiles, OSM surroundings, surveyed lot) in ONE Three.js scene. World frame: metres, x east, y up, z south,
// origin = model footprint centre at the survey ground (NAVD88).
import * as THREE from 'three';
import * as FRAGS from '@thatopen/fragments';
import workerUrl from '@thatopen/fragments/worker?url';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TilesRenderer } from '3d-tiles-renderer';
import { QuantizedMeshPlugin, ImageOverlayPlugin, XYZTilesOverlay, ReorientationPlugin } from '3d-tiles-renderer/plugins';
import { egm96ToEllipsoid } from 'egm96-universal';
import { createPhotoreal } from './photoreal.js';
import { createPicker } from './picking.js';
import { installPBR, createLighting, createStyler, createEdges, ENGINEERING, groupOf, SELECT, HOVER } from './materials.js';
import { installFetchRetry } from './net.js';
import { debugLine } from './geostatus.js';
import { createDemolition } from './demolition.js';
import { loadDrawings } from './drawings.js';

const $ = (s) => document.querySelector(s);
const REV_ROOT = '/revisions/';
const FT = 0.3048;
const TERRAIN = 'https://terrain.reearth.land/cesium-mesh/ellipsoid/';
const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const step = (t, f) => { $('#lstep').textContent = t; if (f != null) $('#lbar').style.width = (100 * f).toFixed(1) + '%'; };
const toast = (t, ms = 2200) => { const e = $('#toast'); e.textContent = t; e.classList.add('on'); clearTimeout(toast.t); toast.t = setTimeout(() => e.classList.remove('on'), ms); };
const json = async (u) => { const r = await fetch(u); if (!r.ok) throw new Error(`${u}: HTTP ${r.status}`); return r.json(); };

installFetchRetry();      // bounded retries (backoff + jitter, Retry-After) and accounting for terrain, imagery, ion, Google, Draco: viewer/net.js

// ── renderer, scene ──────────────────────────────────────────────────────────────────────────────
// URL options, each measured in docs/GPU.md: gpu=high|low (WebGL powerPreference), aa=0 (no MSAA), pdb=0 (no preserveDrawingBuffer), dpr=<cap>
const RQ = new URLSearchParams(location.search), DPR_CAP = +RQ.get('dpr') || 2;
const canvas = $('#c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: RQ.get('aa') !== '0', preserveDrawingBuffer: RQ.get('pdb') !== '0', powerPreference: { high: 'high-performance', low: 'low-power' }[RQ.get('gpu')] || 'default' });
renderer.setPixelRatio(Math.min(devicePixelRatio, DPR_CAP));
const scene = new THREE.Scene(); scene.background = new THREE.Color(0x9fb4c8);
const camera = new THREE.PerspectiveCamera(50, 1, 0.5, 40000);
const controls = new OrbitControls(camera, canvas); Object.assign(controls, { enableDamping: false, screenSpacePanning: true, zoomToCursor: true, maxPolarAngle: Math.PI * 0.495 });
const lighting = createLighting({ renderer, scene, camera });
function resize() { const w = canvas.clientWidth || innerWidth, h = canvas.clientHeight || innerHeight; renderer.setPixelRatio(Math.min(devicePixelRatio, DPR_CAP)); renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); lighting.resize(w, h); }
addEventListener('resize', resize); resize();

// ── revision ─────────────────────────────────────────────────────────────────────────────────────
// project + revision (docs/PROJECTS.md): /revisions/projects.json -> <project>/index.json; without a catalogue the legacy single index
const catalog = await fetch(REV_ROOT + 'projects.json').then((r) => (r.ok ? r.json() : null)).catch(() => null);
const proj = catalog ? catalog.projects.find((p) => p.id === (RQ.get('project') || catalog.default)) : null;
if (catalog && !proj) { step(`Unknown project "${RQ.get('project')}". Known: ${catalog.projects.map((p) => p.id).join(', ')}.`, 0); throw new Error('no project'); }
const ix = await json(REV_ROOT + (proj?.index || 'index.json'));
const want = RQ.get('rev') || ix.published || ix.revisions[0]?.id;
if (!want) { step(`No revision found${proj ? ' for ' + proj.name : ''}. Run publish.py${proj ? ' --project ' + proj.id : ''} build / export first.`, 0); throw new Error('no revision'); }
const wantRev = ix.revisions.find((r) => r.id === want);
if (!wantRev) { step(`Revision ${want} is not in ${proj ? proj.name : 'the index'}.`, 0); throw new Error('no such revision'); }
const query = (o) => '?' + new URLSearchParams({ ...(proj ? { project: proj.id } : {}), ...o, ...Object.fromEntries([...RQ].filter(([k]) => !['project', 'rev'].includes(k))) });
if (catalog) for (const p of catalog.projects) $('#projSel').add(new Option(p.name + (p.published ? '' : p.revisions ? ' (no published revision)' : ' (no revisions)'), p.id, false, p.id === proj.id));
else $('#projSel').style.display = 'none';
$('#projSel').onchange = () => { location.search = '?' + new URLSearchParams({ project: $('#projSel').value }); };
for (const r of ix.revisions) $('#revSel').add(new Option(`${r.id}${r.id === ix.published ? ' · published' : ''}`, r.id, false, r.id === want));
$('#revSel').onchange = () => { location.search = query({ rev: $('#revSel').value }); };
const base = REV_ROOT + (wantRev.path || want + '/');
step('revision', 0.02);
const [rev, align, site] = await Promise.all([json(base + 'revision.json'), json(base + 'alignment.json'), json(base + 'model.json')]);
const isPub = want === ix.published;
$('#revChip').textContent = isPub ? 'published' : 'unpublished candidate'; $('#revChip').className = 'chip ' + (isPub ? 'pub' : 'cand');
$('#docName').textContent = rev.document; document.title = `${rev.document} · Live-Site Viewer (Fragments)`;
if (!rev.fragments) { step('This revision has no Fragments model (build it with --ifc).', 0); throw new Error('no fragments'); }
const els = site.elements, L = new THREE.Matrix4().fromArray(align.internalToLocalM);
const byIfc = new Map(els.map((e, i) => [e.ifc, i]).filter(([g]) => g));

// ── Fragments ────────────────────────────────────────────────────────────────────────────────────
step('Fragments model', 0.08);
const frags = new FRAGS.FragmentsModels(workerUrl);
installPBR(frags, site.materials);       // before load: every Fragments material is created physically based from the start
const buf = await (await fetch(base + 'model.frag')).arrayBuffer();
const fragBytes = buf.byteLength;
const model = await frags.load(buf, { modelId: 'revision', camera });
scene.add(model.object); await frags.update(true);
model.tiles.onItemSet.add(({ value }) => { value.castShadow = value.receiveShadow = true; });     // meshes Fragments streams in later
lighting.flagShadows(model.object);
const guids = [...byIfc.keys()];
const lids = await model.getLocalIdsByGuids(guids);
const idOfEl = new Array(els.length).fill(null), elOfLocal = new Map();
guids.forEach((g, k) => { if (lids[k] != null) { const i = byIfc.get(g); idOfEl[i] = lids[k]; elOfLocal.set(lids[k], i); } });
// registration: Fragments space -> Revit internal feet is a signed axis swap plus a translation; fit it on element centres, report the residual
const withId = els.map((e, i) => i).filter((i) => idOfEl[i] != null);
const boxes = await model.getBoxes(withId.map((i) => idOfEl[i]));
const okIdx = withId.filter((_, k) => [boxes[k].min.x, boxes[k].min.y, boxes[k].min.z, boxes[k].max.x, boxes[k].max.y, boxes[k].max.z].every(Number.isFinite));
const okBoxes = boxes.filter((b) => [b.min.x, b.min.y, b.min.z, b.max.x, b.max.y, b.max.z].every(Number.isFinite));
const centre = (b) => [(b[0] + b[3]) / 2, (b[1] + b[4]) / 2, (b[2] + b[5]) / 2];
const P = okIdx.map((i) => centre(els[i].bb)), p = okBoxes.map((b) => [(b.min.x + b.max.x) / 2, (b.min.y + b.max.y) / 2, (b.min.z + b.max.z) / 2]);
function fitAxes() {
  let best = null;
  for (const pm of [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]]) for (let s = 0; s < 8; s++) {
    const sg = [s & 1 ? -1 : 1, s & 2 ? -1 : 1, s & 4 ? -1 : 1]; const R = [[0, 0, 0], [0, 0, 0], [0, 0, 0]]; for (let i = 0; i < 3; i++) R[i][pm[i]] = sg[i];
    const det = R[0][0] * (R[1][1] * R[2][2] - R[1][2] * R[2][1]) - R[0][1] * (R[1][0] * R[2][2] - R[1][2] * R[2][0]) + R[0][2] * (R[1][0] * R[2][1] - R[1][1] * R[2][0]); if (det < 0) continue;
    const q = p.map((v) => [0, 1, 2].map((i) => (R[i][0] * v[0] + R[i][1] * v[1] + R[i][2] * v[2]) / FT));
    const tr = [0, 1, 2].map((i) => P.reduce((a, x, k) => a + x[i] - q[k][i], 0) / P.length);
    let ss = 0; P.forEach((x, k) => { for (let i = 0; i < 3; i++) { const d = x[i] - q[k][i] - tr[i]; ss += d * d; } });
    const rms = Math.sqrt(ss / P.length); if (!best || rms < best.rms) best = { R, tr, rms };
  }
  return best;
}
const fit = fitAxes();
const F2FT = new THREE.Matrix4().set(fit.R[0][0] / FT, fit.R[0][1] / FT, fit.R[0][2] / FT, fit.tr[0], fit.R[1][0] / FT, fit.R[1][1] / FT, fit.R[1][2] / FT, fit.tr[1], fit.R[2][0] / FT, fit.R[2][1] / FT, fit.R[2][2] / FT, fit.tr[2], 0, 0, 0, 1);
new THREE.Matrix4().multiplyMatrices(L, F2FT).decompose(model.object.position, model.object.quaternion, model.object.scale);
model.object.updateMatrixWorld(true); lighting.setSiteBox(model.box);
const registration = { rmsMm: +(fit.rms * FT * 1000).toFixed(2), elements: okIdx.length };

// ── door / window proxies (families with no solid in Revit; boxes from the exporter, labelled) ───
const proxyEls = els.map((e, i) => i).filter((i) => els[i].detail === 'BoundingBoxProxy');
const proxy = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ color: 0xffffff, transparent: true, opacity: 0.55, roughness: 0.6, depthWrite: false }), proxyEls.length);
const proxyMat = proxyEls.map((i) => { const b = els[i].bb; return new THREE.Matrix4().multiplyMatrices(L, new THREE.Matrix4().compose(new THREE.Vector3(...centre(b)), new THREE.Quaternion(), new THREE.Vector3(b[3] - b[0], b[4] - b[1], b[5] - b[2]))); });
proxyMat.forEach((m, k) => proxy.setMatrixAt(k, m)); proxy.instanceMatrix.needsUpdate = true; proxy.frustumCulled = false; scene.add(proxy);
const proxyOfEl = new Map(proxyEls.map((i, k) => [i, k]));

// ── terrain + imagery (3D Tiles) ─────────────────────────────────────────────────────────────────
step('terrain and imagery', 0.3);
const groundEllipsoid = egm96ToEllipsoid(align.origin.lat, align.origin.lon, align.origin.elevationM);      // survey ground NAVD88 as EGM96 orthometric
const tiles = new TilesRenderer(TERRAIN);
tiles.registerPlugin(new QuantizedMeshPlugin({ useRecommendedSettings: true }));
tiles.registerPlugin(new ImageOverlayPlugin({ renderer, overlays: [new XYZTilesOverlay({ url: ESRI, levels: 19, projection: 'EPSG:3857' })] }));
tiles.registerPlugin(new ReorientationPlugin({ up: '+y', lat: align.origin.lat * Math.PI / 180, lon: align.origin.lon * Math.PI / 180, height: groundEllipsoid, azimuth: Math.PI }));
tiles.downloadQueue.maxJobsPerOrigin = 8; tiles.setCamera(camera); tiles.setResolutionFromRenderer(camera, renderer); scene.add(tiles.group);
tiles.addEventListener('load-model', ({ scene: s }) => s.traverse((o) => { if (o.isMesh) o.receiveShadow = true; }));      // the site receives the model's shadow
const ION = import.meta.env?.VITE_CESIUM_ION_TOKEN;      // Cesium ion token for the optional photoreal layer (.env.local)
const photoNote = (t) => { $('#photoNote').textContent = t; };
const demoData = await fetch(base + 'demolition.json').then((r) => (r.ok ? r.json() : null)).catch(() => null);      // absent = nothing to demolish
const demolition = demoData ? createDemolition({ scene, data: demoData }) : null;
const photo = createPhotoreal({ renderer, scene, camera, token: ION, terrain: tiles, lot: align.lot, status: photoNote, demolition, shiftEN: demoData?.registration?.proposedShiftOfGoogleMeshEN_m || null,
  site: { lat: align.origin.lat * Math.PI / 180, lon: align.origin.lon * Math.PI / 180, height: groundEllipsoid } });
const ray = new THREE.Raycaster();      // terrain height probes only: geographic layers are never used for picking (picking.js)
const groundY = (x, z) => { ray.set(new THREE.Vector3(x, 600, z), new THREE.Vector3(0, -1, 0)); const h = ray.intersectObject(tiles.group, true); return h.length ? h[0].point.y : null; };

// ── lot outline and OSM surroundings (built once the terrain is there to sit on) ────────────────
const lotGroup = new THREE.Group(), surroundGroup = new THREE.Group(); scene.add(lotGroup, surroundGroup);
async function placeOnTerrain() {
  for (let i = 0; i < 80; i++) { await sleep(500); if (tiles.stats.visible > 20 && tiles.stats.downloading + tiles.stats.parsing === 0) break; }
  const gy = (x, z) => groundY(x, z) ?? -0.13;
  if (align.lot) {
    const c = align.lot.cornersLocalEN_m, pts = [];
    for (let i = 0; i < 4; i++) { const [e0, n0] = c[i], [e1, n1] = c[(i + 1) % 4]; for (let j = 0; j < 40; j++) { const t = j / 40, E = e0 + (e1 - e0) * t, N = n0 + (n1 - n0) * t; pts.push(new THREE.Vector3(E, gy(E, -N) + 0.3, -N)); } }
    lotGroup.add(new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: 0xffd23f })));
  }
  try {
    const s = await json(base + 'surroundings.json'); const geos = [];
    for (const b of s.buildings) {
      if (b.pts.length < 3) continue;
      const shape = new THREE.Shape(b.pts.map(([x, y]) => new THREE.Vector2(x, y)));
      const g = new THREE.ExtrudeGeometry(shape, { depth: Math.max(b.h - (b.min || 0), 2.5), bevelEnabled: false }); g.rotateX(-Math.PI / 2);
      g.translate(0, Math.min(...b.pts.map(([x, y]) => gy(x, -y))) + (b.min || 0), 0); g.deleteAttribute('uv'); geos.push(g);
    }
    if (geos.length) { const { mergeGeometries } = await import('three/examples/jsm/utils/BufferGeometryUtils.js'); const m = mergeGeometries(geos, false); m.computeVertexNormals(); const o = new THREE.Mesh(m, new THREE.MeshStandardMaterial({ color: 0xe9e4da, roughness: 0.9 })); o.castShadow = o.receiveShadow = true; surroundGroup.add(o); }
  } catch (e) { console.warn('surroundings', e); }
}

// ── visibility (filters, hide, isolate) ──────────────────────────────────────────────────────────
const vis = { cat: new Map(), lvl: new Map(), hidden: new Set(), isolate: null };
for (const e of els) { vis.cat.set(e.cat, true); vis.lvl.set(e.lvl, true); }
const isOn = (i) => (vis.isolate ? vis.isolate.has(i) : vis.cat.get(els[i].cat) && vis.lvl.get(els[i].lvl) && !vis.hidden.has(i));
const isShown = (i) => isOn(i) && (!proxyOfEl.has(i) || $('#optProxy').checked);      // actually drawn (proxies also need their toggle)
let edges = null;
let visJob = Promise.resolve();
function applyVisibility() {
  visJob = visJob.then(async () => {
    const on = els.map((_, i) => isOn(i)); const hide = [], show = [];
    els.forEach((_, i) => { if (idOfEl[i] != null) (on[i] ? show : hide).push(idOfEl[i]); });
    if (vis.isolate) { await model.setVisible(undefined, false); if (show.length) await model.setVisible(show, true); }
    else { await model.resetVisible(); if (hide.length) await model.setVisible(hide, false); }
    const zero = new THREE.Matrix4().makeScale(0, 0, 0);
    proxyEls.forEach((i, k) => proxy.setMatrixAt(k, on[i] && $('#optProxy').checked ? proxyMat[k] : zero)); proxy.instanceMatrix.needsUpdate = true;
    proxy.computeBoundingBox(); proxy.computeBoundingSphere();     // InstancedMesh.raycast culls with a sphere cached at the FIRST raycast: stale once matrices change
    edges?.setVisible(on);
    if (selected >= 0 && !isShown(selected)) await select(-1);
    if (styler.hovered >= 0 && !isShown(styler.hovered)) await styler.hover(-1);
    $('#visCount').textContent = `${on.filter(Boolean).length.toLocaleString()} of ${els.length.toLocaleString()} elements visible`;
  });
  return visJob;
}
function buildFilters() {
  const catN = new Map(), lvlN = new Map(); for (const e of els) { catN.set(e.cat, (catN.get(e.cat) || 0) + 1); lvlN.set(e.lvl, (lvlN.get(e.lvl) || 0) + 1); }
  $('#cats').innerHTML = [...catN].sort((a, b) => b[1] - a[1]).map(([c, n]) => `<label class="item"><input type="checkbox" data-cat="${esc(c)}" checked>${esc(c)}<span class="n">${n.toLocaleString()}</span></label>`).join('');
  const lv = [...lvlN.keys()].sort((a, b) => (site.levels[b]?.elevationFt ?? -1e9) - (site.levels[a]?.elevationFt ?? -1e9));
  $('#lvls').innerHTML = lv.map((l) => `<label class="item"><input type="checkbox" data-lvl="${l}" checked>${esc(site.levels[l]?.name ?? '(no level)')}<span class="n">${lvlN.get(l).toLocaleString()}</span></label>`).join('');
  $('#cats').onchange = (e) => { vis.cat.set(e.target.dataset.cat, e.target.checked); vis.isolate = null; applyVisibility(); };
  $('#lvls').onchange = (e) => { vis.lvl.set(+e.target.dataset.lvl, e.target.checked); vis.isolate = null; applyVisibility(); };
  document.querySelectorAll('[data-all],[data-none]').forEach((a) => (a.onclick = () => { const k = a.dataset.all || a.dataset.none, on = !!a.dataset.all, m = k === 'cat' ? vis.cat : vis.lvl; for (const key of m.keys()) m.set(key, on); vis.isolate = null; syncFilters(); applyVisibility(); }));
}
const syncFilters = () => { document.querySelectorAll('#cats input').forEach((i) => (i.checked = vis.cat.get(i.dataset.cat))); document.querySelectorAll('#lvls input').forEach((i) => (i.checked = vis.lvl.get(+i.dataset.lvl))); };

// ── selection, hover (picking.js: what is drawn under the pointer; materials.js: how it is shown) ─────────────
const styler = createStyler({ model, frags, proxy, proxyEls, idOfEl, els, site });
const picker = createPicker({ canvas, camera, model, proxy, proxyEls, elOfLocal, isOn, proxyShown: () => $('#optProxy').checked, clipPlanes: () => renderer.clippingPlanes,
  sizeOf: (i) => { const b = els[i].bb; return (b[3] - b[0]) * (b[4] - b[1]) * Math.max(b[5] - b[2], 0.01); } });
const pickAt = picker.pickAt;
let selected = -1, props = null, picks = 0;
const loadProps = async () => props || (props = JSON.parse(await new Response((await fetch(base + 'props.json.gz')).body.pipeThrough(new DecompressionStream('gzip'))).text()));
async function select(i, focus = false) {
  selected = i; $('#bHide').disabled = $('#bIsolate').disabled = i < 0;
  const job = styler.select(i);
  if (i < 0) $('#props').innerHTML = '<div class="empty">Click an element to see its Revit identity and parameters.</div>';
  else { await showProps(i); if (focus) focusBox(elementBox(i), 2.2); }
  await job;
}
function elementBox(i) { const b = els[i].bb; return new THREE.Box3(new THREE.Vector3(b[0], b[1], b[2]), new THREE.Vector3(b[3], b[4], b[5])).applyMatrix4(L); }
async function showProps(i) {
  const e = els[i], lv = site.levels[e.lvl]; const rows = (o) => Object.entries(o).map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join('');
  const geom = idOfEl[i] != null ? 'Fragments, from the Revit IFC export' : 'bounding-box proxy: the family has no 3D solid';
  const pr = await loadProps(); const t = pr.types[e.t];
  if (selected !== i) return;       // a newer click won while the parameters were loading
  $('#props').innerHTML = `<h2>${esc(e.type)}</h2><div class="sub">${esc(e.cat)}${e.fam ? ' · ' + esc(e.fam) : ''}</div>
    <div class="actions"><button onclick="LSV.hide()">Hide</button><button onclick="LSV.isolate()">Isolate</button><button onclick="LSV.focus()">Focus</button><button onclick="LSV.copy()">Copy ElementId</button></div>
    <h3>Identity</h3><table>${rows({ ElementId: e.id, UniqueId: e.uid, 'IFC GlobalId': e.ifc || '', Category: e.cat, Family: e.fam || '—', Type: e.type, Level: lv ? lv.name : '(no level)', Geometry: geom })}</table>
    <h3>Instance parameters</h3><table>${rows(pr.elements[i] || {})}</table>${t ? `<h3>Type parameters · ${esc(t.name)}</h3><table>${rows(t.p)}</table>` : ''}`;
  if (innerWidth <= 900) $('#right').classList.add('open');
}
// A click = one primary pointer pressed and released within a few px on the canvas (OrbitControls sees the same events and turns a drag
// into a camera move, never a pick). Multi-touch never picks. Hover picks run one at a time and the newest pointer position wins.
const CLICK_PX = { mouse: 5, pen: 8, touch: 12 };
const ptrs = new Set(); let down = null, hoverAt = null, hoverBusy = false;
canvas.addEventListener('pointerdown', (e) => { ptrs.add(e.pointerId); down = ptrs.size === 1 && e.button === 0 ? { x: e.clientX, y: e.clientY, id: e.pointerId, type: e.pointerType } : null; });
addEventListener('pointerup', async (e) => {
  const d = down; ptrs.delete(e.pointerId); if (!d || d.id !== e.pointerId) return; down = null;
  if (e.target !== canvas || Math.hypot(e.clientX - d.x, e.clientY - d.y) > (CLICK_PX[d.type] ?? 5)) return;
  const i = await pickAt(e.clientX, e.clientY); await select(i); picks++;
});
addEventListener('pointercancel', (e) => { ptrs.delete(e.pointerId); down = null; });
canvas.addEventListener('pointermove', (e) => { if (e.pointerType === 'mouse' && !e.buttons) { hoverAt = [e.clientX, e.clientY]; runHover(); } });
canvas.addEventListener('pointerleave', () => { hoverAt = null; styler.hover(-1); });
async function runHover() {
  if (hoverBusy) return; hoverBusy = true;
  try { while (hoverAt) { const [x, y] = hoverAt; hoverAt = null; const i = await pickAt(x, y); if (!hoverAt) await styler.hover(i); } } finally { hoverBusy = false; }
}
canvas.addEventListener('dblclick', async (e) => { const i = await pickAt(e.clientX, e.clientY); if (i >= 0) await select(i, true); });
window.LSV = {
  hide() { if (selected >= 0) { vis.hidden.add(selected); if (vis.isolate) vis.isolate.delete(selected); return applyVisibility(); } },
  isolate() { if (selected >= 0) { vis.isolate = new Set([selected]); focusBox(elementBox(selected), 2.5); return applyVisibility(); } },
  focus() { if (selected >= 0) focusBox(elementBox(selected), 2.2); },
  copy() { if (selected >= 0) navigator.clipboard?.writeText(String(els[selected].id)).then(() => toast('ElementId copied')); },
  showAll() { vis.hidden.clear(); vis.isolate = null; for (const k of vis.cat.keys()) vis.cat.set(k, true); for (const k of vis.lvl.keys()) vis.lvl.set(k, true); syncFilters(); return applyVisibility(); },
};
$('#search').addEventListener('keydown', async (e) => {
  if (e.key !== 'Enter') return; const q = e.target.value.trim(); if (!q) return;
  const i = els.findIndex((x) => String(x.id) === q || x.uid === q || x.ifc === q); if (i < 0) return toast('No exported element with that ElementId, UniqueId or GlobalId');
  if (!isOn(i)) { vis.isolate = null; vis.hidden.delete(i); vis.cat.set(els[i].cat, true); vis.lvl.set(els[i].lvl, true); syncFilters(); await applyVisibility(); }
  await select(i, true);
});

// ── camera, section, panels ──────────────────────────────────────────────────────────────────────
function focusBox(box, k = 1.6, dir = null) {
  const c = box.getCenter(new THREE.Vector3()), r = Math.max(box.getSize(new THREE.Vector3()).length() / 2, 0.5);
  const d = dir || camera.position.clone().sub(controls.target).normalize(); const dist = r * k / Math.sin(camera.fov * Math.PI / 360);
  controls.target.copy(c); camera.position.copy(c).addScaledVector(d, dist); controls.update();
}
const fitView = (kind) => { const box = model.box.clone(); (kind === 'top' ? focusBox(box, 1.0, new THREE.Vector3(0, 1, 0.0001)) : focusBox(box, 1.25, new THREE.Vector3(0.75, 0.62, 0.85).normalize())); };
$('#bFit').onclick = () => fitView(); $('#bTop').onclick = () => fitView('top'); $('#bIso').onclick = () => fitView('iso');
$('#bHide').onclick = () => LSV.hide(); $('#bIsolate').onclick = () => LSV.isolate(); $('#bShow').onclick = () => LSV.showAll();
addEventListener('keydown', (e) => { if (e.target.matches('input, select, textarea')) return; const k = e.key.toLowerCase(); if (k === 'h') LSV.hide(); else if (k === 'i') LSV.isolate(); else if (k === 'escape') { LSV.showAll(); select(-1); } else if (k === 'f') fitView(); else if (k === 't') fitView('top'); else if (k === '3') fitView('iso'); });
const plane = new THREE.Plane(new THREE.Vector3(0, -1, 0), 14);
function updateSection() { const on = $('#optSection').checked; plane.constant = +$('#secH').value; $('#secLbl').textContent = `${plane.constant.toFixed(2)} m above the survey ground`; renderer.clippingPlanes = on ? [plane] : []; }
$('#optSection').onchange = updateSection; $('#secH').oninput = updateSection; updateSection();
$('#optImagery').onchange = (e) => { tiles.group.visible = e.target.checked; };
$('#optSurround').onchange = (e) => { surroundGroup.visible = e.target.checked; };
// Photoreal replaces the OSM boxes (they would double up with Google's own buildings) and cuts the existing lot out of its mesh.
let surroundBefore = true;
if (!ION) { $('#optPhoto').disabled = true; photoNote('Needs VITE_CESIUM_ION_TOKEN in .env.local (see .env.example); restart the dev server after adding it.'); }
$('#optPhoto').onchange = async (e) => {
  if (e.target.checked) { surroundBefore = $('#optSurround').checked; $('#optSurround').checked = false; surroundGroup.visible = false; await photo.enable(); }
  else { photo.disable(); $('#optSurround').checked = surroundBefore; surroundGroup.visible = surroundBefore; }
};
$('#optCut').onchange = (e) => photo.setCut(e.target.checked);
if (demolition) { $('#optDemoOutline').onchange = (e) => demolition.setOutline(e.target.checked); $('#optAlign').onchange = (e) => photo.setAligned(e.target.checked);
  $('#optAlignLbl').textContent = `Align Google mesh to the survey (measured ${demoData.registration.offsetM.toFixed(2)} m offset)`; }
else document.querySelectorAll('.demo-only').forEach((x) => (x.style.display = 'none'));
const ATTR0 = $('#attr').textContent;
setInterval(() => {      // Google requires its logo and data-provider credits while its tiles are shown
  const a = photo.attributions(), el = $('#attr'); el.textContent = ATTR0;
  if (!a.length) return;
  el.append(' · 3D: ');
  for (const x of a) { if (x.type === 'image') { const i = new Image(); i.src = x.value; i.alt = 'Google'; i.style.cssText = 'height:12px;vertical-align:middle;margin:0 6px'; el.append(i); } else if (x.type === 'string' && x.value) el.append(x.value + ' '); }
  el.append('via Cesium ion');
}, 1000);
$('#optLot').onchange = (e) => { lotGroup.visible = e.target.checked; };
$('#optProxy').onchange = () => applyVisibility();
document.querySelectorAll('.tabs button').forEach((b) => (b.onclick = () => { document.querySelectorAll('.tabs button, .pane').forEach((x) => x.classList.remove('on')); b.classList.add('on'); document.querySelector(`.pane[data-pane="${b.dataset.tab}"]`).classList.add('on'); }));
$('#tglLeft').onclick = () => { $('#left').classList.toggle('open'); $('#right').classList.remove('open'); };
$('#tglRight').onclick = () => { $('#right').classList.toggle('open'); $('#left').classList.remove('open'); };

// ── render modes (materials.js), remembered per browser ─────────────────────────────────────────────
const RKEY = 'lsv.render', RDEF = { mode: 'engineering', edges: true, shadows: true, ao: false };
const rs = (() => { try { const v = { ...RDEF, ...JSON.parse(localStorage.getItem(RKEY) || '{}') }; return ['realistic', 'engineering'].includes(v.mode) ? v : { ...RDEF }; } catch { return { ...RDEF }; } })();
let edgesJob = null;
async function applyRender() {
  $('#modeSel').value = rs.mode; $('#optEdges').checked = rs.edges; $('#optShadows').checked = rs.shadows; $('#optAO').checked = rs.ao;
  try { localStorage.setItem(RKEY, JSON.stringify(rs)); } catch { /* private mode: the choice just isn't remembered */ }
  $('#legend').style.display = rs.mode === 'engineering' ? '' : 'none';
  // first call always restyles: placeholder-only elements need their documented fallback in realistic mode too
  await Promise.all([lighting.set({ mode: rs.mode, shadows: rs.shadows, ao: rs.ao }), styler.mode !== rs.mode || !applyRender.done ? styler.setMode(rs.mode) : null]); applyRender.done = true;
  if (rs.edges && !edgesJob) edgesJob = createEdges({ model, idOfEl }).then((e) => { edges = e; scene.add(e.lines); e.setVisible(els.map((_, i) => isOn(i))); });
  if (edgesJob) { await edgesJob; edges.lines.visible = rs.edges; }
}
function buildLegend() {
  const n = new Map(); for (const e of els) n.set(groupOf(e.cat), (n.get(groupOf(e.cat)) || 0) + 1);
  const row = (c, label, k, cls = '') => `<div class="lg ${cls}"><span class="sw" style="background:${c}"></span>${esc(label)}<span class="n">${k}</span></div>`;
  $('#legend').innerHTML = Object.entries(ENGINEERING).filter(([g]) => n.has(g)).map(([g, v]) => row(v.color, v.label, n.get(g).toLocaleString())).join('')
    + row(SELECT, 'Selected', '', 'hl') + row(HOVER, 'Under the pointer', '');
}
$('#modeSel').onchange = (e) => { rs.mode = e.target.value; applyRender(); };
for (const [id, k] of [['#optEdges', 'edges'], ['#optShadows', 'shadows'], ['#optAO', 'ao']]) $(id).onchange = (e) => { rs[k] = e.target.checked; applyRender(); };

// ── site and audit tabs ──────────────────────────────────────────────────────────────────────────
function siteTab() {
  const o = align.origin, v = align.vertical, gm = `https://www.google.com/maps/@${o.lat.toFixed(6)},${o.lon.toFixed(6)},60m/data=!3m1!1e3`;
  const kv = { Revision: `${rev.id} (${rev.status}${isPub ? ', published' : ''})`, Exported: rev.exportedUtc, ...(rev.sourceModel ? { Source: `${rev.sourceModel.path} · SHA-256 ${rev.sourceModel.sha256.slice(0, 12)}…` } : {}),
    Elements: `${els.length.toLocaleString()} exported · ${registration.elements} registered in Fragments`, 'Fragments file': `${(fragBytes / 1024).toFixed(0)} KB`,
    'Footprint centre': `${o.lat.toFixed(6)}, ${o.lon.toFixed(6)} <a href="${gm}" target="_blank" rel="noopener">compare in Google Maps</a>`, Georeference: align.anchor.mode, 'Ground at centre': `${o.elevationM.toFixed(2)} m ${o.datum}`, Vertical: v.mode };
  $('#siteInfo').innerHTML = Object.entries(kv).map(([k, x]) => `<div class="k">${esc(k)}</div><div class="v">${k === 'Footprint centre' ? x : esc(x)}</div>`).join('');
  const checks = [...align.checks, { check: 'Fragments registration', status: registration.rmsMm < 5 ? 'PASS' : 'WARN', detail: `${registration.elements} element centres from Fragments match the Revit export to ${registration.rmsMm} mm RMS after a signed axis swap and translation` }];
  $('#checks').innerHTML = checks.map((c) => `<div class="check ${c.status}"><b>${esc(c.check)}<span class="st ${c.status}">${c.status}</span></b>${esc(c.detail)}</div>`).join('');
  json(base + 'audit.json').then((a) => { const row = (k, n) => `<label class="item">${esc(k)}<span class="n">${n.toLocaleString()}</span></label>`; $('#audit').innerHTML = `<div class="small" style="margin-bottom:8px">${a.exported.toLocaleString()} exported, ${a.skipped.toLocaleString()} not exported; each one is listed with its reason in audit.json.</div><div class="grp"><div class="grp-h"><span>By reason</span></div><div class="list">${Object.entries(a.byReason).map(([k, n]) => row(k, n)).join('')}</div></div>`; }).catch(() => {});
}

// ── start ────────────────────────────────────────────────────────────────────────────────────────
buildFilters(); siteTab(); await applyVisibility(); buildLegend(); await applyRender();
const drawings = await loadDrawings({ base, L, scene, el: $('#drawings'), tabButton: $('#tabDrawings') });
camera.position.set(85, 62, 105); controls.target.set(0, 14, 0); controls.update(); fitView('iso');
step('ready', 1); $('#loader').classList.add('done');
placeOnTerrain();
if (RQ.get('photo') !== '0' && ION) { $('#optPhoto').checked = true; $('#optPhoto').onchange({ target: $('#optPhoto') }); }      // same path as the Site-tab checkbox
if (RQ.has('debug')) debugLine(renderer);
renderer.setAnimationLoop(() => { controls.update(); camera.updateMatrixWorld(); frags.update(); tiles.setCamera(camera); tiles.setResolutionFromRenderer(camera, renderer); tiles.update(); photo.update(); lighting.render(); });
window.__app = { THREE, photo, demolition, get drawings() { return drawings; }, model, frags, scene, camera, renderer, controls, tiles, els, idOfEl, elOfLocal, vis, select, applyVisibility, registration, proxy, pickAt, picker, styler, lighting, get edges() { return edges; },
  state: () => ({ selected, hovered: styler.hovered, picks, mode: styler.mode }) };
