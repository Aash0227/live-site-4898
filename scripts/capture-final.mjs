// Final screenshots of the integrated viewer (built, served by serve.py): photoreal + demolition, engineering mode, before/after demolition.
import { launchBrowser, openPage, VIEWER_READY } from './lib/browser.mjs';
const OUT = process.argv[2] || 'docs/img', URL0 = process.argv[3] || 'http://127.0.0.1:8780/viewer/?photo=1';
const b = await launchBrowser({ browser: 'chrome', width: 1600, height: 950, args: ['--force_high_performance_gpu'] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  const { page, log } = await openPage(b, URL0, { readyExpr: VIEWER_READY, readyTimeout: 180000 });
  const settle = async (ms = 60000) => page.evaluate(async (ms) => { const a = __app, t0 = performance.now(); let q = null;
    while (performance.now() - t0 < ms) { const s = a.photo.tiles?.stats; const busy = s ? s.downloading + s.parsing + (s.queued || 0) : 1;
      if (s && s.visible > 30 && !busy && a.photo.calibration) { q ??= performance.now(); if (performance.now() - q > 2500) break; } else q = null; await new Promise((r) => setTimeout(r, 250)); }
    return Math.round(performance.now() - t0); }, ms);
  const pose = (p, t) => page.evaluate(([p, t]) => { __app.camera.position.set(...p); __app.controls.target.set(...t); __app.controls.update(); }, [p, t]);
  await settle(90000);
  const info = await page.evaluate(() => { const a = __app, g = a.renderer.getContext(), e = g.getExtension('WEBGL_debug_renderer_info');
    return { gpu: e ? g.getParameter(e.UNMASKED_RENDERER_WEBGL) : null, tiles: a.photo.tiles.stats.visible, calib: a.photo.calibration.offset, aligned: a.photo.aligned, partyWall: a.photo.calibration.partyWallTopM }; });
  await page.click('.tabs button[data-tab="site"]'); await sleep(300);
  await pose([78, 52, 96], [0, 6, 0]); console.error('settled', await settle());
  await page.screenshot({ path: `${OUT}/final-1-realistic-photoreal-demolished.png` });
  await page.evaluate(() => __app.photo.setCut(false)); await sleep(800); await page.screenshot({ path: `${OUT}/final-2-before-demolition.png` });
  await page.evaluate(() => __app.photo.setCut(true)); await sleep(300);
  await page.select('#modeSel', 'engineering'); await page.evaluate(() => __app.styler.idle()); await sleep(1500);
  await pose([-60, 28, 70], [0, 6, 0]); await settle(); await page.click('.tabs button[data-tab="model"]'); await sleep(300);
  await page.screenshot({ path: `${OUT}/final-3-engineering.png` });
  // click a wall in the middle of the view: real pick, properties panel
  const r = await page.evaluate(() => { const c = document.querySelector('#c').getBoundingClientRect(); return [c.left + c.width * 0.5, c.top + c.height * 0.55]; });
  await page.mouse.click(r[0], r[1]); await sleep(1500);
  const sel = await page.evaluate(() => { const s = __app.state().selected; return s >= 0 ? { cat: __app.els[s].cat, id: __app.els[s].id, type: __app.els[s].type } : null; });
  await page.screenshot({ path: `${OUT}/final-4-selected.png` });
  await page.select('#modeSel', 'realistic'); await page.evaluate(() => __app.styler.idle());
  console.log(JSON.stringify({ ...info, selected: sel, console: log.console.slice(0, 5), pageErrors: log.pageErrors }));
} finally { await b.close(); }
