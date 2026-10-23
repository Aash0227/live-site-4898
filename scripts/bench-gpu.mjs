#!/usr/bin/env node
// Which GPU does the browser give WebGL, and is the dedicated GPU actually faster for this viewer? See docs/GPU.md.
//   node scripts/bench-gpu.mjs --probe                      evidence only: WebGL renderer per browser x launch option, chrome://gpu adapters
//   node scripts/bench-gpu.mjs [--url http://127.0.0.1:5192/viewer/] [--browser chrome] [--gpu igpu,rtx] [--runs 3] [--seconds 30]
//        [--scenarios frags,terrain,photo] [--poses iso,street] [--vsync] [--headless] [--scale 1] [--query "aa=0&dpr=1"] [--out f.json]
// gpu configs (per launch, no system setting is touched): igpu = browser default (the AMD iGPU on this laptop),
//   rtx = Chrome/Edge --force_high_performance_gpu (measured to move the GPU process to the NVIDIA adapter; Firefox has no equivalent).
// Default: vsync and the frame-rate limit OFF (--disable-gpu-vsync --disable-frame-rate-limit) so frame time measures render cost,
// not the 60 Hz display; --vsync measures what a user sees. Each window samples rAF frame times, GPU time per frame (WebGL timer
// query, when the browser exposes it), renderer.info, JS heap, nvidia-smi (NVIDIA util / memory) and the Windows "GPU Engine" /
// "GPU Adapter Memory" counters (3D utilisation and dedicated/shared memory of EVERY adapter, read-only).
// The photo scenario enables Google photoreal = one Cesium ion session per run.
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { launchBrowser, APP_GL_JS, VIEWER_READY } from './lib/browser.mjs';

const argv = process.argv.slice(2), opt = { arg: [] };
for (let i = 0; i < argv.length; i++) { const k = argv[i]; if (!k.startsWith('--')) continue; const n = k.slice(2); const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true; if (n === 'arg') opt.arg.push(v); else opt[n] = v; }
const BASE = opt.url || 'http://127.0.0.1:5192/viewer/', RUNS = +(opt.runs || 3), SECONDS = +(opt.seconds || 30);
const list = (v, d) => String(v || d).split(',').filter(Boolean);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const GPU = { igpu: { chrome: [], edge: [], firefox: [] }, rtx: { chrome: ['--force_high_performance_gpu'], edge: ['--force_high_performance_gpu'], firefox: null } };
const WANT = { igpu: /AMD|Radeon/i, rtx: /NVIDIA/i };
const NO_VSYNC = { chrome: ['--disable-gpu-vsync', '--disable-frame-rate-limit'], firefox: { 'layout.frame_rate': 0 } };
const FX_PREFS = { 'webgl.sanitize-unmasked-renderer': false };      // automation profile only: report the real GPU name

// ── samplers (read-only) ────────────────────────────────────────────────────────────────────────
function sampler(cmd, args, parse) {
  const out = []; let buf = '';
  const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  p.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); const v = line && parse(line); if (v) out.push({ t: Date.now(), ...v }); } });
  p.on('error', () => {});
  return { out, stop: () => { try { p.kill(); } catch {} } };
}
const nvsmi = () => sampler('nvidia-smi', ['--query-gpu=utilization.gpu,memory.used', '--format=csv,noheader,nounits', '-lms', '500'],
  (l) => { const [u, m] = l.split(',').map(Number); return Number.isFinite(u) ? { util: u, memMB: m } : null; });
const PS = `while ($true) { $s = Get-Counter -Counter '\\GPU Engine(*engtype_3D)\\Utilization Percentage','\\GPU Adapter Memory(*)\\Dedicated Usage','\\GPU Adapter Memory(*)\\Shared Usage' -ErrorAction SilentlyContinue; $o = @{};
 foreach ($c in $s.CounterSamples) { if ($c.Path -match 'luid_0x[0-9a-f]+_0x([0-9a-f]+)') { $k = $matches[1] + $(if ($c.Path -like '*engtype_3d*') { '.u3d' } elseif ($c.Path -like '*dedicated*') { '.ded' } else { '.sh' }); $o[$k] = [double]$o[$k] + $c.CookedValue } }
 [Console]::Out.WriteLine(($o | ConvertTo-Json -Compress)); [Console]::Out.Flush() }`;
const winCounters = () => sampler('powershell', ['-NoProfile', '-Command', PS], (l) => { try { return { c: JSON.parse(l) }; } catch { return null; } });

// adapters by LUID (chrome://gpu lists every adapter with its LUID; the Windows counters name adapters by LUID)
async function adapters() {
  const b = await launchBrowser({ browser: 'chrome' });
  try { const p = await b.newPage(); await p.goto('chrome://gpu'); await sleep(2500);
    const t = await p.evaluate(`(() => { const h = document.querySelector('info-view'); return h && h.shadowRoot ? h.shadowRoot.textContent : document.body.innerText; })()`);
    return [...t.matchAll(/GPU(\d)\s*:VENDOR= (0x[0-9a-f]+), DEVICE=(0x[0-9a-f]+) \[([^\]]+)\][^{]*LUID=\{(\d+),(\d+)\}([^G]*?\*ACTIVE\*)?/gi)]
      .map((m) => ({ gpu: +m[1], vendor: m[2], name: m[4], luid: `${m[5]},${m[6]}`, luidHex: (+m[6]).toString(16), active: !!m[7] }));
  } finally { await b.close(); }
}

// ── --probe: what each launch option gives WebGL ───────────────────────────────────────────────
const CANVAS_GL = `(() => { const o = {}; for (const pp of ['default', 'high-performance', 'low-power']) { const c = document.createElement('canvas'); const g = c.getContext('webgl2', { powerPreference: pp });
  const e = g && g.getExtension('WEBGL_debug_renderer_info'); o[pp] = g ? (e ? g.getParameter(e.UNMASKED_RENDERER_WEBGL) : g.getParameter(g.RENDERER)) : null; } return o; })()`;
async function probe() {
  const ad = await adapters(); const nv = ad.find((a) => /NVIDIA/i.test(a.name));
  const cfgs = [['chrome', []], ['chrome', ['--force_high_performance_gpu']], ...(nv ? [['chrome', [`--use-adapter-luid=${nv.luid}`]]] : []), ['edge', []], ['edge', ['--force_high_performance_gpu']],
    ['firefox', [], {}], ['firefox', [], { 'webgl.power-preference-override': 2 }], ['firefox', [], { 'webgl.disable-angle': true }]];
  const rows = [];
  for (const [browser, args, prefs] of cfgs) {
    const b = await launchBrowser({ browser, args, firefoxPrefs: browser === 'firefox' ? { ...FX_PREFS, ...prefs } : undefined });
    try { const p = await b.newPage(); await p.goto(BASE + 'index.html', { waitUntil: 'domcontentloaded' }).catch(() => {}); const gl = await p.evaluate(CANVAS_GL);
      rows.push({ browser, option: args.join(' ') || Object.entries(prefs || {}).map(([k, v]) => `${k}=${v}`).join(' ') || '(default)', ...Object.fromEntries(Object.entries(gl).map(([k, v]) => [k, String(v).replace(/ANGLE \(|\(0x[0-9A-F]+\)|Direct3D11.*$|, D3D11.*$/gi, '').trim()])) });
    } finally { await b.close(); }
  }
  console.log('adapters (chrome://gpu):'); console.table(ad); console.table(rows);
  if (opt.out) fs.writeFileSync(opt.out, JSON.stringify({ when: new Date().toISOString(), adapters: ad, rows }, null, 1));
  return rows;
}

// ── benchmark ────────────────────────────────────────────────────────────────────────────────────
const FRAME_JS = `(() => { const a = window.__app, r = a.renderer, gl = r.getContext(), B = window.__bench = { t: [], gpu: [], info: [], pend: [], run: true };
  const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2'); B.timer = !!ext;
  if (!r.__benchOrig) { r.__benchOrig = r.render.bind(r); r.render = (s, c) => { const W = window.__bench, main = r.getRenderTarget() === null, q = main && W && W.run && ext ? gl.createQuery() : null;
    if (q) gl.beginQuery(ext.TIME_ELAPSED_EXT, q); r.__benchOrig(s, c); if (q) { gl.endQuery(ext.TIME_ELAPSED_EXT); W.pend.push(q); }
    if (main && W && W.run) { W.info.push([r.info.render.calls, r.info.render.triangles]);
      while (W.pend.length && gl.getQueryParameter(W.pend[0], gl.QUERY_RESULT_AVAILABLE)) { const p = W.pend.shift(); if (!gl.getParameter(ext.GPU_DISJOINT_EXT)) W.gpu.push(gl.getQueryParameter(p, gl.QUERY_RESULT) / 1e6); gl.deleteQuery(p); } } }; }
  const tick = (ts) => { if (!B.run) return; B.t.push(ts); requestAnimationFrame(tick); }; requestAnimationFrame(tick); return B.timer; })()`;
const STOP_JS = `(() => { const B = window.__bench; B.run = false; const a = window.__app, m = a.renderer.info.memory, ph = a.photo.tiles, tr = a.tiles;
  return { t: B.t, gpu: B.gpu, info: B.info, timer: B.timer, mem: { geometries: m.geometries, textures: m.textures, programs: a.renderer.info.programs ? a.renderer.info.programs.length : null },
    heapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 2 ** 20) : null, dpr: a.renderer.getPixelRatio(), size: [a.renderer.domElement.width, a.renderer.domElement.height],
    photo: ph && a.photo.on ? { visible: ph.visibleTiles.size, loaded: ph.stats.loaded, cacheMB: Math.round(ph.lruCache.cachedBytes / 2 ** 20), errorTarget: ph.errorTarget } : null,
    terrain: { visible: tr.visibleTiles.size, loaded: tr.stats.loaded, shown: tr.group.visible }, state: a.photo.state().state }; })()`;
// settled: every tiles layer that is drawn has nothing queued/downloading/parsing and no visible tile left to refine, for 2 s
const SETTLED_JS = `(() => { const a = window.__app; const busy = (r) => { if (!r) return false; const s = r.stats; let u = 0; for (const t of r.visibleTiles) if (t.children.length && t.traversal.error > r.errorTarget) u++;
  return s.queued + s.downloading + s.parsing > 0 || u > 0 || r.downloadQueue.running || r.parseQueue.running; };
  return !busy(a.tiles) && !(a.photo.on && (busy(a.photo.tiles) || !a.photo.tiles.root)); })()`;
const POSES = {
  iso: `document.querySelector('#bIso').click()`,
  top: `document.querySelector('#bTop').click()`,
  street: `(() => { const a = window.__app; a.camera.position.set(70, 6, 85); a.controls.target.set(0, 9, 0); a.controls.update(); })()`,
};
const SCEN = {
  frags: `(() => { const a = window.__app; a.tiles.group.visible = false; for (const id of ['optSurround', 'optLot']) { const e = document.getElementById(id); if (e.checked) { e.checked = false; e.dispatchEvent(new Event('change')); } } })()`,
  terrain: `(() => { const a = window.__app; a.tiles.group.visible = true; for (const id of ['optSurround', 'optLot']) { const e = document.getElementById(id); if (!e.checked) { e.checked = true; e.dispatchEvent(new Event('change')); } } })()`,
  photo: `(() => { const e = document.getElementById('optPhoto'); if (!e.checked) { e.checked = true; e.dispatchEvent(new Event('change')); } })()`,
};

const q = (a, p) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return +s[Math.min(s.length - 1, Math.floor(p * s.length))].toFixed(2); };
const avg = (a) => (a.length ? +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(1) : null);
const max = (a) => (a.length ? Math.max(...a) : null);
function windowStats(w, smi, cnt, t0, t1, ad) {
  const d = w.t.slice(1).map((x, i) => x - w.t[i]), span = w.t.length > 1 ? w.t.at(-1) - w.t[0] : 0;
  const sm = smi.filter((s) => s.t >= t0 && s.t <= t1), cs = cnt.filter((s) => s.t >= t0 && s.t <= t1);
  const per = {}; for (const a of ad) { const k = a.luidHex; per[/NVIDIA/i.test(a.name) ? 'nv' : /AMD|Radeon/i.test(a.name) ? 'amd' : k] = {
    u3d: avg(cs.map((s) => Math.min(100, s.c[k + '.u3d'] || 0))), dedMB: avg(cs.map((s) => (s.c[k + '.ded'] || 0) / 2 ** 20)), shMB: avg(cs.map((s) => (s.c[k + '.sh'] || 0) / 2 ** 20)) }; }
  return { frames: w.t.length, fps: span ? +((w.t.length - 1) / span * 1000).toFixed(1) : null, ftMed: q(d, 0.5), ftP95: q(d, 0.95), ftP99: q(d, 0.99),
    gpuMs: w.timer ? { n: w.gpu.length, med: q(w.gpu, 0.5), p95: q(w.gpu, 0.95) } : null, calls: q(w.info.map((x) => x[0]), 0.5), trisM: +((q(w.info.map((x) => x[1]), 0.5) || 0) / 1e6).toFixed(2),
    ...w.mem, heapMB: w.heapMB, dpr: w.dpr, size: w.size, photo: w.photo, terrain: w.terrain, state: w.state,
    nvUtil: avg(sm.map((s) => s.util)), nvUtilMax: max(sm.map((s) => s.util)), nvMemMB: avg(sm.map((s) => s.memMB)), nvMemMaxMB: max(sm.map((s) => s.memMB)), counters: per, counterSamples: cs.length };
}

async function waitSettled(page, ms = 150000) { const t = Date.now(); let ok = 0; while (Date.now() - t < ms) { ok = (await page.evaluate(SETTLED_JS)) ? ok + 1 : 0; if (ok >= 4) return Date.now() - t - 1500; await sleep(500); } return null; }

async function oneRun(browser, gpu, run, ad) {
  const flags = GPU[gpu][browser]; if (flags == null) return { browser, gpu, run, skipped: `${browser} has no per-launch option that selects the ${gpu} (see docs/GPU.md)` };
  const vs = opt.vsync ? [] : (NO_VSYNC[browser === 'edge' ? 'chrome' : browser]);
  const isFx = browser === 'firefox';
  const b = await launchBrowser({ browser, headed: !opt.headless, args: [...flags, ...(isFx ? [] : vs), ...opt.arg], firefoxPrefs: isFx ? { ...FX_PREFS, ...(opt.vsync ? {} : vs) } : undefined });
  const smi = nvsmi(), cnt = winCounters(), out = { browser, gpu, run, flags, vsync: !!opt.vsync, version: await b.version(), windows: [] };
  try {
    const page = await b.newPage();
    if (+opt.scale && +opt.scale !== 1) await page.setViewport({ width: 1500, height: 950, deviceScaleFactor: +opt.scale });
    const errs = []; page.on('pageerror', (e) => errs.push(String(e.message || e).slice(0, 200)));
    const t0 = Date.now();
    await page.goto(BASE + (opt.query ? '?' + opt.query : ''), { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForFunction(VIEWER_READY, { timeout: 120000, polling: 250 }); out.readyMs = Date.now() - t0;
    out.gl = await page.evaluate(APP_GL_JS); out.gpuOk = WANT[gpu].test(out.gl.renderer);
    const scen = list(opt.scenarios, 'frags,terrain,photo'), poses = list(opt.poses, 'iso,street');
    const measure = async (sc, pose) => {
      const t1 = Date.now(); await page.evaluate(FRAME_JS); await sleep(SECONDS * 1000); const w = await page.evaluate(STOP_JS);
      const s = { scenario: sc, pose, ...windowStats(w, smi.out, cnt.out, t1, Date.now(), ad) }; out.windows.push(s);
      console.error(`  ${browser}/${gpu}#${run} ${sc}@${pose}: ${s.fps} fps, ft med ${s.ftMed} p95 ${s.ftP95} ms, gpu ${s.gpuMs?.med ?? '-'} ms, ${s.calls} calls, ${s.trisM} Mtris, nv ${s.nvUtil}% ${s.nvMemMB} MB, amd3d ${s.counters.amd?.u3d}% nv3d ${s.counters.nv?.u3d}%`);
    };
    for (const pose of poses) {      // terrain-only and Fragments-only first (no ion usage), at each pose after the terrain settled
      if (!scen.includes('frags') && !scen.includes('terrain')) break;
      await page.evaluate(SCEN.terrain); await page.evaluate(POSES[pose]); const st = await waitSettled(page); (out.terrainSettledMs ||= {})[pose] = st;
      if (scen.includes('terrain')) await measure('terrain', pose);
      if (scen.includes('frags')) { await page.evaluate(SCEN.frags); await sleep(500); await measure('frags', pose); }
    }
    if (scen.includes('photo')) {
      await page.evaluate(SCEN.terrain); await page.evaluate(POSES[poses[0]]);
      const te = Date.now(); await page.evaluate(SCEN.photo);
      for (const pose of poses) { await page.evaluate(POSES[pose]); await sleep(300); const st = await waitSettled(page, 180000); (out.photoSettledMs ||= {})[pose] = st == null ? null : (pose === poses[0] ? Date.now() - te - 1500 : st); await measure('photo', pose); }
    }
    out.pageErrors = errs;
  } catch (e) { out.error = String(e.message || e); } finally { smi.stop(); cnt.stop(); await b.close().catch(() => {}); }
  return out;
}

if (opt.probe) { await probe(); process.exit(0); }
const ad = await adapters();
console.error('adapters', JSON.stringify(ad));
const runs = [];
for (const browser of list(opt.browser, 'chrome')) for (let r = 1; r <= RUNS; r++) for (const gpu of list(opt.gpu, 'igpu,rtx')) {      // interleaved: igpu, rtx, igpu, ...
  const o = await oneRun(browser, gpu, r, ad); runs.push(o);
  console.error(`${browser}/${gpu}#${r}: ${o.skipped || o.error || `${o.gl?.renderer} gpuOk=${o.gpuOk} ready ${o.readyMs} ms`}`);
  if (opt.out) fs.writeFileSync(opt.out, JSON.stringify({ when: new Date().toISOString(), opt, adapters: ad, runs }, null, 1));
}
// summary: median over runs per browser x gpu x scenario x pose
const groups = new Map();
for (const o of runs) for (const w of o.windows || []) { const k = [o.browser, o.gpu, w.scenario, w.pose].join('|'); if (!groups.has(k)) groups.set(k, []); groups.get(k).push({ ...w, gpuOk: o.gpuOk }); }
const med = (a) => q(a.filter((x) => x != null), 0.5);
const rows = [...groups].map(([k, ws]) => { const [browser, gpu, scenario, pose] = k.split('|'); return { browser, gpu, scenario, pose, runs: ws.length, gpuOk: ws.every((w) => w.gpuOk),
  fps: med(ws.map((w) => w.fps)), ftMed: med(ws.map((w) => w.ftMed)), ftP95: med(ws.map((w) => w.ftP95)), gpuMs: med(ws.map((w) => w.gpuMs?.med)), gpuP95: med(ws.map((w) => w.gpuMs?.p95)),
  calls: med(ws.map((w) => w.calls)), trisM: med(ws.map((w) => w.trisM)), tex: med(ws.map((w) => w.textures)), geo: med(ws.map((w) => w.geometries)), heapMB: med(ws.map((w) => w.heapMB)),
  nvUtil: med(ws.map((w) => w.nvUtil)), nvMemMB: med(ws.map((w) => w.nvMemMB)), amd3d: med(ws.map((w) => w.counters.amd?.u3d)), nv3d: med(ws.map((w) => w.counters.nv?.u3d)),
  amdShMB: med(ws.map((w) => w.counters.amd?.shMB)), nvDedMB: med(ws.map((w) => w.counters.nv?.dedMB)) }; });
console.table(rows);
const load = runs.filter((o) => o.readyMs).map((o) => ({ browser: o.browser, gpu: o.gpu, run: o.run, readyMs: o.readyMs, terrainSettledMs: JSON.stringify(o.terrainSettledMs || {}), photoSettledMs: JSON.stringify(o.photoSettledMs || {}) }));
console.table(load);
if (opt.out) fs.writeFileSync(opt.out, JSON.stringify({ when: new Date().toISOString(), opt, adapters: ad, runs, summary: rows, load }, null, 1));
const bad = runs.filter((o) => !o.skipped && (o.error || !o.gpuOk || !(o.windows || []).length));
console.log(bad.length ? `FAIL: ${bad.length} runs errored, measured nothing, or did not get the requested GPU` : `OK: ${runs.filter((o) => !o.skipped).length} runs measured`);
process.exit(bad.length ? 1 : 0);
