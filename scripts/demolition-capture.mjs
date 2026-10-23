#!/usr/bin/env node
// Evidence capture for the demolition footprint and the site registration (see docs/DEMOLITION.md).
// Loads the viewer, streams the Google photoreal mesh around the site from a top-down camera, and writes top-down orthographic
// rasters of the already-loaded meshes: Google mesh height (DSM), survey terrain height (DTM) and Google mesh colour.
// The rasters are derived from Google content: they go to a scratch folder (--out) for analysis and are NOT committed.
//   node scripts/demolition-capture.mjs --url http://127.0.0.1:5193/viewer/ --out <dir> [--half 64] [--px 1280] [--error 4] [--headed]
import fs from 'node:fs';
import path from 'node:path';
import { launchBrowser, openPage, VIEWER_READY, GL_INFO_JS } from './lib/browser.mjs';
import { installProbe } from './lib/site-probe.mjs';

const argv = process.argv.slice(2), opt = {};
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) { const k = argv[i].slice(2); opt[k] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true; }
if (!opt.url || !opt.out) { console.error('usage: demolition-capture.mjs --url <viewer url> --out <dir> [--half m] [--px n] [--error px] [--headed]'); process.exit(2); }
const half = +(opt.half || 64), px = +(opt.px || 1280), errorTarget = +(opt.error || 4), cx = +(opt.cx || 0), cz = +(opt.cz || 0);
fs.mkdirSync(opt.out, { recursive: true });

const b = await launchBrowser({ browser: opt.browser || 'chrome', headed: !!opt.headed, width: 1400, height: 1000 });
const meta = { url: opt.url, half, px, errorTarget, cx, cz, when: new Date().toISOString() };
try {
  const { page, log, readyMs } = await openPage(b, opt.url, { readyExpr: VIEWER_READY });
  if (readyMs < 0) throw new Error('viewer not ready');
  meta.gl = await page.evaluate(GL_INFO_JS); meta.readyMs = readyMs;
  await installProbe(page);
  const eye = [cx, +(opt.height || 150), cz + 0.01];
  await page.evaluate((e, t) => window.__probe.look(e, t), eye, [cx, 0, cz]);
  meta.terrain = await page.evaluate(() => window.__probe.settle({ quiet: 4, timeout: 60000 }));
  meta.photoOn = await page.evaluate(() => window.__probe.enablePhoto());
  await page.evaluate((et) => { window.__app.photo.tiles.errorTarget = et; }, errorTarget);
  meta.settle = await page.evaluate(() => window.__probe.settle({ quiet: 6, timeout: 150000 }));
  await page.evaluate(() => window.__app.photo.setCut(false));
  await new Promise((r) => setTimeout(r, 1500));
  for (const [name, layers, kind] of [['dsm', ['photo'], 'height'], ['dtm', ['terrain'], 'height'], ['ortho', ['photo'], 'color']]) {
    const r = await page.evaluate((o) => window.__probe.ortho(o), { layers, kind, cx, cz, half, px });
    fs.writeFileSync(path.join(opt.out, `${name}.${kind === 'height' ? 'f32' : 'rgba'}`), Buffer.from(r.data, 'base64'));
    meta[name] = { kind, layers, mPerPx: r.mPerPx };
  }
  meta.calibration = await page.evaluate(() => window.__app.photo.calibration);
  meta.attributions = await page.evaluate(() => window.__app.photo.attributions().map((a) => (a.type === 'string' ? a.value : a.type)));
  meta.log = log;
} catch (e) { meta.error = String(e.stack || e); } finally { await b.close().catch(() => {}); }
fs.writeFileSync(path.join(opt.out, 'meta.json'), JSON.stringify(meta, null, 1));
console.log(JSON.stringify({ ...meta, log: meta.log && { console: meta.log.console.slice(0, 8), failed: meta.log.failed.length, http: meta.log.http.slice(0, 8) } }, null, 1));
process.exit(meta.error ? 1 : 0);
