// Optional photorealistic surroundings: Google Photorealistic 3D Tiles streamed through Cesium ion, in the same Three.js scene as
// the Fragments model. Lazy on purpose: nothing is requested until the layer is switched on, so page reloads do not spend ion quota.
// Loading is supervised (viewer/geostatus.js): explicit states, bounded retries, actionable errors. See docs/TILES-LOADING.md.
import * as THREE from 'three';
import { TilesRenderer, LRUCache } from '3d-tiles-renderer';
import { CesiumIonAuthPlugin, GLTFExtensionsPlugin, ReorientationPlugin } from '3d-tiles-renderer/plugins';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { backoffMs } from './net.js';
import { classifyError, supervise, createIndicator, watchContext } from './geostatus.js';

export const GOOGLE_ASSET_ID = 2275207;                       // "Google Photorealistic 3D Tiles" on Cesium ion
const DRACO = 'https://www.gstatic.com/draco/versioned/decoders/1.5.7/';
const ROOT_TRIES = 4;                                          // rebuilds after a failed root/session request (on top of the fetch-level retries)

// Tuning, switchable per page load from the URL so every change can be benchmarked (scripts/bench-gpu.mjs, docs/GPU.md):
//   et=<px>   photoreal screen-space error target (default: 20, Google's recommended value set by GoogleCloudAuthPlugin)
//   lru=<MB>  give the photoreal layer its OWN tile cache of this size instead of sharing the default 410 MB one with the terrain
//   jobs=<n>  concurrent downloads per server origin (shared queue; default 8)
const Q = new URLSearchParams(globalThis.location?.search || '');
export const TUNING = { errorTarget: +Q.get('et') || null, cacheMB: +Q.get('lru') || null, jobs: +Q.get('jobs') || 8 };

// Vertical planes around the lot (scene frame: x east, z south), grown by `margin` metres.
// inward: normals point into the lot, so a material clipped by them shows only the lot.
// outward: the same planes flipped; with clipIntersection a material clipped by them loses only the lot (a hole).
export function lotPlanes(cornersEN, margin = 1) {
  const pts = cornersEN.map(([e, n]) => new THREE.Vector3(e, 0, -n));
  const c = pts.reduce((a, p) => a.add(p), new THREE.Vector3()).divideScalar(pts.length);
  const inward = pts.map((p, i) => {
    const pl = new THREE.Plane().setFromCoplanarPoints(p, pts[(i + 1) % pts.length], p.clone().setY(1));
    if (pl.distanceToPoint(c) < 0) pl.negate();
    pl.constant += margin;
    return pl;
  });
  return { inward, outward: inward.map((p) => p.clone().negate()) };
}

// Google's mesh sits some metres off the survey. Sample both surfaces on a grid away from the lot and take a low percentile of
// (photo - terrain): objects only ever push the photo mesh up, so the low end is the ground. Returns the y shift to apply, or null.
export function groundOffset(photo, terrain, { radius = 90, step = 15, skip = () => false, percentile = 0.1 } = {}) {
  const ray = new THREE.Raycaster(), down = new THREE.Vector3(0, -1, 0), d = [];
  const y = (obj, x, z) => { ray.set(new THREE.Vector3(x, 600, z), down); const h = ray.intersectObject(obj, true); return h.length ? h[0].point.y : null; };
  for (let x = -radius; x <= radius; x += step) for (let z = -radius; z <= radius; z += step) {
    if (skip(x, z)) continue;
    const a = y(photo, x, z), b = y(terrain, x, z);
    if (a != null && b != null) d.push(a - b);
  }
  if (d.length < 20) return null;
  d.sort((p, q) => p - q);
  return { offset: -d[Math.floor(d.length * percentile)], samples: d.length, spreadM: d[d.length - 1] - d[0] };
}

export function createPhotoreal({ renderer, scene, camera, token, site, terrain, lot, status = () => {}, demolition = null, shiftEN = null }) {
  renderer.localClippingEnabled = true;
  const root = new THREE.Group(); root.visible = false; scene.add(root);      // root carries the vertical calibration (the tiles group's own matrix is owned by ReorientationPlugin)
  const planes = lot ? lotPlanes(lot.cornersLocalEN_m) : null;
  const P = new THREE.Vector3();
  const inLot = (x, z, pad = 0) => !!planes && planes.inward.every((pl) => pl.distanceToPoint(P.set(x, 0, z)) + pad > 0);
  let photo = null, on = false, cut = true, calib = null, aligned = !!shiftEN;
  const HIDE_ALL = [new THREE.Plane(new THREE.Vector3(0, 1, 0), -1e9)];      // clips everything: the survey terrain under the photoreal mesh

  const eachMat = (obj, fn) => obj.traverse((o) => { if (o.material) [].concat(o.material).forEach(fn); });
  // With a demolition footprint (demolition.js) only the designated building is removed (shader mask) and the survey terrain is hidden
  // under the photoreal mesh; without one, the older lot-wide cut-out (survey terrain shown inside the lot) is kept.
  const clipPhoto = (m) => { if (demolition?.count) { demolition.patch(m); return; } m.clippingPlanes = cut && planes ? planes.outward : null; m.clipIntersection = true; m.needsUpdate = true; };
  const clipTerrain = (m) => { m.clippingPlanes = !on ? null : demolition?.count ? HIDE_ALL : cut && planes ? planes.inward : null; m.needsUpdate = true; };
  const applyShift = () => { const [e, n] = aligned && shiftEN ? shiftEN : [0, 0]; root.position.x = e; root.position.z = -n; root.updateMatrixWorld(true); demolition?.setShift(e, -n); };
  applyShift();
  // forEachLoadedModel, not group.traverse: loaded tiles that are off-screen right now are not in the group but will be later
  const applyClip = () => { photo?.forEachLoadedModel((s) => eachMat(s, clipPhoto)); terrain.forEachLoadedModel((s) => eachMat(s, clipTerrain)); };
  terrain.addEventListener('load-model', ({ scene: s }) => eachMat(s, clipTerrain));

  // ── loading state ─────────────────────────────────────────────────────────────────────────────
  const ui = createIndicator({ actions: { retry: () => api.retry(), retryTerrain: () => { terrainSv.retryNow(); assess(); }, reload: () => location.reload() } });
  const terrainSv = supervise(terrain);
  let sv = null, st = { state: 'idle', detail: '' }, gpuLost = null, failure = null, rootTry = 0, rootTimer = 0, rootRetryAt = 0, rootErr = null;
  let enabledAt = null, lastFrame = performance.now(), lastAssess = 0, calibNote = '', settledWaiters = [], builds = 0;
  watchContext(renderer.domElement, (s) => { gpuLost = s; assess(); });

  function publish(s) {
    st = { ...s, t: performance.now() }; if (s.c) delete st.c; st.counts = s.c || null;
    ui.show(s, on ? 'Photoreal 3D' : 'Terrain');
    if (on) status(`${s.state}${s.detail ? ': ' + s.detail : ''}${calibNote ? '. ' + calibNote : ''}`);
    if (s.state === 'complete' || s.state === 'degraded' || s.state === 'failed' || !on) { const w = settledWaiters; settledWaiters = []; w.forEach((f) => f(s.state)); }
  }
  function assess(now = performance.now()) {
    const ts = terrainSv.assess(now);                                     // keeps the terrain's own failed-tile retries running
    if (gpuLost) return publish(gpuLost);
    if (!on) return publish(ts.state === 'complete' || ts.state === 'refining' ? { state: 'idle', detail: '' } : { ...ts, action: ts.action && 'retryTerrain' });
    if (failure) return publish(failure);
    if (document.visibilityState === 'hidden') return publish({ state: 'paused', detail: 'tab hidden: the browser stops drawing, so tiles stop loading; they continue when the tab is visible' });
    if (now - lastFrame > 2500) return publish({ state: 'paused', detail: `no frame drawn for ${((now - lastFrame) / 1000).toFixed(0)} s (window minimised, occluded, or the in-app browser pane hidden): tiles refine only while the page draws` });
    if (!photo.root) return publish({ state: 'connecting', detail: rootTimer ? `${rootErr.msg} Retry ${rootTry}/${ROOT_TRIES} in ${Math.max(0, (rootRetryAt - now) / 1000).toFixed(0)} s` : 'Cesium ion session' });
    const s = sv.assess(now);
    if (s.state === 'complete' && ts.state === 'loading') s.state = 'refining', s.detail = 'terrain still loading';
    publish(s);
  }
  // The ion plugin swallows a failed root/session request: the renderer then reports "root loaded" with no tileset and never asks
  // again. Rebuild it (bounded, with backoff) unless the error is permanent (token, allowed URLs, asset): retrying those only spends quota.
  function onRootError(e) {
    const err = classifyError(e.error, e.url);
    if (err.permanent || rootTry >= ROOT_TRIES) { failure = { state: 'failed', detail: err.msg + (err.permanent ? '' : ' Automatic retries used up.'), action: 'retry' }; return assess(); }
    const ms = backoffMs(rootTry++, 2000); rootErr = err; rootRetryAt = performance.now() + ms;
    rootTimer = setTimeout(() => { rootTimer = 0; rebuild(); }, ms);
  }

  function build() {
    photo = new TilesRenderer(); builds++;
    if (TUNING.cacheMB) {      // own cache: the terrain + imagery tiles can no longer starve the photoreal layer (and vice versa)
      const c = new LRUCache(); c.unloadPriorityCallback = photo.lruCache.unloadPriorityCallback;
      c.maxBytesSize = TUNING.cacheMB * 2 ** 20; c.minBytesSize = c.maxBytesSize * 0.75; photo.lruCache = c;
    }
    photo.registerPlugin(new CesiumIonAuthPlugin({ apiToken: token, assetId: GOOGLE_ASSET_ID, autoRefreshToken: true }));
    photo.registerPlugin(new GLTFExtensionsPlugin({ dracoLoader: new DRACOLoader().setDecoderPath(DRACO) }));
    photo.registerPlugin(new ReorientationPlugin({ up: '+y', lat: site.lat, lon: site.lon, height: site.height, azimuth: Math.PI }));
    photo.addEventListener('load-model', ({ scene: s }) => eachMat(s, clipPhoto));
    photo.addEventListener('load-error', (e) => { if (!e.tile) onRootError(e); });
    photo.addEventListener('load-root-tileset', () => { rootTry = 0; if (TUNING.errorTarget) photo.errorTarget = TUNING.errorTarget; });
    photo.downloadQueue.maxJobsPerOrigin = TUNING.jobs;
    sv = supervise(photo);
    root.add(photo.group);
  }
  // Disposes the old renderer completely (tiles, GPU resources, plugins, listeners, its cache entries) before making a new one.
  function teardown() { if (!photo) return; clearTimeout(rootTimer); rootTimer = 0; sv.dispose(); photo.dispose(); photo = null; sv = null; }
  function rebuild() { teardown(); failure = null; build(); assess(); }

  const settled = () => new Promise((r) => { if (['complete', 'degraded', 'failed'].includes(st.state) || !on) r(st.state); else settledWaiters.push(r); });
  // Vertical calibration once the mesh is settled (the old version sampled at the first lull in downloads, i.e. on coarse tiles).
  async function calibrate() {
    const s = await settled();
    if (!on || s === 'failed') return null;
    root.position.y = 0; root.updateMatrixWorld(true);
    calib = groundOffset(root, terrain.group, { skip: (x, z) => inLot(x, z, 8) });
    if (!calib) { calibNote = 'Vertical calibration failed: too few ground samples under the mesh'; assess(); return null; }
    root.position.y = calib.offset;
    if (demolition?.count) { demolition.setEnabled(false); const w = demolition.fitWalls(root); demolition.setEnabled(cut); calib.partyWallTopM = w; }
    calibNote = `Photo mesh moved ${calib.offset >= 0 ? '+' : ''}${calib.offset.toFixed(2)} m to the survey ground (${calib.samples} samples, heuristic)`; assess();
    return calib;
  }
  setInterval(() => assess(), 1000);      // timers keep running when frames stop: this is what detects a hidden tab / stalled page
  document.addEventListener('visibilitychange', () => assess());

  const api = {
    get on() { return on; }, get calibration() { return calib; }, get tiles() { return photo; }, get enabledAt() { return enabledAt; }, get builds() { return builds; }, root, calibrate,
    state: () => st, terrainState: () => terrainSv.assess(), settled,
    async enable() {
      if (!photo) build();
      on = true; enabledAt = performance.now(); root.visible = true; applyClip(); demolition?.setVisibleWithPhoto(true); assess();
      if (!calib) calibrate();
    },
    disable() { on = false; root.visible = false; applyClip(); demolition?.setVisibleWithPhoto(false); status(''); assess(); },
    // after a failure, or tiles refused for good (401/403: e.g. the Google session/key from ion expired): a fresh renderer, i.e. a new
    // ion endpoint request and Google session (the old renderer is disposed, nothing leaks); otherwise re-request the failed tiles now
    retry() { if (failure || !photo?.root || sv.lastError?.permanent) { rootTry = 0; rebuild(); } else sv.retryNow(); assess(); },
    rebuild,
    setCut(v) { cut = v; demolition?.setEnabled(v); applyClip(); },
    setAligned(v) { aligned = v; applyShift(); }, get aligned() { return aligned; }, demolition,
    update() {
      lastFrame = performance.now(); if (lastFrame - lastAssess > 250) { lastAssess = lastFrame; assess(lastFrame); }
      if (!on || !photo) return; photo.setCamera(camera); photo.setResolutionFromRenderer(camera, renderer); photo.update();
    },
    attributions() { const a = []; if (on && photo) photo.getAttributions(a); return a; },
  };
  return api;
}
