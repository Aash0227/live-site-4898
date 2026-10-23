#!/usr/bin/env node
// Demolition masking test, real Chrome, real Google tiles (one Cesium ion session).
//   node scripts/test-demolition.mjs [--url http://127.0.0.1:5195/viewer/] [--browser chrome] [--out reports/demolition.json]
// (i)  neighbours preserved: same pose, demolition off vs on; pixels OUTSIDE the projected footprint prism (+4 px) must not change.
// (ii) inside: the footprint interior (eroded 4 px) shows the cleared-ground fill, not the old roof (top-down pose).
// (iii) stable while streaming: the interior is sampled during refinement after a camera move (no old-roof fragments reappear).
// Exit 1 unless every check holds.
import fs from 'node:fs';
import { launchBrowser, openPage, VIEWER_READY } from './lib/browser.mjs';

const argv = process.argv.slice(2), opt = {};
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) opt[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
const URL0 = opt.url || 'http://127.0.0.1:5195/viewer/', OUT = opt.out || 'reports/demolition.json';
const b = await launchBrowser({ browser: opt.browser || 'chrome', width: 1400, height: 900 });
const out = { url: URL0, started: new Date().toISOString() };
try {
  const { page, log } = await openPage(b, URL0, { readyExpr: VIEWER_READY, readyTimeout: 180000 });
  await page.evaluate(`(${PAGE_JS.toString()})()`);
  out.enable = await page.evaluate(() => __dt.enable());
  out.poses = {};
  for (const pose of ['top', 'oblique', 'street']) out.poses[pose] = await page.evaluate((p) => __dt.compare(p), pose);
  out.streaming = await page.evaluate(() => __dt.streaming());
  out.console = log.console; out.pageErrors = log.pageErrors;
  const P = out.poses;
  out.checks = {
    neighboursPreserved: Object.values(P).every((p) => p.outsideChanged <= Math.max(25, p.outsidePx * 2e-4)),
    interiorCleared: P.top.interiorFill >= 0.9,
    oldRoofRemoved: ['top', 'oblique'].every((k) => P[k].insideChanged / P[k].insidePx > 0.5),      // the street pose does not see the pad (occluded): preservation only
    stableWhileStreaming: out.streaming.minFill >= 0.85,
    noPageErrors: out.pageErrors.length === 0,
  };
  out.pass = Object.values(out.checks).every(Boolean);
} catch (e) { out.error = String(e.stack || e); out.pass = false; } finally { await b.close().catch(() => {}); }
fs.mkdirSync('reports', { recursive: true }); fs.mkdirSync('docs/img', { recursive: true });
for (const [k, v] of Object.entries(out.poses || {})) for (const s of ['shotOff', 'shotOn']) if (v[s]) { fs.writeFileSync(`docs/img/demolition-${k}-${s === 'shotOn' ? 'on' : 'off'}.jpg`, Buffer.from(v[s].split(',')[1], 'base64')); delete v[s]; }
fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
console.log(JSON.stringify({ checks: out.checks, poses: out.poses, streaming: out.streaming, enable: out.enable, error: out.error }, null, 1));
process.exit(out.pass ? 0 : 1);

// ── in-page helpers ──────────────────────────────────────────────────────────────────────────────────
function PAGE_JS() {
  const A = window.__app, T = A.THREE, D = A.demolition, ph = A.photo, c = A.renderer.domElement;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms)), raf = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const stats = () => ph.tiles?.stats || {};
  async function stable(minVisible = 20, quietMs = 3000, maxMs = 120000) {
    const t0 = performance.now(); let q0 = null;
    while (performance.now() - t0 < maxMs) { const s = stats(); const busy = (s.downloading || 0) + (s.parsing || 0) + (s.queued || 0);
      if (s.visible >= minVisible && !busy) { q0 ??= performance.now(); if (performance.now() - q0 > quietMs) return Math.round(performance.now() - t0); } else q0 = null; await sleep(200); }
    return -1;
  }
  const grab = () => { const cv = document.createElement('canvas'); cv.width = c.width; cv.height = c.height; const g = cv.getContext('2d'); g.drawImage(c, 0, 0); return g.getImageData(0, 0, c.width, c.height).data; };
  // the footprint prism (Google frame + current shift), projected; dilate > 0 grows it, < 0 erodes it (the interior)
  function prismMask(dilate, top) {
    const cv = document.createElement('canvas'); cv.width = c.width; cv.height = c.height; const g = cv.getContext('2d');
    const sh = D.uniforms.uDemoShift.value, proj = (x, y, z) => { const v = new T.Vector3(x + sh.x, y, z + sh.y).project(A.camera); return [(v.x + 1) / 2 * c.width, (1 - v.y) / 2 * c.height]; };
    const poly = D.uniforms.uDemoPts.value.slice(0, D.uniforms.uDemoCount.value[0]);
    const ring = (y) => poly.map((p) => proj(p.x, y, p.y));
    g.fillStyle = '#fff'; g.strokeStyle = '#fff'; g.lineJoin = 'round';
    const path = (pts) => { g.beginPath(); pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); g.closePath(); };
    if (dilate >= 0) {
      const lo = ring(-0.5), hi = ring(top);
      for (const r of [lo, hi]) { path(r); g.fill(); if (dilate) { g.lineWidth = 2 * dilate; g.stroke(); } }
      for (let i = 0; i < poly.length; i++) { const j = (i + 1) % poly.length; path([lo[i], lo[j], hi[j], hi[i]]); g.fill(); if (dilate) { g.lineWidth = 2 * dilate; g.stroke(); } }
    } else { path(ring(0.03)); g.fill(); g.globalCompositeOperation = 'destination-out'; g.lineWidth = -2 * dilate; g.stroke(); }
    return g.getImageData(0, 0, c.width, c.height).data;
  }
  const hex = (D.fillColor || '#9c8f7c').replace('#', ''), fillRGB = { r: parseInt(hex.slice(0, 2), 16), g: parseInt(hex.slice(2, 4), 16), b: parseInt(hex.slice(4, 6), 16) };      // sRGB, as on screen
  function compareImgs(off, on, outside, inside) {
    let outsidePx = 0, outsideChanged = 0, insidePx = 0, insideChanged = 0;
    for (let k = 0; k < off.length; k += 4) { const d = Math.abs(off[k] - on[k]) + Math.abs(off[k + 1] - on[k + 1]) + Math.abs(off[k + 2] - on[k + 2]);
      if (outside[k] === 0) { outsidePx++; if (d > 12) outsideChanged++; } else if (inside[k]) { insidePx++; if (d > 12) insideChanged++; } }
    return { outsidePx, outsideChanged, insidePx, insideChanged };
  }
  function interiorFill(img, interior) {     // share of interior pixels that are the (lit) fill colour: hue close to #9c8f7c, any brightness
    let n = 0, f = 0; for (let k = 0; k < img.length; k += 4) { if (!interior[k]) continue; n++;
      const r = img[k], g = img[k + 1], bb = img[k + 2], s = r + g + bb || 1, fr = fillRGB.r, fg = fillRGB.g, fb = fillRGB.b, fs = fr + fg + fb;
      if (Math.abs(r / s - fr / fs) < 0.03 && Math.abs(g / s - fg / fs) < 0.03 && Math.abs(bb / s - fb / fs) < 0.03) f++; }
    return n ? +(f / n).toFixed(3) : null;
  }
  const POSES = { top: [[0, 150, 0.01], [0, 0, 0]], oblique: [[70, 55, 85], [0, 4, 0]], street: [[-55, 12, 60], [0, 4, 0]] };
  window.__dt = {
    async enable() { const t0 = performance.now(); await ph.enable(); for (let i = 0; i < 240 && !ph.calibration; i++) await sleep(500);
      const [p, t] = POSES.oblique; A.camera.position.set(...p); A.controls.target.set(...t); A.controls.update();
      return { ms: Math.round(performance.now() - t0), calibration: ph.calibration, aligned: ph.aligned, stableMs: await stable() }; },
    async compare(name) {
      const [p, t] = POSES[name]; A.camera.position.set(...p); A.controls.target.set(...t); A.controls.update();
      const stableMs = await stable(); const top = Math.max(D.uniforms.uDemoCap.value[0], ...(ph.calibration?.partyWallTopM || [0])) + 0.5;
      const bim = [A.model.object, A.proxy, A.edges?.lines].filter(Boolean); bim.forEach((o) => (o.visible = false));      // the mask is about the photoreal mesh: the new building would cover the pad
      ph.setCut(false); await raf(); await raf(); const off = grab(), shotOff = c.toDataURL('image/jpeg', 0.7); ph.setCut(true); await raf(); await raf(); const on = grab(), shotOn = c.toDataURL('image/jpeg', 0.7);
      bim.forEach((o) => (o.visible = true));
      const outside = prismMask(4, top), inside = prismMask(0, top), interior = prismMask(-4, top);
      return { stableMs, ...compareImgs(off, on, outside, inside), interiorFill: interiorFill(on, interior), shotOff, shotOn };
    },
    async streaming() {          // move the camera so tiles refine, sample the interior while they stream
      A.camera.position.set(0, 60, 0.01); A.controls.target.set(0, 0, 0); A.controls.update(); const fills = [];
      const bim = [A.model.object, A.proxy, A.edges?.lines].filter(Boolean); bim.forEach((o) => (o.visible = false));
      const t0 = performance.now(); while (performance.now() - t0 < 15000) { await raf(); const interior = prismMask(-4, 10); fills.push(interiorFill(grab(), interior)); await sleep(400); }
      bim.forEach((o) => (o.visible = true));
      const v = fills.filter((x) => x != null); return { samples: v.length, minFill: Math.min(...v), maxFill: Math.max(...v) };
    },
  };
}
