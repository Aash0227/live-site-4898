// Proof of concept: Revit Vestibule model as That Open Fragments + 3D Tiles terrain/imagery in ONE Three.js scene.
// Query: ?depth=log (logarithmic depth buffer), ?tiles=0 (no terrain), ?view=top|iso
import * as THREE from 'three';
import * as FRAGS from '@thatopen/fragments';
import workerUrl from '@thatopen/fragments/worker?url';
import { egm96ToEllipsoid, meanSeaLevel } from 'egm96-universal';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TilesRenderer, WGS84_ELLIPSOID } from '3d-tiles-renderer';
import { QuantizedMeshPlugin, ImageOverlayPlugin, XYZTilesOverlay, ReorientationPlugin } from '3d-tiles-renderer/plugins';

const Q = new URLSearchParams(location.search);
const LOGDEPTH = Q.get('depth') === 'log';
const WITH_TILES = Q.get('tiles') !== '0';
const D = '/data/vestibule/';
const FT = 0.3048;
const TERRAIN_URL = 'https://terrain.reearth.land/cesium-mesh/ellipsoid/';
const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';

// The keyless Re:Earth terrain host throttles bursts (God's Eye View ships a retry policy for it): retry 429 / 5xx / network errors with backoff.
const netStats = { terrainOk: 0, terrainRetries: 0, terrainGaveUp: 0, esriOk: 0, esriFail: 0 };
const _fetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : (input.href || input.url || String(input));
  if (url.includes('server.arcgisonline.com')) { try { const r = await _fetch(input, init); r.ok ? netStats.esriOk++ : netStats.esriFail++; return r; } catch (e) { netStats.esriFail++; throw e; } }
  if (!url.includes('terrain.reearth.land')) return _fetch(input, init);
  for (let a = 0; a < 7; a++) {
    try { const r = await _fetch(input, init); if (r.status !== 429 && r.status < 500) { netStats.terrainOk++; return r; } } catch (e) { /* retry */ }
    netStats.terrainRetries++; await new Promise((res) => setTimeout(res, 300 * 2 ** a + Math.random() * 200));
  }
  netStats.terrainGaveUp++; return _fetch(input, init);
};
const hud = document.getElementById('hud');
const say = (t) => { hud.textContent = t; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const state = { t: {}, notes: [] };

// ── scene ────────────────────────────────────────────────────────────────────────────────────────
const renderer = new THREE.WebGLRenderer({ antialias: true, logarithmicDepthBuffer: LOGDEPTH, preserveDrawingBuffer: true });
renderer.setPixelRatio(1);
document.body.appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x9fb4c8);
const camera = new THREE.PerspectiveCamera(50, 1, 0.5, 30000);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = false;
scene.add(new THREE.HemisphereLight(0xdfe9ff, 0x6b6250, 1.1));
const sun = new THREE.DirectionalLight(0xfff3df, 2.2); sun.position.set(120, 200, 80); scene.add(sun);
function resize() { const w = innerWidth, h = innerHeight; renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); }
addEventListener('resize', resize); resize();
setPose([85, 62, 105], [0, 14, 0]);
function setPose(pos, target) { camera.position.set(...pos); controls.target.set(...target); controls.update(); camera.updateMatrixWorld(true); }

// ── data ─────────────────────────────────────────────────────────────────────────────────────────
const align = await (await fetch(D + 'alignment.json')).json();
const site = await (await fetch(D + 'site-export/model.json')).json();
const byIfc = new Map(site.elements.filter((e) => e.ifc).map((e) => [e.ifc, e]));
const L = new THREE.Matrix4().fromArray(align.internalToLocalM);          // Revit internal feet -> local metres (x east, y up, z south)
let propsCache = null;
async function props() {
  if (propsCache) return propsCache;
  const r = await fetch(D + 'site-export/props.json.gz');
  const txt = await new Response(r.body.pipeThrough(new DecompressionStream('gzip'))).text();
  return (propsCache = JSON.parse(txt));
}

// ── Fragments ────────────────────────────────────────────────────────────────────────────────────
say('loading Fragments...');
const frags = new FRAGS.FragmentsModels(workerUrl);
let t0 = performance.now();
const fragBuf = await (await fetch(D + 'model.frag')).arrayBuffer();
state.fragBytes = fragBuf.byteLength;     // the buffer is transferred to the worker on load
state.t.fragFetchMs = Math.round(performance.now() - t0);
t0 = performance.now();
const model = await frags.load(fragBuf, { modelId: 'vestibule', camera });
state.t.fragLoadMs = Math.round(performance.now() - t0);
scene.add(model.object);
await frags.update(true);

// IFC GlobalId -> Fragments localId for every exporter element
const guids = [...byIfc.keys()];
t0 = performance.now();
const localIds = await model.getLocalIdsByGuids(guids);
state.t.guidMapMs = Math.round(performance.now() - t0);
const idOfGuid = new Map(); const guidOfId = new Map();
guids.forEach((g, i) => { if (localIds[i] != null) { idOfGuid.set(g, localIds[i]); guidOfId.set(localIds[i], g); } });

// Fragments space -> Revit internal feet: a signed axis permutation fitted on element centres (Y-up metres to Z-up feet)
const allMatched = [...idOfGuid.keys()];
const allBoxes = await model.getBoxes(allMatched.map((g) => idOfGuid.get(g)));
const finite = (b) => [b.min.x, b.min.y, b.min.z, b.max.x, b.max.y, b.max.z].every(Number.isFinite);
const matched = allMatched.filter((g, i) => finite(allBoxes[i]));          // stair assemblies carry no geometry of their own
const boxes = allBoxes.filter(finite);
state.noGeometry = allMatched.length - matched.length;
function centreOfBb(b) { return [(b[0] + b[3]) / 2, (b[1] + b[4]) / 2, (b[2] + b[5]) / 2]; }
const P = matched.map((g) => centreOfBb(byIfc.get(g).bb));                  // target, internal ft
const p = boxes.map((b) => [(b.min.x + b.max.x) / 2, (b.min.y + b.max.y) / 2, (b.min.z + b.max.z) / 2]);   // Fragments, metres
function fitAxes() {
  const perms = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
  let best = null;
  for (const pm of perms) for (let s = 0; s < 8; s++) {
    const sg = [s & 1 ? -1 : 1, s & 2 ? -1 : 1, s & 4 ? -1 : 1];
    const R = [[0, 0, 0], [0, 0, 0], [0, 0, 0]]; for (let i = 0; i < 3; i++) R[i][pm[i]] = sg[i];
    const det = R[0][0] * (R[1][1] * R[2][2] - R[1][2] * R[2][1]) - R[0][1] * (R[1][0] * R[2][2] - R[1][2] * R[2][0]) + R[0][2] * (R[1][0] * R[2][1] - R[1][1] * R[2][0]);
    if (det < 0) continue;
    const q = p.map((v) => [0, 1, 2].map((i) => (R[i][0] * v[0] + R[i][1] * v[1] + R[i][2] * v[2]) / FT));
    const tr = [0, 1, 2].map((i) => P.reduce((a, x, k) => a + x[i] - q[k][i], 0) / P.length);
    let ss = 0; P.forEach((x, k) => { for (let i = 0; i < 3; i++) { const d = x[i] - q[k][i] - tr[i]; ss += d * d; } });
    const rms = Math.sqrt(ss / P.length);
    if (!best || rms < best.rms) best = { R, tr, rms, perm: pm, signs: sg };
  }
  return best;
}
const fit = fitAxes();
const F2FT = new THREE.Matrix4().set(
  fit.R[0][0] / FT, fit.R[0][1] / FT, fit.R[0][2] / FT, fit.tr[0],
  fit.R[1][0] / FT, fit.R[1][1] / FT, fit.R[1][2] / FT, fit.tr[1],
  fit.R[2][0] / FT, fit.R[2][1] / FT, fit.R[2][2] / FT, fit.tr[2],
  0, 0, 0, 1);
const M = new THREE.Matrix4().multiplyMatrices(L, F2FT);
M.decompose(model.object.position, model.object.quaternion, model.object.scale);
model.object.updateMatrixWorld(true);
state.fit = { rmsMm: +(fit.rms * FT * 1000).toFixed(2), perm: fit.perm, signs: fit.signs, translationFt: fit.tr.map((v) => +v.toFixed(3)), matched: matched.length, of: guids.length };

// ── 3D Tiles: terrain + imagery, placed with the survey alignment ───────────────────────────────
let tiles = null, terrainHeightAtOrigin = null;
// survey ground (NAVD88, treated as EGM96 orthometric) -> ellipsoidal height, so local y = 0 is the survey ground
const geoidN = meanSeaLevel(align.origin.lat, align.origin.lon);
const groundEllipsoid = egm96ToEllipsoid(align.origin.lat, align.origin.lon, align.origin.elevationM);
if (WITH_TILES) {
  say('starting tiles...');
  tiles = new TilesRenderer(TERRAIN_URL);
  tiles.registerPlugin(new QuantizedMeshPlugin({ useRecommendedSettings: true }));
  tiles.registerPlugin(new ImageOverlayPlugin({ renderer, overlays: [new XYZTilesOverlay({ url: ESRI, levels: 19, projection: 'EPSG:3857' })] }));
  tiles.registerPlugin(new ReorientationPlugin({ up: '+y', lat: align.origin.lat * Math.PI / 180, lon: align.origin.lon * Math.PI / 180, height: groundEllipsoid, azimuth: Number(Q.get('az') ?? Math.PI) }));
  tiles.downloadQueue.maxJobs = 8;
  tiles.setCamera(camera);
  tiles.setResolutionFromRenderer(camera, renderer);
  scene.add(tiles.group);
}

// ── loop ─────────────────────────────────────────────────────────────────────────────────────────
const frameLog = [];
let measuring = false;
renderer.setAnimationLoop(() => {
  const a = performance.now();
  controls.update();
  camera.updateMatrixWorld();
  frags.update();
  if (tiles) { tiles.setCamera(camera); tiles.setResolutionFromRenderer(camera, renderer); tiles.update(); }
  renderer.render(scene, camera);
  if (measuring) frameLog.push(performance.now() - a);
});

// ── selection ────────────────────────────────────────────────────────────────────────────────────
const hl = { color: new THREE.Color(0xffb02e), renderedFaces: FRAGS.RenderedFaces.TWO, opacity: 1, transparent: false };
let lastSel = null;
async function pickAt(clientX, clientY) {
  const r = renderer.domElement.getBoundingClientRect();
  const mouse = new THREE.Vector2(clientX - r.left, clientY - r.top);
  const res = await model.raycast({ camera, mouse, dom: renderer.domElement });
  return res;
}
let down = null;
renderer.domElement.addEventListener('pointerdown', (e) => { down = [e.clientX, e.clientY]; });
renderer.domElement.addEventListener('pointerup', async (e) => {
  if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 4) return;
  const res = await pickAt(e.clientX, e.clientY);
  const box = document.getElementById('sel');
  if (lastSel != null) { await model.resetHighlight([lastSel]); lastSel = null; }
  if (!res) { box.style.display = 'none'; return; }
  lastSel = res.localId; await model.highlight([res.localId], hl);
  const [g] = await model.getGuidsByLocalIds([res.localId]);
  const el = byIfc.get(g); const pr = await props();
  const idx = el ? site.elements.indexOf(el) : -1;
  const par = idx >= 0 ? Object.entries(pr.elements[idx] || {}).slice(0, 8).map(([k, v]) => `  ${k}: ${v}`).join('\n') : '';
  box.style.display = 'block';
  box.textContent = `IFC GlobalId ${g}\nlocalId ${res.localId}  hit ${res.distance.toFixed(1)} m\n` + (el ? `Revit ElementId ${el.id}\nUniqueId ${el.uid}\n${el.cat} | ${el.type}\n${par}` : 'no exporter element for this GlobalId');
});

// ── helpers for tests ────────────────────────────────────────────────────────────────────────────
const gl = renderer.getContext();
function pixelAt(nx, ny) { // normalised device coords -> rgb of the last frame
  const x = Math.round((nx * 0.5 + 0.5) * (renderer.domElement.width - 1)), y = Math.round((ny * 0.5 + 0.5) * (renderer.domElement.height - 1));
  const b = new Uint8Array(4); gl.readPixels(x, y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, b); return [b[0], b[1], b[2]];
}
const renderNow = async () => { await frags.update(true); renderer.render(scene, camera); };
async function streamed(minMs = 2500) {          // Fragments streams tiles from its worker after the camera moves
  await sleep(minMs); let last = -1, same = 0;
  for (let i = 0; i < 40 && same < 4; i++) { let n = 0; model.object.traverse((o) => { if (o.isMesh) n++; }); same = n === last ? same + 1 : 0; last = n; await sleep(250); }
  await frags.update(true);
}
async function settle(maxMs = 45000, quietMs = 2500) {
  const end = performance.now() + maxMs; let quietSince = null;
  while (performance.now() < end) {
    await sleep(250);
    const busy = tiles ? ((tiles.stats.downloading + tiles.stats.parsing) > 0 || tiles.stats.visible < 20) : false;
    if (busy) quietSince = null; else if (quietSince == null) quietSince = performance.now(); else if (performance.now() - quietSince > quietMs) return true;
  }
  return false;
}
const sceneCentre = (g) => { const b = byIfc.get(g).bb; return new THREE.Vector3(...centreOfBb(b)).applyMatrix4(L); };   // Revit centre in scene space
const rand = (() => { let s = 12345; return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296; })();
const pct = (arr, q) => { const a = [...arr].sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.floor(q * a.length))]; };

const tests = {
  async identity() {
    const back = await model.getGuidsByLocalIds([...idOfGuid.values()].slice(0, 2000));
    const roundTrip = back.filter((g, i) => g === [...idOfGuid.keys()][i]).length;
    const cats = {}; for (const g of guids) { const c = byIfc.get(g).cat; cats[c] = cats[c] || { total: 0, matched: 0 }; cats[c].total++; if (idOfGuid.has(g)) cats[c].matched++; }
    return { exporterElements: guids.length, matchedInFragments: idOfGuid.size, roundTripOk: roundTrip, byCategory: cats };
  },
  async fidelity() {
    const d = [], ex = [];
    matched.forEach((g, k) => {
      const e = byIfc.get(g).bb, b = boxes[k];
      const lo = new THREE.Vector3(b.min.x, b.min.y, b.min.z).applyMatrix4(F2FT), hi = new THREE.Vector3(b.max.x, b.max.y, b.max.z).applyMatrix4(F2FT);
      const fmin = [Math.min(lo.x, hi.x), Math.min(lo.y, hi.y), Math.min(lo.z, hi.z)], fmax = [Math.max(lo.x, hi.x), Math.max(lo.y, hi.y), Math.max(lo.z, hi.z)];
      let worst = 0; for (let i = 0; i < 3; i++) { worst = Math.max(worst, Math.abs(fmin[i] - e[i]), Math.abs(fmax[i] - e[i + 3])); }
      d.push(worst * FT * 1000);   // mm, worst bbox corner deviation
      ex.push(Math.abs((fmax[0] - fmin[0]) * (fmax[1] - fmin[1]) * (fmax[2] - fmin[2]) - (e[3] - e[0]) * (e[4] - e[1]) * (e[5] - e[2])) / Math.max(1e-6, (e[3] - e[0]) * (e[4] - e[1]) * (e[5] - e[2])));
    });
    const within = (mm) => d.filter((v) => v <= mm).length;
    return { elements: d.length, worstCornerMm: { median: +pct(d, 0.5).toFixed(1), p95: +pct(d, 0.95).toFixed(1), max: +Math.max(...d).toFixed(1) },
      within1cm: within(10), within5cm: within(50), within25cm: within(250), boxVolumeRelDiffMedian: +pct(ex, 0.5).toFixed(4) };
  },
  async selection(n = 120) {
    setPose([85, 62, 105], [0, 14, 0]); await renderNow();
    const cand = matched.map((g) => ({ g, c: sceneCentre(g) })).filter((o) => { const v = o.c.clone().project(camera); return Math.abs(v.x) < 0.95 && Math.abs(v.y) < 0.95 && v.z < 1; });
    const pick = []; while (pick.length < Math.min(n, cand.length)) { const o = cand.splice(Math.floor(rand() * cand.length), 1)[0]; pick.push(o); }
    const r = renderer.domElement.getBoundingClientRect(); const out = { tried: pick.length, hit: 0, targetHit: 0, pointInsideHitBox: 0, resolvedToRevit: 0, ms: [] };
    const boxOfLocal = new Map(); matched.forEach((g, k) => boxOfLocal.set(idOfGuid.get(g), boxes[k]));
    for (const o of pick) {
      const v = o.c.clone().project(camera); const sx = (v.x * 0.5 + 0.5) * r.width, sy = (-v.y * 0.5 + 0.5) * r.height;
      const t1 = performance.now(); const res = await pickAt(r.left + sx, r.top + sy); out.ms.push(performance.now() - t1);
      if (!res) continue; out.hit++;
      if (res.localId === idOfGuid.get(o.g)) out.targetHit++;
      const b = boxOfLocal.get(res.localId);
      if (b) { const pt = res.point.clone().applyMatrix4(model.object.matrixWorld.clone().invert()); const tol = 0.05;
        if (pt.x >= b.min.x - tol && pt.x <= b.max.x + tol && pt.y >= b.min.y - tol && pt.y <= b.max.y + tol && pt.z >= b.min.z - tol && pt.z <= b.max.z + tol) out.pointInsideHitBox++; }
      const [gg] = await model.getGuidsByLocalIds([res.localId]); if (gg && byIfc.has(gg)) out.resolvedToRevit++;
    }
    out.pickMsMedian = +pct(out.ms, 0.5).toFixed(1); out.pickMsP95 = +pct(out.ms, 0.95).toFixed(1); delete out.ms; return out;
  },
  async occlusion() {
    const res = {};
    // 1. probe test: a red sphere between camera and a BIM element must hide it, behind it must not
    setPose([85, 62, 105], [0, 14, 0]); model.object.visible = true; await renderNow();
    const cand = matched.map((g) => ({ g, c: sceneCentre(g) })).filter((o) => { const v = o.c.clone().project(camera); return Math.abs(v.x) < 0.3 && Math.abs(v.y) < 0.3 && v.z < 1; });
    const o = cand[0]; const dir = o.c.clone().sub(camera.position); const dist = dir.length(); dir.normalize();
    const v = o.c.clone().project(camera);
    const probe = new THREE.Mesh(new THREE.SphereGeometry(2.5, 24, 16), new THREE.MeshBasicMaterial({ color: 0xff0000 })); scene.add(probe);
    const red = (px) => px[0] > 200 && px[1] < 60 && px[2] < 60;
    probe.position.copy(camera.position).addScaledVector(dir, dist * 0.5); await renderNow(); res.probeInFront = pixelAt(v.x, v.y); res.probeInFrontIsRed = red(res.probeInFront);
    probe.position.copy(o.c).addScaledVector(dir, 12); await renderNow(); res.probeBehind = pixelAt(v.x, v.y); res.probeBehindIsRed = red(res.probeBehind);
    scene.remove(probe);
    // 2. terrain test: a basement element seen from outside at ground level must be hidden by the terrain, an upper element must not
    if (tiles) {
      await settle();
      const ray = new THREE.Raycaster(); const hits = (x, z) => { ray.set(new THREE.Vector3(x, 400, z), new THREE.Vector3(0, -1, 0)); const h = ray.intersectObject(tiles.group, true); return h.length ? h[0].point.y : null; };
      res.terrainYAtOrigin = hits(0, 0);
      const below = matched.map((g) => ({ g, c: sceneCentre(g) })).filter((q) => { const gy = hits(q.c.x, q.c.z); return gy != null && q.c.y < gy - 2.5; });
      const above = matched.map((g) => ({ g, c: sceneCentre(g) })).filter((q) => { const gy = hits(q.c.x, q.c.z); return gy != null && q.c.y > gy + 8; });
      res.elementsBelowTerrain = below.length; res.elementsAboveTerrain = above.length;
      const test = async (q) => {
        if (!q) return null;
        const outDir = new THREE.Vector3(q.c.x, 0, q.c.z).normalize(); if (outDir.lengthSq() < 0.01) outDir.set(1, 0, 0);
        const camPos = q.c.clone().addScaledVector(outDir, 60); const gy = hits(camPos.x, camPos.z) ?? 0; camPos.y = Math.max(gy + 1.7, q.c.y);
        camera.position.copy(camPos); controls.target.copy(q.c); controls.update(); camera.updateMatrixWorld(true);
        const vv = q.c.clone().project(camera);
        model.object.visible = true; await streamed(); await renderNow(); const withM = pixelAt(vv.x, vv.y);
        model.object.visible = false; await renderNow(); const without = pixelAt(vv.x, vv.y); model.object.visible = true;
        const same = withM.every((c, i) => Math.abs(c - without[i]) < 6);
        return { withModel: withM, withoutModel: without, modelHidden: same, cameraY: +camPos.y.toFixed(1), elementY: +q.c.y.toFixed(1), terrainY: gy };
      };
      res.basementSeenFromOutside = await test(below.sort((a, b) => a.c.y - b.c.y)[0]);
      res.upperSeenFromOutside = await test(above.sort((a, b) => b.c.y - a.c.y)[Math.floor(above.length / 2)]);
    }
    return res;
  },
  async coords() {
    if (!tiles) return { skipped: true };
    await settle(30000, 1500);
    const inv = tiles.group.matrixWorld.clone().invert(); const out = {};
    const carto = (v) => { const c = {}; WGS84_ELLIPSOID.getPositionToCartographic(v.clone().applyMatrix4(inv), c); return { lat: c.lat * 180 / Math.PI, lon: c.lon * 180 / Math.PI, h: c.height }; };
    const o = carto(new THREE.Vector3(0, 0, 0)); const e = carto(new THREE.Vector3(100, 0, 0)); const n = carto(new THREE.Vector3(0, 0, -100)); const up = carto(new THREE.Vector3(0, 100, 0));
    const mLat = 111132, mLon = 111320 * Math.cos(o.lat * Math.PI / 180);
    out.originLatLon = [o.lat, o.lon]; out.expectedLatLon = [align.origin.lat, align.origin.lon];
    out.originErrorM = +Math.hypot((o.lat - align.origin.lat) * mLat, (o.lon - align.origin.lon) * mLon).toFixed(3);
    out.eastStepM = [+((e.lon - o.lon) * mLon).toFixed(2), +((e.lat - o.lat) * mLat).toFixed(2)];      // want about [100, 0]
    out.northStepM = [+((n.lon - o.lon) * mLon).toFixed(2), +((n.lat - o.lat) * mLat).toFixed(2)];     // want about [0, 100] for scene -z
    out.upStepM = +(up.h - o.h).toFixed(2);
    out.terrainEllipsoidHeightAtSite = null;
    const ray = new THREE.Raycaster(); ray.set(new THREE.Vector3(0, 400, 0), new THREE.Vector3(0, -1, 0)); const h = ray.intersectObject(tiles.group, true);
    if (h.length) { out.terrainYAtOrigin = +h[0].point.y.toFixed(2); out.reorientationHeight = +groundEllipsoid.toFixed(3); out.egm96N = +geoidN.toFixed(2); out.terrainEllipsoidHeightAtSite = +(h[0].point.y + groundEllipsoid).toFixed(2); out.terrainMinusSurveyGroundM = +h[0].point.y.toFixed(2); }
    out.surveyGroundNAVD88m = align.origin.elevationM; out.impliedGeoidUndulationM = out.terrainEllipsoidHeightAtSite != null ? +(out.terrainEllipsoidHeightAtSite - align.origin.elevationM).toFixed(2) : null;
    return out;
  },
  async perf() {
    const poses = { iso: [[85, 62, 105], [0, 14, 0]], close: [[40, 12, 55], [0, 6, 0]], far: [[900, 700, 1100], [0, 0, 0]] }; const out = {};
    for (const [k, [pos, tg]] of Object.entries(poses)) {
      setPose(pos, tg); await settle(30000, 1500); frameLog.length = 0; measuring = true; renderer.info.reset();
      const t = performance.now(); const f0 = renderer.info.render.frame; await sleep(3000); measuring = false;
      const secs = (performance.now() - t) / 1000, frames = renderer.info.render.frame - f0;
      const vis = { m: model.object.visible }; model.object.visible = false; renderer.info.reset(); await renderNow(); const tilesTri = renderer.info.render.triangles; model.object.visible = true;
      if (tiles) tiles.group.visible = false; renderer.info.reset(); await renderNow(); const fragTri = renderer.info.render.triangles, fragCalls = renderer.info.render.calls; if (tiles) tiles.group.visible = true;
      renderer.info.reset(); await renderNow();
      out[k] = { fps: +(frames / secs).toFixed(1), cpuMsMean: +(frameLog.reduce((a, b) => a + b, 0) / Math.max(1, frameLog.length)).toFixed(2), cpuMsP95: +pct(frameLog, 0.95).toFixed(2),
        drawCalls: renderer.info.render.calls, triangles: renderer.info.render.triangles, fragmentsTriangles: fragTri, fragmentsDrawCalls: fragCalls, tilesTriangles: tilesTri,
        tilesLoaded: tiles ? tiles.stats.visible : 0, geometries: renderer.info.memory.geometries, textures: renderer.info.memory.textures };
    }
    out.heapMB = performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null; return out;
  },
};

window.__poc = { THREE, FRAGS, tests, state, netStats, model, frags, scene, camera, renderer, controls, tiles, byIfc, idOfGuid, setPose, L, F2FT, M,
  async runAll() { const r = { depthMode: LOGDEPTH ? 'log' : 'linear', tiles: WITH_TILES, load: state.t, fit: state.fit, fragBytes: state.fragBytes }; for (const k of ['identity', 'fidelity', 'selection', 'occlusion', 'coords', 'perf']) { try { r[k] = await tests[k](); } catch (e) { r[k] = { error: String(e && e.stack || e) }; } } return r; } };
say(`ready. Fragments ${(state.fragBytes / 1024).toFixed(0)} KB, load ${state.t.fragLoadMs} ms; ${idOfGuid.size}/${guids.length} GlobalIds matched; fit rms ${state.fit.rmsMm} mm\nclick an element; window.__poc.runAll()`);
