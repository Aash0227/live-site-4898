// Shared browser driver for automated viewer tests: puppeteer-core against the SYSTEM Chrome / Edge / Firefox (no browser downloads).
// Chrome and Edge are driven over CDP, Firefox over WebDriver BiDi. One automated browser at a time on this machine (see CONTEXT.md locks).
import puppeteer from 'puppeteer-core';

export const EXE = {
  chrome: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  edge: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  firefox: 'C:/Program Files/Mozilla Firefox/firefox.exe',
};

// gpu: 'default' (whatever the browser picks), 'software' (SwiftShader, for functional tests that must not depend on a GPU),
// anything else is passed through by the caller as extra args.
// firefoxPrefs: prefs written ONLY into the throw-away automation profile puppeteer creates (never the user's profile).
// pipe: CDP over stdio instead of a debugging port (Edge, see docs/GPU.md "Edge under automation").
// background: false keeps background tabs/occluded windows rendering (automation default); true lets the browser behave like a
// user's browser (hidden tab = no frames), for the hidden-page test.
export async function launchBrowser({ browser = 'chrome', gpu = 'default', headed = false, width = 1500, height = 950, args = [], userDataDir, firefoxPrefs, pipe = false, dumpio = false, timeout = 30000, background = false } = {}) {
  const isFx = browser === 'firefox';
  const a = [`--window-size=${width},${height}`, ...args];
  if (!isFx && gpu === 'software') a.push('--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist');
  if (!isFx) a.push('--no-first-run', '--no-default-browser-check');
  if (!isFx && !background) a.push('--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows');
  // Edge 155 relaunches itself through its "compat layer" (the child gets --edge-skip-compat-layer-relaunch) and the process puppeteer
  // spawned exits with code 0: puppeteer reports "Failed to launch" and the relaunched browser is left running. Skipping the relaunch fixes both.
  if (browser === 'edge') a.push('--edge-skip-compat-layer-relaunch');
  const b = await puppeteer.launch({ executablePath: EXE[browser], browser: isFx ? 'firefox' : 'chrome', headless: !headed, args: a, defaultViewport: { width, height }, userDataDir,
    protocol: isFx ? 'webDriverBiDi' : undefined, extraPrefsFirefox: isFx ? firefoxPrefs : undefined, pipe: !isFx && pipe, dumpio, timeout });
  return b;
}

// WebGL identity of the APP's renderer context (the one that draws the scene), not of a fresh canvas: a context created with another
// powerPreference can land on another GPU. Falls back to GL_INFO_JS when the page has no window.__app.
export const APP_GL_JS = `(() => { const r = window.__app && window.__app.renderer; if (!r) return null; const g = r.getContext();
  const e = g.getExtension('WEBGL_debug_renderer_info'); const at = g.getContextAttributes();
  return { version: g.getParameter(g.VERSION), vendor: e ? g.getParameter(e.UNMASKED_VENDOR_WEBGL) : g.getParameter(g.VENDOR), renderer: e ? g.getParameter(e.UNMASKED_RENDERER_WEBGL) : g.getParameter(g.RENDERER),
    powerPreference: at.powerPreference, antialias: at.antialias, preserveDrawingBuffer: at.preserveDrawingBuffer, maxTexture: g.getParameter(g.MAX_TEXTURE_SIZE), dpr: devicePixelRatio, pixelRatio: r.getPixelRatio() }; })()`;

// Per-host accounting of every response the browser saw (status, bytes from content-length, a sample of the cache/CORS headers).
const HOST_RE = [['ion', /(api|assets)\.(ion\.)?cesium\.com/], ['google', /tile\.googleapis\.com/], ['draco', /gstatic\.com\/draco/], ['terrain', /terrain\.reearth\.land/], ['imagery', /arcgisonline\.com/], ['local', /^http:\/\/127\.0\.0\.1/]];
export const hostOf = (u) => (HOST_RE.find(([, re]) => re.test(u)) || ['other'])[0];
export function watchNetwork(page) {
  const by = {};
  const h = (k) => (by[k] ||= { responses: 0, status: {}, bytes: 0, noLength: 0, failed: 0, aborted: 0, failures: [], headers: null });
  page.on('response', (r) => {
    if (/^(blob|data):/.test(r.url())) return;      // glTF textures decoded through blob: URLs, not network traffic
    const k = hostOf(r.url()), e = h(k), s = r.status(); e.responses++; e.status[s] = (e.status[s] || 0) + 1;
    const hd = r.headers(); const n = +hd['content-length']; if (n) e.bytes += n; else if (s === 200) e.noLength++;
    if (!e.headers && s === 200 && k !== 'local') e.headers = Object.fromEntries(['cache-control', 'access-control-allow-origin', 'access-control-expose-headers', 'timing-allow-origin', 'content-encoding', 'content-type', 'age', 'expires'].filter((x) => hd[x] != null).map((x) => [x, hd[x]]));
  });
  // aborted = the tiles renderer cancelled a request it no longer needs (camera moved / cache eviction): not a failure
  page.on('requestfailed', (r) => { const e = h(hostOf(r.url())), t = r.failure()?.errorText || 'failed'; if (/ABORTED|NS_BINDING_ABORTED|aborted/i.test(t)) { e.aborted++; return; } e.failed++; if (e.failures.length < 5) e.failures.push(t); });
  // Chrome only: bytes on the wire per host (compressed responses carry no content-length)
  if (page.browser().protocol !== 'webDriverBiDi') page.createCDPSession().then(async (cdp) => {
    const ids = new Map(); await cdp.send('Network.enable');
    cdp.on('Network.responseReceived', (e) => ids.set(e.requestId, hostOf(e.response.url)));
    cdp.on('Network.loadingFinished', (e) => { const k = ids.get(e.requestId); if (k) { const x = h(k); x.wireBytes = (x.wireBytes || 0) + e.encodedDataLength; } });
  }).catch(() => {});
  return by;
}

// Opens a page and records everything an operator would look at: console errors/warnings, page errors, failed or >=400 requests.
export async function openPage(b, url, { readyExpr, readyTimeout = 120000 } = {}) {
  const page = await b.newPage();
  const log = { console: [], pageErrors: [], failed: [], http: [] };
  page.on('console', (m) => { const t = m.type(); if (t === 'error' || t === 'warning') log.console.push(`${t}: ${m.text()}`.slice(0, 400)); });
  page.on('pageerror', (e) => log.pageErrors.push(String(e.message || e).slice(0, 400)));
  page.on('requestfailed', (r) => log.failed.push(`${r.failure()?.errorText || 'failed'} ${r.url().replace(/([?&](key|token|access_token)=)[^&]+/gi, '$1***').slice(0, 200)}`));
  page.on('response', (r) => { if (r.status() >= 400) log.http.push(`${r.status()} ${r.url().replace(/([?&](key|token|access_token)=)[^&]+/gi, '$1***').slice(0, 200)}`); });
  const t0 = Date.now();
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  let ready = null;
  if (readyExpr) { try { await page.waitForFunction(readyExpr, { timeout: readyTimeout, polling: 250 }); ready = Date.now() - t0; } catch { ready = -1; } }
  return { page, log, readyMs: ready };
}

// WebGL identity of the page: which GPU the browser actually gave it (UNMASKED_RENDERER).
export const GL_INFO_JS = `(() => { const c = document.createElement('canvas'); const g = c.getContext('webgl2') || c.getContext('webgl'); if (!g) return { webgl: false };
  const e = g.getExtension('WEBGL_debug_renderer_info'); return { webgl: true, version: g.getParameter(g.VERSION), vendor: e ? g.getParameter(e.UNMASKED_VENDOR_WEBGL) : g.getParameter(g.VENDOR), renderer: e ? g.getParameter(e.UNMASKED_RENDERER_WEBGL) : g.getParameter(g.RENDERER) }; })()`;
export const VIEWER_READY = `!!(window.__app && document.querySelector('#loader') && document.querySelector('#loader').classList.contains('done'))`;
