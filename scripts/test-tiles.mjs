#!/usr/bin/env node
// Photoreal (Google 3D Tiles via Cesium ion) loading test, per browser, same revision, same camera pose, fresh profile per run.
//   node scripts/test-tiles.mjs [--url http://127.0.0.1:5192/viewer/] [--browser chrome,firefox,edge] [--runs 3] [--headed]
//        [--query "et=20"] [--timeout 180] [--quiet 3] [--size 1500x950]
//        [--inject none|tile503|tile429|endpoint503|endpoint401|endpoint403|endpoint404] [--expect complete|failed]
//        [--rebuild] [--hide] [--out results.json] [--arg --chrome-flag]
// --expect failed: the run passes when the app reaches state "failed" AND asked the ion endpoint once (a permanent error must not loop).
// --rebuild: after "complete": (a) disable + enable must reuse the same TilesRenderer and come back to "complete"; (b) rebuild() (the
//            Retry-after-failure path) must dispose the old renderer and return to the same GPU-object level (no leak).
// --hide: launches WITHOUT the anti-backgrounding flags, puts another tab in front, checks the page stops drawing and says "paused".
// "complete" (objective): for --quiet consecutive seconds nothing is queued/downloading/parsing in any tiles queue, AND no visible
// photoreal tile still wants refinement (visible, has children, screen-space error > errorTarget), AND nothing was refused by a
// full LRU cache, AND no photoreal tile is in the FAILED state (the renderer treats a failed child as finished: it leaves a hole).
// "degraded": quiet for 10 s but one of those is not met. Exit code 1 unless every run passes.
// Each run ENABLES the photoreal layer once = one Cesium ion session (keep runs low).
import fs from 'node:fs';
import { launchBrowser, APP_GL_JS, VIEWER_READY, watchNetwork } from './lib/browser.mjs';

const argv = process.argv.slice(2), opt = { arg: [] };
for (let i = 0; i < argv.length; i++) { const k = argv[i]; if (!k.startsWith('--')) continue; const n = k.slice(2); const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true; if (n === 'arg') opt.arg.push(v); else opt[n] = v; }
const BASE = opt.url || 'http://127.0.0.1:5192/viewer/', RUNS = +(opt.runs || 3), TIMEOUT = 1000 * +(opt.timeout || 180), QUIET = 1000 * +(opt.quiet || 3);
const BROWSERS = String(opt.browser || 'chrome,firefox').split(','), EXPECT = opt.expect || 'complete';
const [W, H] = String(opt.size || '1500x950').split('x').map(Number);
const url = `${BASE}?photo=1${opt.query ? '&' + opt.query : ''}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// In-page probe: raw renderer numbers, independent of the app's own state model (so it also measures the baseline code).
const PROBE = `(() => {
  const a = window.__app, now = performance.now();
  const sum = (r) => { if (!r) return null; const s = r.stats; let visible = 0, unrefined = 0;
    for (const t of r.visibleTiles) { visible++; if (t.children.length && t.traversal.error > r.errorTarget) unrefined++; }
    return { root: !!r.root, queued: s.queued, downloading: s.downloading, parsing: s.parsing, loaded: s.loaded, failed: s.failed, refused: s.refused, visible, unrefined,
      busy: !!(r.downloadQueue.running || r.parseQueue.running || r.processNodeQueue.running), errorTarget: r.errorTarget,
      cacheMB: +(r.lruCache.cachedBytes / 2 ** 20).toFixed(1), cacheMaxMB: Math.round(r.lruCache.maxBytesSize / 2 ** 20), cacheItems: r.lruCache.itemSet.size, cacheFull: r.lruCache.isFull() }; };
  const m = a && a.renderer.info.memory;
  return { t: now, vis: document.visibilityState, photo: sum(a && a.photo.tiles), terrain: sum(a && a.tiles), state: a && a.photo.state ? a.photo.state() : null,
    on: !!(a && a.photo.on), enabledAt: a && a.photo.enabledAt, builds: a && a.photo.builds, rootChildren: a && a.photo.root ? a.photo.root.children.length : null, ctxLost: window.__ttLost || 0,
    frame: a ? a.renderer.info.render.frame : 0, indicator: document.querySelector('#geoState') ? document.querySelector('#geoState').textContent : null,
    heapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 2 ** 20) : null, gpuObj: m ? { geometries: m.geometries, textures: m.textures } : null,
    net: window.__lsvNet ? JSON.parse(JSON.stringify(window.__lsvNet)) : null }; })()`;

// Deterministic fault injection (Chrome/Edge request interception) to prove the retry path: fails the FIRST attempt of every 7th
// distinct Google tile URL (tile503 / tile429), the first ion endpoint request (endpoint503), or every endpoint request (endpoint4xx).
async function inject(page, mode) {
  if (!mode || mode === 'none') return null;
  const seen = new Map(); let n = 0; const hits = { injected: 0, endpointRequests: 0 };
  await page.setRequestInterception(true);
  page.on('request', (r) => {
    if (r.isInterceptResolutionHandled()) return;
    const u = r.url().split('?')[0];
    const tile = /tile\.googleapis\.com\/v1\/3dtiles\/datasets\/.+\.glb$/.test(u), ep = /api\.cesium\.com\/v1\/assets\/\d+\/endpoint/.test(u);
    if (r.method() === 'OPTIONS') return r.continue();
    if (ep) hits.endpointRequests++;
    let fail = false;
    if ((mode === 'tile503' || mode === 'tile429') && tile) { if (!seen.has(u)) { seen.set(u, ++n); fail = n % 7 === 0; } }
    if (mode === 'endpoint503' && ep && !seen.has(u)) { seen.set(u, 1); fail = true; }
    if (/^endpoint4\d\d$/.test(mode) && ep) fail = true;      // permanent: every endpoint request fails
    if (!fail) return r.continue();
    hits.injected++;
    const status = mode === 'tile429' ? 429 : /^endpoint4/.test(mode) ? +mode.slice(8) : 503;
    r.respond({ status, headers: { 'access-control-allow-origin': '*', 'access-control-expose-headers': 'Retry-After', 'retry-after': '1' }, body: 'injected' });
  });
  return hits;
}

// Waits until the objective "complete" (see header) or "degraded"; returns timings relative to the moment the layer was enabled.
async function waitSettled(page, t0Page) {
  let first = null, quietSince = null, idleSince = null, appComplete = null, last = null; const tStart = Date.now(), trace = [];
  while (Date.now() - tStart < TIMEOUT) {
    const p = await page.evaluate(PROBE); last = p; const ph = p.photo, tr = p.terrain;
    const since = (t0Page ?? p.enabledAt) != null ? p.t - (t0Page ?? p.enabledAt) : Date.now() - tStart;
    if (ph && ph.visible > 0 && first == null) first = Math.round(since);
    if (p.state?.state === 'complete' && appComplete == null) appComplete = Math.round(since);
    const idle = ph && ph.root && !ph.busy && !tr.busy && ph.queued + ph.downloading + ph.parsing + tr.queued + tr.downloading + tr.parsing === 0;
    const done = idle && ph.unrefined === 0 && ph.refused === 0 && ph.failed === 0 && ph.visible > 0;
    quietSince = done ? (quietSince ?? since) : null; idleSince = idle ? (idleSince ?? since) : null;
    if (trace.length < 400) trace.push([Math.round(since), ph ? [ph.visible, ph.queued + ph.downloading + ph.parsing, ph.unrefined, ph.failed, ph.refused] : null, p.state?.state]);
    if (EXPECT === 'failed' && p.state?.state === 'failed') return { verdict: 'failed', last, trace, first, appComplete, failedMs: Math.round(since) };
    if (quietSince != null && since - quietSince >= QUIET) return { verdict: 'complete', completeMs: Math.round(quietSince), last, trace, first, appComplete };
    if (idleSince != null && since - idleSince >= 10000) return { verdict: 'degraded', stuckSinceMs: Math.round(idleSince), last, trace, first, appComplete };
    await sleep(500);
  }
  return { verdict: 'timeout', last, trace, first, appComplete };
}

async function oneRun(browser, run) {
  const b = await launchBrowser({ browser, headed: !!opt.headed, args: opt.arg, width: W, height: H, background: !!opt.hide });
  const out = { browser, run, url, size: [W, H], version: await b.version() };
  try {
    const page = await b.newPage();
    await page.evaluateOnNewDocument(`addEventListener('webglcontextlost', () => { window.__ttLost = (window.__ttLost || 0) + 1; }, true);`);
    const net = watchNetwork(page);
    const log = { console: [], pageErrors: [] };
    page.on('console', (m) => { const t = m.type(); if (t === 'error' || t === 'warning') log.console.push(`${t}: ${m.text()}`.slice(0, 300)); });
    page.on('pageerror', (e) => log.pageErrors.push(String(e.message || e).slice(0, 300)));
    const inj = await inject(page, opt.inject);
    const t0 = Date.now();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForFunction(VIEWER_READY, { timeout: 120000, polling: 250 });
    out.viewerReadyMs = Date.now() - t0;
    // the baseline code has no ?photo=1: enable it the same way the Site-tab checkbox does
    if (!(await page.evaluate('window.__app.photo.on'))) await page.evaluate('window.__app.photo.enable(); window.__app.photo.enabledAt = performance.now();');
    out.gl = await page.evaluate(APP_GL_JS);
    out.pose = await page.evaluate('(() => { const c = window.__app.camera; return [c.position.x, c.position.y, c.position.z].map((v) => +v.toFixed(2)); })()');
    if (opt.hide) out.hide = await hideCheck(b, page);
    const s = await waitSettled(page);
    out.verdict = s.verdict; out.completeMs = s.completeMs; out.failedMs = s.failedMs; out.stuckSinceMs = s.stuckSinceMs; out.firstTileMs = s.first; out.appCompleteMs = s.appComplete;
    out.final = s.last; out.trace = s.trace; out.injected = inj; out.appState = s.last?.state || null;
    if (EXPECT === 'failed' && s.verdict === 'failed') {      // a permanent error must not be retried: wait, then count endpoint requests again
      const n0 = inj?.endpointRequests; await sleep(15000); out.endpointRequestsAfter15s = inj?.endpointRequests; out.endpointRequestsAtFailure = n0;
      out.finalState = (await page.evaluate(PROBE)).state;
    }
    if (opt.rebuild && s.verdict === 'complete') out.rebuild = await rebuildCheck(page, s.last);
    if (opt.shot) { const f = `${opt.shot}-${browser}-${run}.png`; await page.screenshot({ path: f }); out.shot = f; }
    out.net = net; out.console = log.console; out.pageErrors = log.pageErrors;
  } catch (e) { out.verdict = 'error'; out.error = String(e.message || e); } finally { await b.close().catch(() => {}); }
  return out;
}

// "enable again" paths. Toggle: same renderer, back to complete. Rebuild: old renderer disposed, GPU objects back to the same level.
async function rebuildCheck(page, before) {
  const r = { before: { gpuObj: before.gpuObj, builds: before.builds, cacheItems: before.photo.cacheItems, rootChildren: before.rootChildren } };
  await page.evaluate('window.__app.photo.disable()'); await sleep(1500);
  const t1 = await page.evaluate('(window.__app.photo.enable(), performance.now())');
  const s1 = await waitSettled(page, t1);
  r.toggle = { verdict: s1.verdict, completeMs: s1.completeMs, builds: s1.last.builds, gpuObj: s1.last.gpuObj };
  const t2 = await page.evaluate('(window.__app.photo.rebuild(), performance.now())');
  const s2 = await waitSettled(page, t2);
  r.rebuilt = { verdict: s2.verdict, completeMs: s2.completeMs, builds: s2.last.builds, gpuObj: s2.last.gpuObj, cacheItems: s2.last.photo?.cacheItems, rootChildren: s2.last.rootChildren };
  const g0 = before.gpuObj, g2 = s2.last.gpuObj, near = (a, b) => Math.abs(a - b) <= Math.max(10, 0.15 * b);
  r.pass = s1.verdict === 'complete' && r.toggle.builds === before.builds && s2.verdict === 'complete' && r.rebuilt.builds === before.builds + 1 && r.rebuilt.rootChildren === 1
    && near(g2.geometries, g0.geometries) && near(g2.textures, g0.textures);
  return r;
}

// Background-tab behaviour: put another tab in front, check what the page reports, bring it back.
async function hideCheck(b, page) {
  await sleep(3000);      // let the layer start streaming
  const before = await page.evaluate(PROBE);
  const other = await b.newPage(); await other.goto('about:blank'); await other.bringToFront(); await sleep(8000);
  const hidden = await page.evaluate(PROBE);
  await page.bringToFront(); await other.close(); await sleep(2000);
  const back = await page.evaluate(PROBE);
  const pick = (p) => ({ vis: p.vis, frame: p.frame, loaded: p.photo?.loaded, state: p.state?.state, indicator: p.indicator });
  return { before: pick(before), hidden: pick(hidden), back: pick(back), framesWhileHidden: hidden.frame - before.frame, framesAfterBack: back.frame - hidden.frame,
    pass: hidden.vis === 'hidden' && hidden.state?.state === 'paused' && back.state?.state !== 'paused' && back.frame > hidden.frame };
}

function passOf(o) {
  if (o.verdict === 'error') return false;
  if (EXPECT === 'failed') return o.verdict === 'failed' && o.endpointRequestsAfter15s === o.endpointRequestsAtFailure && o.finalState?.state === 'failed';
  return o.verdict === 'complete' && (!opt.rebuild || !!o.rebuild?.pass) && (!opt.hide || !!o.hide?.pass);
}

const rows = [], all = [];
for (const br of BROWSERS) for (let r = 1; r <= RUNS; r++) {
  const o = await oneRun(br, r); all.push(o);
  const f = o.final || {}, ph = f.photo || {}, n = o.net || {};
  const errs = (o.console || []).filter((c) => c.startsWith('error'));
  const sum = (k) => Object.entries(n).filter(([h]) => h === 'google' || h === 'ion').reduce((a, [, v]) => a + (v[k] || 0), 0);
  const body = f.net ? (f.net.google?.bytes || 0) + (f.net.ion?.bytes || 0) : null;      // in-page decoded bytes (needs viewer/net.js)
  const bad = Object.entries(n).flatMap(([h, v]) => Object.entries(v.status).filter(([s]) => +s >= 400).map(([s, c]) => `${h}:${s}x${c}`)).concat(Object.entries(n).filter(([, v]) => v.failed).map(([h, v]) => `${h}:fail x${v.failed}`));
  rows.push({ browser: br, run: r, pass: passOf(o), verdict: o.verdict, firstTileMs: o.firstTileMs, completeMs: o.completeMs ?? null, appCompleteMs: o.appCompleteMs ?? null, visible: ph.visible, loaded: ph.loaded, failed: ph.failed, refused: ph.refused, unrefined: ph.unrefined,
    cacheMB: ph.cacheMB, MBwire: sum('wireBytes') ? +(sum('wireBytes') / 2 ** 20).toFixed(1) : null, MBbody: body != null ? +(body / 2 ** 20).toFixed(1) : null,
    retries: f.net ? Object.values(f.net).reduce((a, v) => a + v.retries, 0) : null, heapMB: f.heapMB, renderer: (o.gl?.renderer || '').replace(/ANGLE \(|Direct3D11.*$/g, '').slice(0, 48),
    consoleErrors: errs.length, cors: errs.filter((c) => /CORS|Cross-Origin|Access-Control/i.test(c)).length, httpBad: bad.join(' ') || '-', ctxLost: f.ctxLost, shaderErr: errs.filter((c) => /shader|program/i.test(c)).length,
    dracoErr: (n.draco?.failed || 0) + errs.filter((c) => /draco/i.test(c)).length, state: o.appState?.state ?? '-', error: o.error });
  console.error(JSON.stringify(rows.at(-1)));
  if (o.rebuild) console.error('rebuild', JSON.stringify(o.rebuild));
  if (o.hide) console.error('hide', JSON.stringify(o.hide));
  if (EXPECT === 'failed') console.error('failed-path', JSON.stringify({ endpointRequestsAtFailure: o.endpointRequestsAtFailure, endpointRequestsAfter15s: o.endpointRequestsAfter15s, finalState: o.finalState }));
}
console.table(rows.map(({ error, ...r }) => r));
if (opt.out) fs.writeFileSync(opt.out, JSON.stringify({ when: new Date().toISOString(), url, opt, rows, runs: all }, null, 1));
const ok = rows.every((r) => r.pass);
console.log(ok ? `PASS: ${rows.length}/${rows.length} runs` : `FAIL: ${rows.filter((r) => !r.pass).length}/${rows.length} runs did not pass`);
process.exit(ok ? 0 : 1);
