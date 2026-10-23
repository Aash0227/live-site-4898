#!/usr/bin/env node
// Render modes and visual-quality options: palette distinctness (static), UI + localStorage persistence, category colour coding measured
// on screen (ID pass -> displayed colour per category), hover highlight, frame time per option, screenshots for docs/img.
//   node scripts/test-rendering.mjs [--url http://127.0.0.1:5191/viewer/] [--browser chrome|firefox] [--gpu default|software]
//        [--shots docs/img] [--before] [--w 1600 --h 950 --dpr 1] [--out reports/rendering-<browser>.json]
// --before: only the screenshots of the standard views (for the "before" images on the old code); no mode UI is touched.
import fs from 'node:fs';
import { launchBrowser, openPage, VIEWER_READY, GL_INFO_JS } from './lib/browser.mjs';
import { PICK_TRUTH_JS } from './lib/pick-truth.mjs';
import { ENGINEERING, SELECT, HOVER } from '../viewer/materials.js';

const argv = process.argv.slice(2), opt = {};
for (let i = 0; i < argv.length; i++) { const k = argv[i]; if (!k.startsWith('--')) continue; const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true; opt[k.slice(2)] = v; }
const URL0 = opt.url || 'http://127.0.0.1:5191/viewer/', BROWSER = opt.browser || 'chrome', SHOTS = opt.shots || 'docs/img';
const W = +(opt.w || 1600), H = +(opt.h || 950), DPR = +(opt.dpr || 1);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now(), log = (...a) => console.error(`[${((Date.now() - t0) / 1000).toFixed(0)}s]`, ...a);

// ── static: palette distinctness (CIE76 on sRGB -> Lab D65) ────────────────────────────────────────────────
const lab = (hex) => { const n = parseInt(hex.slice(1), 16); const [r, g, b] = [n >> 16, (n >> 8) & 255, n & 255].map((v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
  const X = (r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047, Y = r * 0.2126 + g * 0.7152 + b * 0.0722, Z = (r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883;
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116); return [116 * f(Y) - 16, 500 * (f(X) - f(Y)), 200 * (f(Y) - f(Z))]; };
const dE = (a, b) => { const p = lab(a), q = lab(b); return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]); };
const cats = Object.entries(ENGINEERING).map(([k, v]) => [k, v.color]);
const pal = { minCategoryPair: Infinity, selectVsCategories: Infinity, hoverVsCategories: Infinity, selectVsHover: +dE(SELECT, HOVER).toFixed(1) };
for (const [a, ca] of cats) { pal.selectVsCategories = Math.min(pal.selectVsCategories, dE(SELECT, ca)); pal.hoverVsCategories = Math.min(pal.hoverVsCategories, dE(HOVER, ca)); for (const [b, cb] of cats) if (a < b) pal.minCategoryPair = Math.min(pal.minCategoryPair, dE(ca, cb)); }
for (const k in pal) pal[k] = +(+pal[k]).toFixed(1);
const out = { browser: BROWSER, url: URL0, palette: pal };

const b = await launchBrowser({ browser: BROWSER, gpu: opt.gpu || 'default', width: W, height: H });
let page, plog;
try {
  out.version = await b.version();
  ({ page, log: plog } = await openPage(b, URL0, { readyExpr: VIEWER_READY, readyTimeout: 180000 }));
  if (DPR !== 1) { await page.setViewport({ width: W, height: H, deviceScaleFactor: DPR }); await sleep(1000); }
  out.gl = await page.evaluate(GL_INFO_JS);
  fs.mkdirSync(SHOTS, { recursive: true });
  const settle = async (ms = 400) => { await sleep(ms); for (let k = 0; k < 30; k++) { if (!(await page.evaluate(() => __app.model.isBusy))) break; await sleep(100); } await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))); };
  const view = async (dir, k) => { await page.evaluate(([d, k]) => { const A = __app, T = A.THREE; const box = A.model.box, c = box.getCenter(new T.Vector3()), r = box.getSize(new T.Vector3()).length() / 2;
    A.controls.target.copy(c); A.camera.position.copy(c).addScaledVector(new T.Vector3(...d).normalize(), r * k / Math.sin(A.camera.fov * Math.PI / 360)); A.controls.update(); }, [dir, k]); await settle(600); };
  const shot = async (name) => { const f = `${SHOTS}/${name}.png`; const r = await page.evaluate(() => { const e = document.querySelector('#c').getBoundingClientRect(); return { x: e.left, y: e.top, width: e.width, height: e.height }; }); await page.screenshot({ path: f, clip: r }); return f; };
  const VIEWS = { site: [[0.75, 0.42, 0.85], 1.15], close: [[0.6, 0.35, 0.9], 0.55], top: [[0.25, 1, 0.35], 0.75] };
  // terrain settles before the shots
  for (let k = 0; k < 60; k++) { const s = await page.evaluate(() => ({ v: __app.tiles.stats.visible, q: __app.tiles.stats.downloading + __app.tiles.stats.parsing })); if (s.v > 20 && s.q === 0) break; await sleep(500); }
  if (opt.before) {
    out.shots = []; for (const [n, [d, k]] of Object.entries(VIEWS)) { await view(d, k); out.shots.push(await shot(`before-${n}`)); }
    if (true) throw Object.assign(new Error('before-only'), { done: true });
  }
  const setMode = async (m) => { await page.select('#modeSel', m); await settle(900); };
  const setOpt = async (sel, on) => { await page.click('.tabs button[data-tab="model"]'); if ((await page.$eval(sel, (e) => e.checked)) !== on) await page.click(sel); await settle(700); };

  // ── persistence: engineering + options survive a reload (localStorage) ──────────────────────────────
  await setMode('engineering'); await setOpt('#optShadows', false);
  await page.reload({ waitUntil: 'domcontentloaded' }); await page.waitForFunction(VIEWER_READY, { timeout: 180000 }); await settle(1500);
  out.persist = await page.evaluate(() => ({ mode: document.querySelector('#modeSel').value, styler: __app.styler.mode, shadows: document.querySelector('#optShadows').checked, legend: getComputedStyle(document.querySelector('#legend')).display !== 'none', legendItems: document.querySelectorAll('#legend .lg').length }));
  log('persist', JSON.stringify(out.persist));

  // ── engineering colour coding measured on screen: per category, median displayed chromaticity -> nearest palette colour ─
  await page.evaluate(PICK_TRUTH_JS);
  await page.click('.tabs button[data-tab="site"]'); for (const s of ['#optImagery', '#optSurround']) if (await page.$eval(s, (e) => e.checked)) await page.click(s);
  const coding = {};
  for (const [name, [d, k]] of [['site', VIEWS.site], ['top', VIEWS.top]]) {
    await view(d, k); await settle(800);
    const r = await page.evaluate(async (pal) => {
      const f = await __pt.frame(); const gl = __app.renderer.getContext(), w = f.w, h = f.h, px = new Uint8Array(w * h * 4);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
      const per = {}; for (let p = 0; p < w * h; p += 3) { const c = f.codes[p]; if (c < 0) continue; const cat = __pt.els[c].cat; (per[cat] ||= []).push([px[p * 4], px[p * 4 + 1], px[p * 4 + 2]]); }
      const hexRgb = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
      const chroma = (c) => { const s = c[0] + c[1] + c[2] + 1e-6; return [c[0] / s, c[1] / s, c[2] / s]; };
      const res = {};
      for (const [cat, list] of Object.entries(per)) {
        if (list.length < 200) continue;
        const med = [0, 1, 2].map((i) => list.map((x) => x[i]).sort((a, b) => a - b)[list.length >> 1]); const cm = chroma(med);
        let best = null; for (const [g, hex] of pal) { const cp = chroma(hexRgb(hex)); const d = Math.hypot(cm[0] - cp[0], cm[1] - cp[1], cm[2] - cp[2]); if (!best || d < best.d) best = { g, d }; }
        res[cat] = { px: list.length, median: med, nearest: best.g, dist: +best.d.toFixed(4) };
      }
      return res;
    }, Object.entries(ENGINEERING).map(([g, v]) => [g, v.color]));
    for (const [cat, v] of Object.entries(r)) if (!coding[cat] || coding[cat].px < v.px) coding[cat] = v;
  }
  const EXPECT = { Walls: 'walls', Floors: 'floors', Doors: 'doors', Windows: 'windows', 'Plumbing Fixtures': 'mep', Runs: 'stairs', Landings: 'stairs', Railings: 'stairs' };
  out.coding = coding; out.codingOk = Object.entries(coding).filter(([c]) => EXPECT[c]).every(([c, v]) => v.nearest === EXPECT[c]);
  log('coding', JSON.stringify(Object.fromEntries(Object.entries(coding).map(([c, v]) => [c, v.nearest]))));

  // ── hover: pointer over an element tints it in HOVER; off it, the colour returns ─────────────────────────
  {
    await view(VIEWS.close[0], VIEWS.close[1]); await page.evaluate(() => __pt.frame());
    const c = (await page.evaluate(() => __pt.candidates())).filter((x) => x.cat === 'Walls').sort((a, b) => b.n - a.n)[0];
    const rgb = () => page.evaluate(([x, y]) => __pt.screenRGB(x, y), [c.cx, c.cy]);
    await page.mouse.move(c.cx - 400, 20); await settle(300); const before = await rgb();
    const tm = Date.now(); await page.mouse.move(c.cx, c.cy); let during = before, ms = null;
    for (let k = 0; k < 40; k++) { await sleep(50); during = await rgb(); if (Math.abs(during[1] - before[1]) + Math.abs(during[0] - before[0]) > 40) { ms = Date.now() - tm; break; } }
    const hov = await page.evaluate(() => __app.state().hovered);
    await page.mouse.move(c.cx - 400, 20); await settle(500); const after = await rgb();
    const d = (a, b) => Math.round(Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]));
    out.hover = { element: c.i, hoveredState: hov, latencyMs: ms, deltaOn: d(during, before), deltaAfter: d(after, before), before, during: during.map(Math.round), ok: hov === c.i && d(during, before) > 40 && d(after, before) < 12 };
    log('hover', JSON.stringify(out.hover));
  }

  // ── frame time per option (camera orbiting so every frame does real work) ────────────────────────────────
  await page.click('.tabs button[data-tab="site"]'); for (const s of ['#optImagery', '#optSurround']) if (!(await page.$eval(s, (e) => e.checked))) await page.click(s);
  await settle(1500);
  const measure = async (ms = 5000) => page.evaluate((ms) => new Promise((res) => { const A = __app, T = A.THREE, c = A.controls.target.clone(), p0 = A.camera.position.clone().sub(c); const dts = []; let last = performance.now(), t1 = last;
    const tick = (t) => { dts.push(t - last); last = t; const a = (t - t1) / ms * Math.PI * 0.5; A.camera.position.copy(c).add(p0.clone().applyAxisAngle(new T.Vector3(0, 1, 0), a)); A.controls.update();
      if (t - t1 < ms) requestAnimationFrame(tick); else { dts.shift(); dts.sort((x, y) => x - y); const mean = dts.reduce((x, y) => x + y, 0) / dts.length; res({ frames: dts.length, meanMs: +mean.toFixed(2), p95Ms: +dts[Math.floor(dts.length * 0.95)].toFixed(2), fps: +(1000 / mean).toFixed(1), calls: A.renderer.info.render.calls, tris: A.renderer.info.render.triangles }); } };
    requestAnimationFrame(tick); }), ms);
  await view(VIEWS.site[0], VIEWS.site[1]);
  const CONFIGS = [
    ['engineering', { mode: 'engineering', shadows: false, ao: false, edges: false }],
    ['realistic-plain', { mode: 'realistic', shadows: false, ao: false, edges: false }],
    ['realistic+edges', { mode: 'realistic', shadows: false, ao: false, edges: true }],
    ['realistic+edges+shadows', { mode: 'realistic', shadows: true, ao: false, edges: true }],
    ['realistic+edges+shadows+ao', { mode: 'realistic', shadows: true, ao: true, edges: true }],
  ];
  out.frame = {};
  for (const [name, c] of CONFIGS) {
    await setMode(c.mode); await setOpt('#optEdges', c.edges); await setOpt('#optShadows', c.shadows); await setOpt('#optAO', c.ao); await settle(800);
    out.frame[name] = await measure(); log('frame', name, JSON.stringify(out.frame[name]));
  }
  // defaults = what a fresh visitor gets (localStorage cleared)
  await page.evaluate(() => { try { localStorage.removeItem('lsv.render'); } catch {} });
  await page.reload({ waitUntil: 'domcontentloaded' }); await page.waitForFunction(VIEWER_READY, { timeout: 180000 }); await settle(2500);
  out.defaults = await page.evaluate(() => ({ ...__app.lighting.state, edges: document.querySelector('#optEdges').checked }));
  await view(VIEWS.site[0], VIEWS.site[1]); out.frame.defaults = await measure(); log('frame defaults', JSON.stringify(out.defaults), JSON.stringify(out.frame.defaults));

  // ── screenshots (after) ──────────────────────────────────────────────────────────────────────────────
  out.shots = [];
  for (const [m, extra] of [['realistic', { shadows: true, ao: false }], ['realistic-ao', { shadows: true, ao: true }], ['engineering', { shadows: false, ao: false }]]) {
    await setMode(m.startsWith('realistic') ? 'realistic' : 'engineering'); await setOpt('#optEdges', true); await setOpt('#optShadows', extra.shadows); await setOpt('#optAO', extra.ao);
    for (const [n, [d, k]] of Object.entries(VIEWS)) { if (m === 'realistic-ao' && n !== 'close') continue; await view(d, k); await settle(1200); out.shots.push(await shot(`after-${m}-${n}`)); }
  }
} catch (e) { if (!e.done) out.error = String(e.stack || e); } finally {
  if (plog) { out.console = plog.console.filter((l) => !l.includes('favicon')); out.pageErrors = plog.pageErrors; }
  await b.close().catch(() => {});
}
const f = out.frame || {};
out.checks = opt.before ? { shots: (out.shots || []).length === 3 } : {
  palette: pal.minCategoryPair >= 25 && pal.selectVsCategories >= 50 && pal.hoverVsCategories >= 50 && pal.selectVsHover >= 50,
  persist: out.persist?.mode === 'engineering' && out.persist?.styler === 'engineering' && out.persist?.shadows === false && out.persist?.legend === true,
  coding: !!out.codingOk, hover: !!out.hover?.ok, defaults30fps: (f.defaults?.fps ?? 0) >= 30,
  noErrors: !out.error && !(out.pageErrors || []).length && !(out.console || []).some((l) => l.startsWith('error')),
};
out.pass = Object.values(out.checks).every(Boolean); out.seconds = Math.round((Date.now() - t0) / 1000);
const file = opt.out || `reports/rendering-${BROWSER}${opt.before ? '-before' : ''}.json`; fs.mkdirSync('reports', { recursive: true }); fs.writeFileSync(file, JSON.stringify(out, null, 1));
console.log(JSON.stringify(out, null, 1));
process.exit(out.pass ? 0 : 1);
