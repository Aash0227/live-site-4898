#!/usr/bin/env node
// One-shot browser probe. Prints ONE JSON object: browser, WebGL renderer, console/page errors, failed requests, ready time, eval result.
//   node scripts/bt.mjs --url http://127.0.0.1:5188/viewer/ [--browser chrome|edge|firefox] [--gpu default|software] [--headed]
//        [--ready "<js expr>"] [--eval "<js expr or async IIFE>"] [--wait ms] [--shot out.png] [--arg --chrome-flag ...]
import { launchBrowser, openPage, GL_INFO_JS, VIEWER_READY } from './lib/browser.mjs';
const argv = process.argv.slice(2), opt = { arg: [] };
for (let i = 0; i < argv.length; i++) { const k = argv[i]; if (!k.startsWith('--')) continue; const n = k.slice(2); const v = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true; if (n === 'arg') opt.arg.push(v); else opt[n] = v; }
if (!opt.url) { console.error('usage: bt.mjs --url <url> [--browser chrome|edge|firefox] [--gpu default|software] [--headed] [--ready expr|viewer] [--eval expr] [--wait ms] [--shot file]'); process.exit(2); }
const b = await launchBrowser({ browser: opt.browser || 'chrome', gpu: opt.gpu || 'default', headed: !!opt.headed, args: opt.arg });
const out = { browser: opt.browser || 'chrome', url: opt.url };
try {
  out.version = await b.version();
  const ready = opt.ready === 'viewer' ? VIEWER_READY : opt.ready;
  const { page, log, readyMs } = await openPage(b, opt.url, { readyExpr: ready });
  out.readyMs = readyMs; out.gl = await page.evaluate(GL_INFO_JS);
  if (opt.wait) await new Promise((r) => setTimeout(r, +opt.wait));
  if (opt.eval) out.result = await page.evaluate(opt.eval);
  if (opt.shot) { await page.screenshot({ path: opt.shot }); out.screenshot = opt.shot; }
  Object.assign(out, log);
} catch (e) { out.error = String(e.message || e); } finally { await b.close().catch(() => {}); }
console.log(JSON.stringify(out, null, 1));
