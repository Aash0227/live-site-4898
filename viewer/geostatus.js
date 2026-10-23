// Loading-state model for the geographic 3D Tiles layers (terrain + photoreal) and the small on-canvas indicator.
// States: idle · connecting · loading (n of m) · refining · complete · degraded · failed · paused
import { backoffMs } from './net.js';

// Raw counts of one TilesRenderer. "unrefined" = visible tiles that still want their children (error above target).
// Failed tiles count as "finished" for the renderer's traversal, so a failed child leaves a HOLE, not a coarse parent:
// that is why `failed` must be 0 for "complete", and why failed tiles are retried below.
export function tileCounts(t) {
  const s = t.stats; let visible = 0, unrefined = 0;
  for (const x of t.visibleTiles) { visible++; if (x.children.length && x.traversal.error > t.errorTarget) unrefined++; }
  return { queued: s.queued, downloading: s.downloading, parsing: s.parsing, loaded: s.loaded, failed: s.failed, refused: s.refused, visible, unrefined,
    busy: !!(t.downloadQueue.running || t.parseQueue.running || t.processNodeQueue.running),
    cacheMB: Math.round(t.lruCache.cachedBytes / 2 ** 20), cacheMaxMB: Math.round(t.lruCache.maxBytesSize / 2 ** 20) };
}

// Turns a tiles 'load-error' into something a person can act on. permanent = retrying cannot help (do not spend quota on it).
export function classifyError(err, url = '', { origin = globalThis.location?.origin, online = globalThis.navigator?.onLine !== false } = {}) {
  const m = String(err?.message || err || ''), code = +(m.match(/(?:error code|status) (\d{3})/i)?.[1] || 0);
  // the ion plugin relays Google session errors with the ion URL: look at the message first
  const google = /googleapis|GoogleCloud/i.test(m) || /googleapis/.test(String(url)), ion = !google && (/cesium\.com/.test(String(url)) || /CesiumIon/i.test(m));
  const who = ion ? 'Cesium ion' : google ? 'Google Map Tiles' : 'The tile server';
  if (/draco|wasm|decoder/i.test(m)) return { kind: 'draco', permanent: true, msg: 'The Draco mesh decoder (www.gstatic.com/draco) could not be loaded: a firewall, ad blocker or content policy blocks it.' };
  if (code === 401) return { kind: 'auth', code, permanent: true, msg: `${who} rejected the token (401): check VITE_CESIUM_ION_TOKEN in .env.local (valid, not revoked, scope assets:read) and restart the dev server.` };
  if (code === 403) return { kind: 'origin', code, permanent: true, msg: ion ? `Cesium ion refused this site (403): the token's Allowed URLs do not include ${origin}. Add it at ion.cesium.com/tokens.` : `${who} refused the request (403): API key restriction or the session was revoked.` };
  if (code === 404 && ion) return { kind: 'asset', code, permanent: true, msg: 'Cesium ion: asset 2275207 is not available to this token (404). Add "Google Photorealistic 3D Tiles" to My Assets at ion.cesium.com.' };
  if (code === 429) return { kind: 'quota', code, permanent: false, msg: `${who} rate limit / quota reached (429).` };
  if (code >= 500) return { kind: 'server', code, permanent: false, msg: `${who} server error (${code}).` };
  if (code >= 400) return { kind: 'http', code, permanent: true, msg: `${who} answered ${code}.` };
  if (!online) return { kind: 'offline', permanent: false, msg: 'The browser is offline.' };
  if (/fetch|network|load failed/i.test(m)) return { kind: 'network', permanent: false, msg: `${who} unreachable (network error: blocked, offline or connection reset).` };
  return { kind: 'other', permanent: false, msg: m.slice(0, 160) || 'tile request failed' };
}

// Supervises one TilesRenderer: state from its counts, bounded retries of failed tiles (exponential backoff + jitter).
export function supervise(tiles, { maxRounds = 5, settleMs = 1000, stuckMs = 3000, onRetry = () => {} } = {}) {
  const sv = { tiles, lastError: null, round: 0, timer: 0, retryAt: 0, quietSince: null };
  const onErr = (e) => { if (e.tile) sv.lastError = classifyError(e.error, e.url); };
  tiles.addEventListener('load-error', onErr);
  sv.dispose = () => { tiles.removeEventListener('load-error', onErr); clearTimeout(sv.timer); };
  sv.assess = (now = performance.now()) => {
    const c = tileCounts(tiles), pending = c.queued + c.downloading + c.parsing;
    if (pending > 0 || c.busy) { sv.quietSince = null; return { state: 'loading', detail: `${c.loaded} of ${c.loaded + pending} tiles`, c }; }
    sv.quietSince ??= now; const quiet = now - sv.quietSince;
    if (!c.unrefined && !c.failed && !c.refused) { if (quiet >= settleMs) { sv.round = 0; return { state: 'complete', detail: `${c.visible} tiles`, c }; } return { state: 'refining', detail: 'settling', c }; }
    if (quiet < stuckMs && !c.failed) return { state: 'refining', detail: `${c.unrefined} tiles refining`, c };
    if (c.failed) {
      const err = sv.lastError || { msg: 'tile request failed', permanent: false };
      if (!err.permanent && sv.round < maxRounds && !sv.timer) {
        const ms = backoffMs(sv.round++, 1000); sv.retryAt = now + ms;
        sv.timer = setTimeout(() => { sv.timer = 0; sv.retryAt = 0; sv.quietSince = null; tiles.resetFailedTiles(); onRetry(sv.round); }, ms);
      }
      const next = sv.timer ? `, retry ${sv.round}/${maxRounds} in ${Math.max(0, (sv.retryAt - now) / 1000).toFixed(0)} s` : err.permanent ? '' : ', automatic retries used up';
      return { state: 'degraded', detail: `${c.failed} tiles failed: ${err.msg}${next}`, c, action: sv.timer ? null : 'retry' };
    }
    if (c.refused) return { state: 'degraded', detail: `tile cache full (${c.cacheMB} of ${c.cacheMaxMB} MB): ${c.refused} tiles refused`, c };
    return { state: 'degraded', detail: `${c.unrefined} tiles cannot refine`, c };
  };
  sv.retryNow = () => { clearTimeout(sv.timer); sv.timer = 0; sv.round = 0; sv.quietSince = null; tiles.resetFailedTiles(); };
  return sv;
}

// ── on-canvas indicator ─────────────────────────────────────────────────────────────────────────
const CSS = `#geoState{position:fixed;left:calc(var(--side-w,300px) + 10px);bottom:30px;z-index:6;max-width:min(560px,calc(100% - 2*var(--side-w,300px) - 20px));
  display:none;align-items:center;gap:8px;padding:5px 10px;border-radius:14px;background:rgba(17,20,27,.88);border:1px solid #262b36;color:#e7e9ee;font:12px/1.35 system-ui,sans-serif;pointer-events:none}
#geoState.on{display:flex}#geoState i{flex:none;width:8px;height:8px;border-radius:50%;background:#9098a8}#geoState button{pointer-events:auto;padding:2px 8px;font-size:11.5px}
#geoState[data-s=loading] i,#geoState[data-s=connecting] i,#geoState[data-s=refining] i{background:#4fa3e0;animation:geoPulse 1s infinite alternate}
#geoState[data-s=complete] i{background:#3fb27f}#geoState[data-s=degraded] i,#geoState[data-s=paused] i{background:#e3a12f}#geoState[data-s=failed] i{background:#e2534b}
@keyframes geoPulse{to{opacity:.35}}@media (max-width:900px){#geoState{left:10px;max-width:calc(100% - 20px)}}
#geoDebug{position:fixed;right:calc(var(--side-w,300px) + 10px);top:56px;z-index:6;padding:3px 8px;border-radius:6px;background:rgba(17,20,27,.85);color:#cfd3da;font:11px/1.35 ui-monospace,monospace;pointer-events:none;white-space:pre}
@media (max-width:900px){#geoDebug{right:10px}}`;
let styled = false;
const injectCss = () => { if (styled) return; styled = true; const s = document.createElement('style'); s.textContent = CSS; document.head.append(s); };

export function createIndicator({ actions = {} } = {}) {
  injectCss();
  const el = document.createElement('div'); el.id = 'geoState'; el.setAttribute('role', 'status'); el.setAttribute('aria-live', 'polite');
  el.innerHTML = '<i></i><span></span>'; document.body.append(el);
  const span = el.querySelector('span'); let hideT = 0, last = '';
  return {
    el,
    show({ state, detail, action }, label = 'Photoreal 3D') {
      const key = state + detail + action; if (key === last) return; last = key;
      clearTimeout(hideT); el.dataset.s = state; el.classList.toggle('on', state !== 'idle');
      span.textContent = `${label}: ${state}${detail ? ' · ' + detail : ''}`;
      el.querySelector('button')?.remove();
      if (action && actions[action]) { const b = document.createElement('button'); b.textContent = action === 'reload' ? 'Reload page' : 'Retry'; b.onclick = actions[action]; el.append(b); }
      if (state === 'complete') hideT = setTimeout(() => el.classList.remove('on'), 4000);
    },
  };
}

// WebGL context loss (GPU reset, driver update, out of GPU memory): there is no in-place recovery for the Fragments + tiles GPU
// resources, so say so and offer a reload. preventDefault() lets the browser restore the context if it can.
export function watchContext(canvas, onChange) {
  canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); onChange({ state: 'failed', detail: 'WebGL context lost (GPU reset or out of GPU memory). Reload the page to rebuild the scene.', action: 'reload' }); });
  canvas.addEventListener('webglcontextrestored', () => onChange({ state: 'failed', detail: 'WebGL context restored, but tile and model GPU data are gone. Reload the page.', action: 'reload' }));
}

// ?debug=1: GPU renderer string of the app's context, fps and frame time, draw calls; so the user can check which GPU is in use.
export function debugLine(renderer, extra = () => '') {
  injectCss();
  const g = renderer.getContext(), ext = g.getExtension('WEBGL_debug_renderer_info');
  const gpu = String(ext ? g.getParameter(ext.UNMASKED_RENDERER_WEBGL) : g.getParameter(g.RENDERER)).replace(/^ANGLE \(|\)$/g, '');
  const pp = g.getContextAttributes()?.powerPreference;
  const el = document.createElement('div'); el.id = 'geoDebug'; document.body.append(el);
  const ft = []; let prev = performance.now();
  const tick = (now) => { ft.push(now - prev); prev = now; if (ft.length > 120) ft.shift(); requestAnimationFrame(tick); };
  requestAnimationFrame(tick);
  setInterval(() => {
    const s = [...ft].sort((a, b) => a - b), med = s[s.length >> 1] || 0, i = renderer.info.render;
    el.textContent = `${gpu}  [${pp}]\n${(1000 / (med || 1)).toFixed(0)} fps · median ${med.toFixed(1)} ms · p95 ${(s[Math.floor(s.length * 0.95)] || 0).toFixed(1)} ms · ${i.calls} draws · ${(i.triangles / 1e6).toFixed(2)} M tris · dpr ${renderer.getPixelRatio().toFixed(2)}${extra()}`;
  }, 500);
  return el;
}
