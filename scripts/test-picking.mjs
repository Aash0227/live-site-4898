#!/usr/bin/env node
// BIM picking acceptance test with REAL input events (page.mouse.click / drag, real clicks on the UI controls).
// Ground truth is independent of the viewer's picking code: an ID-colour render of the meshes actually on screen (scripts/lib/pick-truth.mjs).
// For every sampled element it asserts: the selection (window.__app.state().selected), the properties panel (ElementId, UniqueId,
// family, type, first instance parameters), and that a highlight is actually rendered (pixel change at the clicked point).
// Scenarios: exterior + per-level views (per-category accuracy), hide, isolate, camera movement (drag), category filter, section plane,
// geographic layers on (terrain/imagery/OSM; optional photoreal) where BIM must always win, identity round trip.
//   node scripts/test-picking.mjs [--url http://127.0.0.1:5191/viewer/] [--browser chrome|firefox] [--gpu software|default] [--n 150]
//        [--out reports/picking-<label>.json] [--label baseline] [--photoreal] [--dpr 2] [--quick]
// Exit code 0 only if every acceptance threshold holds (see THRESH).
import fs from 'node:fs';
import zlib from 'node:zlib';
import { launchBrowser, openPage, VIEWER_READY, GL_INFO_JS } from './lib/browser.mjs';
import { PICK_TRUTH_JS } from './lib/pick-truth.mjs';

const argv = process.argv.slice(2), opt = {};
for (let i = 0; i < argv.length; i++) { const k = argv[i]; if (!k.startsWith('--')) continue; const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true; opt[k.slice(2)] = v; }
const URL0 = opt.url || 'http://127.0.0.1:5191/viewer/', BROWSER = opt.browser || 'chrome', N = +(opt.n || (opt.quick ? 40 : 150)), LABEL = opt.label || BROWSER;
const THRESH = { main: 0.95, panel: 0.95, highlight: 0.95, scenario: 0.95 };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const t0 = Date.now(), log = (...a) => console.error(`[${((Date.now() - t0) / 1000).toFixed(0)}s]`, ...a);

// category quotas over the views (Vestibule has no structural framing / columns: they are reported as absent, not faked)
const QUOTA = { Walls: 40, Floors: 24, 'Plumbing Fixtures': 30, Doors: 20, Windows: 14, Runs: 10, Landings: 6, Railings: 6 };
const scale = N / Object.values(QUOTA).reduce((a, b) => a + b, 0);
for (const k in QUOTA) QUOTA[k] = Math.max(1, Math.round(QUOTA[k] * scale));

const b = await launchBrowser({ browser: BROWSER, gpu: opt.gpu || 'default', width: 1500, height: 950 });
const out = { label: LABEL, browser: BROWSER, url: URL0, started: new Date().toISOString() };
let page, plog, main = [], summarise = null;
try {
  out.version = await b.version();
  ({ page, log: plog } = await openPage(b, URL0, { readyExpr: VIEWER_READY, readyTimeout: 180000 }));
  if (opt.dpr) { await page.setViewport({ width: 1500, height: 950, deviceScaleFactor: +opt.dpr }); await sleep(1500); }
  out.gl = await page.evaluate(GL_INFO_JS);
  out.viewport = await page.evaluate(() => ({ w: innerWidth, h: innerHeight, dpr: devicePixelRatio, canvas: (({ left, top, width, height }) => ({ left, top, width, height }))(document.querySelector('#c').getBoundingClientRect()), buffer: [document.querySelector('#c').width, document.querySelector('#c').height] }));
  await page.evaluate(PICK_TRUTH_JS);
  const props = await loadProps();
  out.identity = await page.evaluate(() => __pt.selfCheck());
  log('identity', JSON.stringify(out.identity));
  const els = await page.evaluate(() => __pt.els.map((e) => ({ id: e.id, uid: e.uid, fam: e.fam, type: e.type, cat: e.cat, lvl: e.lvl })));
  const hasPicks = await page.evaluate(() => 'picks' in __app.state());

  // ── helpers ────────────────────────────────────────────────────────────────────────────────────
  const settle = async (minMs = 150) => {
    await sleep(minMs);
    await page.evaluate(() => new Promise((r) => { const t0 = performance.now(); const f = () => (!__app.model.isBusy || performance.now() - t0 > 1500 ? requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(r))) : setTimeout(f, 50)); f(); }));
  };
  const state = () => page.evaluate(() => __app.state());
  const clickUI = async (sel) => { await page.click(sel); await sleep(80); };
  async function tab(name) { await clickUI(`.tabs button[data-tab="${name}"]`); }
  async function setCheck(sel, on) { const cur = await page.$eval(sel, (e) => e.checked); if (cur !== on) await clickUI(sel); }
  async function onlyLevels(lv) {        // real clicks: "none" then each wanted level
    await tab('model'); await clickUI('a[data-none="lvl"]');
    for (const l of lv) await setCheck(`#lvls input[data-lvl="${l}"]`, true);
  }
  async function allLevels() { await tab('model'); await clickUI('a[data-all="lvl"]'); }
  async function view(dir, k = 1.0) {       // test setup: place the camera around the model box (not the code under test)
    await page.evaluate(([d, k]) => { const A = __app, T = A.THREE; const box = A.model.box, c = box.getCenter(new T.Vector3()), r = box.getSize(new T.Vector3()).length() / 2;
      const v = new T.Vector3(...d).normalize(); A.controls.target.copy(c); A.camera.position.copy(c).addScaledVector(v, r * k / Math.sin(A.camera.fov * Math.PI / 360)); A.controls.update(); }, [dir, k]);
    await settle(400);
  }
  // real click; then ONE in-page wait for the app to finish handling it (picks counter if the app has one, else a selection change)
  async function clickAt(cx, cy) {
    await page.evaluate(() => { const s = __app.state(); window.__ck = { sel: s.selected, picks: s.picks }; });
    await page.mouse.click(cx, cy);
    return page.evaluate((hp) => new Promise((res) => { const t0 = performance.now(); const poll = () => { const s = __app.state(), ch = hp ? s.picks !== __ck.picks : s.selected !== __ck.sel;
      if (ch || performance.now() - t0 > 900) setTimeout(() => res(__app.state().selected), ch ? 30 : 0); else setTimeout(poll, 15); }; poll(); }), hasPicks);
  }
  const rgb = (cx, cy) => page.evaluate(([x, y]) => __pt.screenRGB(x, y), [cx, cy]);
  const diff = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
  // the un-highlight reaches the screen one Fragments update after select(-1) resolves: wait for the model to be idle twice
  async function deselect() { await page.evaluate(async () => { await __app.select(-1); for (let k = 0; k < 2; k++) { for (let j = 0; j < 80 && __app.model.isBusy; j++) await new Promise((r) => setTimeout(r, 50)); await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(r)))); } }); }
  function panelOk(text, i) {
    const e = els[i], need = [String(e.id), e.uid, e.type, e.fam || '—'];
    const p = props.elements[i] || {}; const firstParams = Object.entries(p).slice(0, 3).map(([k, v]) => String(v));
    const missing = [...need, ...firstParams].filter((s) => s && !text.includes(s));
    return { ok: missing.length === 0, missing };
  }
  // one sample: deselect, colour before, real click, selection + panel + highlight
  async function sample(cx, cy, expect, tag) {
    const ts = Date.now();
    await deselect();
    const c0 = await rgb(cx, cy);
    const got = await clickAt(cx, cy);
    const rec = { tag, cx: +cx.toFixed(1), cy: +cy.toFixed(1), expect, got, cat: expect >= 0 ? els[expect].cat : '(none)', sel: got === expect };
    if (got !== expect) rec.shifted = await page.evaluate(([x, y]) => { const r = document.querySelector('#c').getBoundingClientRect(); return __pt.codeAt(x - r.left, y - r.top); }, [cx, cy]);   // diagnostic only
    // A coplanar tie (both elements' surfaces on the ray within 5 mm, e.g. room floor on a whole-level slab) is ambiguous in the MODEL: the GPU
    // truth pass z-fights. It counts as a correct pick (reported separately as `tie`), and the panel/highlight checks run on the picked element.
    if (got !== expect && got >= 0 && expect >= 0) {
      rec.tie = await page.evaluate(async ([x, y, e, g]) => { const A = __app; const hs = (await A.model.raycastAll({ camera: A.camera, mouse: new A.THREE.Vector2(x, y), dom: A.renderer.domElement })) || [];
        const d = (i) => { const l = A.idOfEl[i]; const v = hs.filter((h) => h.localId === l && h.rayDistance <= 1e-3).map((h) => h.point.distanceTo(A.camera.position)); return v.length ? Math.min(...v) : null; };
        const a = d(e), b = d(g); return a != null && b != null && Math.abs(a - b) <= 0.005; }, [cx, cy, expect, got]);
      if (rec.tie) rec.sel = true;
    }
    if (expect >= 0 && rec.sel) {
      const shown = got;
      const text = await page.$eval('#props', (e) => e.innerText); const p = panelOk(text, shown); rec.panel = p.ok; if (!p.ok) rec.missing = p.missing;
      const d = await page.evaluate(([x, y, c]) => new Promise((res) => { const t0 = performance.now(); const f = () => { const q = __pt.screenRGB(x, y), d = Math.abs(q[0] - c[0]) + Math.abs(q[1] - c[1]) + Math.abs(q[2] - c[2]); if (d > 24 || performance.now() - t0 > 1500) res(d); else requestAnimationFrame(f); }; requestAnimationFrame(f); }), [cx, cy, c0]);
      rec.hlDelta = Math.round(d); rec.hl = d > 24;
    }
    rec.ms = Date.now() - ts;
    return rec;
  }
  const rate = (a, f) => (a.length ? +(a.filter(f).length / a.length).toFixed(4) : null);
  summarise = function (recs) {
    const byCat = {};
    for (const r of recs) { const c = (byCat[r.cat] ||= { n: 0, sel: 0, panel: 0, hl: 0 }); c.n++; if (r.sel) c.sel++; if (r.panel) c.panel++; if (r.hl) c.hl++; }
    for (const c of Object.values(byCat)) { c.selRate = +(c.sel / c.n).toFixed(3); }
    const sel = recs.filter((r) => r.sel && r.expect >= 0), wrong = recs.filter((r) => !r.sel);
    return { n: recs.length, selRate: rate(recs, (r) => r.sel), panelRate: rate(sel, (r) => r.panel), hlRate: rate(sel, (r) => r.hl), byCat,
      ties: recs.filter((r) => r.tie).length, wrong: wrong.length, wrongGotNothing: wrong.filter((r) => r.got === -1).length, wrongMatchesShiftedPoint: wrong.filter((r) => r.got >= 0 && r.got === r.shifted).length };
  }

  // ── geographic layers off for the BIM accuracy part (they come back in the tiles scenario) ──────
  await tab('site'); await setCheck('#optImagery', false); await setCheck('#optSurround', false); await setCheck('#optLot', false); await tab('model');

  // ── 1. main sample: exterior and per-level views ─────────────────────────────────────────────────
  const VIEWS = [
    { name: 'ext-SE', dir: [0.75, 0.62, 0.85], k: 0.9 }, { name: 'ext-SW', dir: [-0.75, 0.62, 0.85], k: 0.9 },
    { name: 'ext-NE', dir: [0.75, 0.62, -0.85], k: 0.9 }, { name: 'ext-NW', dir: [-0.75, 0.62, -0.85], k: 0.9 },
    { name: 'top', dir: [0, 1, 0.0001], k: 0.85 },
    { name: 'L2', lv: [2, -1], dir: [0.3, 1, 0.5], k: 0.75 }, { name: 'L2b', lv: [2], dir: [-0.45, 1, -0.35], k: 0.7 },
    { name: 'L3', lv: [3, -1], dir: [0.3, 1, 0.5], k: 0.75 }, { name: 'L3b', lv: [3], dir: [-0.45, 1, -0.35], k: 0.7 },
    { name: 'L10', lv: [10, 11], dir: [0.4, 1, -0.4], k: 0.8 }, { name: 'B', lv: [0, 1], dir: [0.5, 0.8, 0.6], k: 0.8 },
    { name: 'stairs', lv: [-1], dir: [0.6, 0.7, 0.5], k: 0.55 }, { name: 'stairs-b', lv: [-1], dir: [-0.6, 0.5, -0.6], k: 0.5 },
  ];
  const tested = new Set(), have = {};
  const cap = (c) => Math.ceil((QUOTA[c] || 0) / 3);
  for (const v of VIEWS) {
    if (Object.keys(QUOTA).every((c) => (have[c] || 0) >= QUOTA[c])) break;
    if (v.lv) await onlyLevels(v.lv); else await allLevels();
    await view(v.dir, v.k); await deselect();
    await page.evaluate(() => __pt.frame());
    const cand = (await page.evaluate(() => __pt.candidates())).filter((c) => !tested.has(c.i) && QUOTA[c.cat]).sort((a, b) => b.n - a.n);
    const perView = {};
    for (const c of cand) {
      if ((have[c.cat] || 0) >= QUOTA[c.cat] || (perView[c.cat] || 0) >= cap(c.cat)) continue;
      perView[c.cat] = (perView[c.cat] || 0) + 1; have[c.cat] = (have[c.cat] || 0) + 1; tested.add(c.i);
      const r = await sample(c.cx, c.cy, c.i, v.name); r.px = c.n; main.push(r);
    }
    log(v.name, JSON.stringify(perView), `ok ${main.filter((r) => r.sel).length}/${main.length}`);
  }
  out.main = summarise(main); out.mainRecords = main;
  log('main', JSON.stringify(out.main));
  await allLevels();

  // ── 2. hide: after hiding the clicked element, the same pixel must give what is behind it ──────────
  const scen = {};
  {
    await view([0.75, 0.62, 0.85], 0.9); await page.evaluate(() => __pt.frame());
    const cand = (await page.evaluate(() => __pt.candidates())).filter((c) => c.cat === 'Walls' || c.cat === 'Floors').slice(0, opt.quick ? 4 : 10);
    const recs = [];
    for (const c of cand) {
      const r1 = await sample(c.cx, c.cy, c.i, 'hide-1');
      await clickUI('#bHide'); await settle(300);
      await page.evaluate(() => __pt.frame()); const behind = await page.evaluate(([x, y]) => __pt.codeAt(x, y), [c.cx, c.cy]);
      const hiddenPx = await page.evaluate((i) => __pt.pixelsOf(i), c.i);
      const got = await clickAt(c.cx, c.cy);
      recs.push({ ...r1, hiddenStillDrawnPx: hiddenPx, behind, gotAfterHide: got, ok: r1.sel && hiddenPx === 0 && got === (behind >= 0 ? behind : -1) });
      await clickUI('#bShow'); await settle(300);
    }
    scen.hide = { n: recs.length, okRate: rate(recs, (r) => r.ok), recs };
  }
  // ── 3. isolate: only the isolated element is drawn and pickable; clicking where others were selects nothing ─
  {
    await view([-0.75, 0.62, 0.85], 0.9); await page.evaluate(() => __pt.frame());
    const all = await page.evaluate(() => __pt.candidates());
    const cand = all.filter((c) => ['Walls', 'Floors', 'Plumbing Fixtures', 'Doors', 'Windows'].includes(c.cat)).slice(0, opt.quick ? 3 : 6);
    const recs = [];
    for (const c of cand) {
      await view([-0.75, 0.62, 0.85], 0.9);
      const r1 = await sample(c.cx, c.cy, c.i, 'iso-1');
      await clickUI('#bIsolate'); await settle(500);
      await page.evaluate(() => __pt.frame());
      const drawn = await page.evaluate(() => __pt.elementsIn());
      const ic = (await page.evaluate(() => __pt.candidates())).find((x) => x.i === c.i);
      const got = ic ? (await sample(ic.cx, ic.cy, c.i, 'iso-2')).got : null;
      // a background pixel: nothing there now
      const bgPt = await page.evaluate(() => { const f = __pt.last; for (let y = 40; y < f.h - 40; y += 23) for (let x = 40; x < f.w - 40; x += 29) if (f.codes[y * f.w + x] === -1) return [f.left + x / f.sx, f.top + (f.h - 1 - y) / f.sy]; return null; });
      const gotBg = bgPt ? await clickAt(bgPt[0], bgPt[1]) : null;
      recs.push({ ...r1, drawnAfterIsolate: drawn, gotIsolated: got, gotBackground: gotBg, ok: r1.sel && drawn.length === 1 && drawn[0] === c.i && got === c.i && gotBg === -1 });
      await clickUI('#bShow'); await settle(300);
    }
    scen.isolate = { n: recs.length, okRate: rate(recs, (r) => r.ok), recs };
  }
  // ── 4. camera movement: a drag must not change the selection; after it the selection is still highlighted and new clicks are right ─
  {
    const recs = [];
    for (let k = 0; k < (opt.quick ? 3 : 6); k++) {
      await view([0.75 - 0.5 * k, 0.62, 0.85 - 0.3 * k], 0.9); await page.evaluate(() => __pt.frame());
      const cand = (await page.evaluate(() => __pt.candidates())).sort((a, b) => b.n - a.n)[k];
      if (!cand) continue;
      const r1 = await sample(cand.cx, cand.cy, cand.i, 'cam-1');
      // real drag with OrbitControls (left button), starting on the selected element
      await page.mouse.move(cand.cx, cand.cy); await page.mouse.down(); for (let s = 1; s <= 10; s++) await page.mouse.move(cand.cx + 12 * s, cand.cy + 3 * s); await page.mouse.up();
      await settle(400);
      const afterDrag = (await state()).selected;
      await page.evaluate(() => __pt.frame());
      const nc = (await page.evaluate(() => __pt.candidates())).find((x) => x.i === cand.i);
      let stillLit = null;
      if (nc) { const lit = await rgb(nc.cx, nc.cy); await deselect(); const unlit = await rgb(nc.cx, nc.cy); stillLit = Math.round(diff(lit, unlit)); }
      const other = (await page.evaluate(() => __pt.candidates())).filter((x) => x.i !== cand.i).sort((a, b) => b.n - a.n)[0];
      const r2 = other ? await sample(other.cx, other.cy, other.i, 'cam-2') : null;
      recs.push({ first: r1, afterDrag, litDelta: stillLit, second: r2, ok: r1.sel && afterDrag === cand.i && stillLit != null && stillLit > 24 && (!r2 || r2.sel) });
    }
    scen.camera = { n: recs.length, okRate: rate(recs, (r) => r.ok), recs };
  }
  // ── 5. filtering: select a wall, switch another category off (selection kept, still lit), then walls off (selection dropped, clicks go through) ─
  {
    const recs = [];
    await view([0.75, 0.62, 0.85], 0.9); await page.evaluate(() => __pt.frame());
    const cand = (await page.evaluate(() => __pt.candidates())).filter((c) => c.cat === 'Walls').slice(0, opt.quick ? 2 : 5);
    for (const c of cand) {
      const r1 = await sample(c.cx, c.cy, c.i, 'flt-1');
      await setCheck('#cats input[data-cat="Floors"]', false); await settle(400);
      const keep = (await state()).selected; await page.evaluate(() => __pt.frame()); const stillFront = await page.evaluate(([x, y]) => __pt.codeAt(x, y), [c.cx, c.cy]);
      await setCheck('#cats input[data-cat="Walls"]', false); await settle(400);
      const afterWallsOff = (await state()).selected;
      await page.evaluate(() => __pt.frame()); const behind = await page.evaluate(([x, y]) => __pt.codeAt(x, y), [c.cx, c.cy]);
      const got = await clickAt(c.cx, c.cy);
      recs.push({ ...r1, keptAfterOtherFilter: keep === c.i, stillFront, afterWallsOff, behind, got, ok: r1.sel && keep === c.i && afterWallsOff === -1 && got === (behind >= 0 ? behind : -1) && (behind < 0 || els[behind].cat !== 'Walls') });
      await clickUI('#bShow'); await settle(300);
    }
    scen.filter = { n: recs.length, okRate: rate(recs, (r) => r.ok), recs };
  }
  // ── 6. section plane: what the clipping leaves visible is what gets picked ────────────────────────────
  {
    await tab('site'); await setCheck('#optSection', true);
    await page.$eval('#secH', (e) => { e.value = '5.5'; e.dispatchEvent(new Event('input', { bubbles: true })); });
    await tab('model'); await view([0.4, 1, 0.55], 0.8); await page.evaluate(() => __pt.frame());
    const cand = (await page.evaluate(() => __pt.candidates())).sort((a, b) => b.n - a.n).filter((c, k) => k % 2 === 0).slice(0, opt.quick ? 8 : 20);
    const recs = []; for (const c of cand) recs.push(await sample(c.cx, c.cy, c.i, 'section'));
    scen.section = { ...summarise(recs), recs };
    await tab('site'); await setCheck('#optSection', false); await tab('model');
  }
  // ── 7. geographic layers on: BIM always wins over terrain / imagery / OSM (and photoreal with --photoreal) ──
  {
    await tab('site'); await setCheck('#optImagery', true); await setCheck('#optSurround', true); await setCheck('#optLot', true);
    if (opt.photoreal) await setCheck('#optPhoto', true);
    await tab('model');
    await view([0.75, 0.35, 0.85], 1.0);
    for (let k = 0; k < 60; k++) { const s = await page.evaluate(() => ({ v: __app.tiles.stats.visible, q: __app.tiles.stats.downloading + __app.tiles.stats.parsing })); if (s.v > 20 && s.q === 0) break; await sleep(500); }
    await sleep(opt.photoreal ? 8000 : 1500); await settle(300);
    const geoF = await page.evaluate(async () => { const f = await __pt.frame({ withGeo: true }); return { geo: f.codes.filter((c) => c === -4).length }; });
    const frontBim = (await page.evaluate(() => __pt.candidates())).sort((a, b) => b.n - a.n).slice(0, opt.quick ? 6 : 15);
    // points where geography is drawn in front of the model: the policy says the BIM element behind still wins
    const geoFront = await page.evaluate(async () => {
      const g = __pt.last; const bim = await __pt.frame(); const pts = [];
      for (let y = 10; y < g.h - 10 && pts.length < 400; y += 7) for (let x = 10; x < g.w - 10; x += 7) { const p = y * g.w + x; if (g.codes[p] === -4 && bim.codes[p] >= 0) { let ok = true; for (let d = -2; d <= 2 && ok; d++) ok = g.codes[p + d] === -4 && bim.codes[p + d] === bim.codes[p] && bim.codes[p + d * g.w] === bim.codes[p]; if (ok) pts.push({ i: bim.codes[p], cx: g.left + (x + 0.5) / g.sx, cy: g.top + (g.h - 1 - y + 0.5) / g.sy }); } }
      return pts;
    });
    const pick = (a, n) => a.filter((_, k) => k % Math.max(1, Math.floor(a.length / n)) === 0).slice(0, n);
    const recs = [];
    for (const c of frontBim) recs.push(await sample(c.cx, c.cy, c.i, 'geo-bim-front'));
    for (const c of pick(geoFront, opt.quick ? 4 : 10)) recs.push(await sample(c.cx, c.cy, c.i, 'geo-in-front'));
    scen.tiles = { geoPixels: geoF.geo, geoFrontCandidates: geoFront.length, photoreal: !!opt.photoreal, ...summarise(recs), recs };
    if (opt.photoreal) out.photoNote = await page.$eval('#photoNote', (e) => e.innerText);
  }
  out.scenarios = scen;
  out.console = plog.console.filter((l) => !l.includes('favicon')); out.pageErrors = plog.pageErrors; out.failed = plog.failed;
} catch (e) { out.error = String(e.stack || e); if (!out.main && summarise && main.length) { out.main = summarise(main); out.mainRecords = main; out.mainPartial = true; } } finally { if (plog && !out.console) { out.console = plog.console; out.pageErrors = plog.pageErrors; } await b.close().catch(() => {}); }

// ── verdict ─────────────────────────────────────────────────────────────────────────────────────────
const s = out.scenarios || {};
const checks = {
  identity: !!out.identity && out.identity.guidRoundTripBad === 0 && out.identity.localIdCollisions === 0 && out.identity.proxyBad === 0 && out.identity.ifcTagNotElementId === 0,
  mainSelection: (out.main?.selRate ?? 0) >= THRESH.main, mainPanel: (out.main?.panelRate ?? 0) >= THRESH.panel, mainHighlight: (out.main?.hlRate ?? 0) >= THRESH.highlight,
  hide: (s.hide?.okRate ?? 0) >= THRESH.scenario, isolate: (s.isolate?.okRate ?? 0) >= THRESH.scenario, camera: (s.camera?.okRate ?? 0) >= THRESH.scenario,
  filter: (s.filter?.okRate ?? 0) >= THRESH.scenario, section: (s.section?.selRate ?? 0) >= THRESH.scenario, tiles: (s.tiles?.selRate ?? 0) >= THRESH.scenario,
  noPageErrors: !out.error && !(out.pageErrors || []).length,
};
out.checks = checks; out.pass = Object.values(checks).every(Boolean); out.seconds = Math.round((Date.now() - t0) / 1000);
const file = opt.out || `reports/picking-${LABEL}.json`;
fs.mkdirSync(file.replace(/[\\/][^\\/]*$/, '') || '.', { recursive: true }); fs.writeFileSync(file, JSON.stringify(out, null, 1));
const brief = { label: LABEL, browser: BROWSER, gl: out.gl?.renderer, viewport: out.viewport, identity: out.identity, main: out.main && { ...out.main }, error: out.error,
  scenarios: Object.fromEntries(Object.entries(s).map(([k, v]) => [k, { n: v.n, okRate: v.okRate, selRate: v.selRate, panelRate: v.panelRate, hlRate: v.hlRate }])), console: out.console, checks, pass: out.pass, seconds: out.seconds, report: file };
console.log(JSON.stringify(brief, null, 1));
process.exit(out.pass ? 0 : 1);

async function loadProps() {
  const u = new URL(URL0); const rev = new URL(page.url()).searchParams.get('rev') || (await (await fetch(new URL('/revisions/index.json', u))).json()).revisions[0].id;
  const r = await fetch(new URL(`/revisions/${rev}/props.json.gz`, u)); return JSON.parse(zlib.gunzipSync(Buffer.from(await r.arrayBuffer())).toString('utf8'));
}
