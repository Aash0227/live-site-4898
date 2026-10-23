// Bounded retries + per-host request accounting for the geographic hosts (terrain, imagery, Cesium ion, Google tiles, Draco).
// Installed once as a window.fetch wrapper because the 3D Tiles plugins call the global fetch directly.
//   retried:     network errors, 408, 425, 429 (Retry-After honoured when the server exposes it), 5xx
//   not retried: 401/403/404 and every other 4xx (retrying a rejected token or a wrong asset only spends quota), aborted requests
// The Cesium ion endpoint request is the only one that carries the ion token; the library puts it in the query string, this
// wrapper moves it into an Authorization header so the token never appears in a URL (devtools, logs, proxies).
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const HOSTS = [
  { name: 'terrain', re: /^https:\/\/terrain\.reearth\.land\//, tries: 7, baseMs: 300 },
  { name: 'imagery', re: /^https:\/\/server\.arcgisonline\.com\//, tries: 5, baseMs: 400 },
  { name: 'ion', re: /^https:\/\/(api|assets)\.(ion\.)?cesium\.com\//, tries: 5, baseMs: 500 },
  { name: 'google', re: /^https:\/\/tile\.googleapis\.com\//, tries: 5, baseMs: 500 },
  { name: 'draco', re: /^https:\/\/www\.gstatic\.com\/draco\//, tries: 4, baseMs: 500 },
];
const MAX_DELAY_MS = 15000;
// first-byte timeout per attempt: a request that never answers (stalled connection) is aborted and retried instead of blocking its
// tile forever. Measured: 2 terrain requests hung > 150 s in one run, the terrain then never loaded (docs/TILES-LOADING.md).
export const TIMEOUT_MS = { value: 25000 };
const RETRY_STATUS = (s) => s === 408 || s === 425 || s === 429 || s >= 500;

// stats[host] = { requests, ok, retries, netErrors, timeouts, bytes, status: {code: n}, last: 'message' }; read by the status UI and the tests
export const netStats = {};
const stat = (h) => (netStats[h] ||= { requests: 0, ok: 0, retries: 0, netErrors: 0, timeouts: 0, bytes: 0, status: {}, last: '' });

// exponential backoff with full jitter; Retry-After (seconds or HTTP date) wins when it is readable (CORS must expose it)
export function backoffMs(attempt, baseMs, retryAfter = null) {
  if (retryAfter != null && retryAfter !== '') {
    const s = Number(retryAfter);
    const ms = Number.isFinite(s) ? s * 1000 : Date.parse(retryAfter) - Date.now();
    if (Number.isFinite(ms) && ms >= 0) return Math.min(ms, 60000);
  }
  return Math.min(MAX_DELAY_MS, baseMs * 2 ** attempt) * (0.5 + Math.random() * 0.5);
}

function moveIonToken(url, init) {
  if (!/^https:\/\/api\.cesium\.com\//.test(url)) return [url, init];
  const u = new URL(url); const tok = u.searchParams.get('access_token');
  if (!tok) return [url, init];
  u.searchParams.delete('access_token');
  return [u.toString(), { ...init, headers: { ...(init?.headers || {}), Authorization: `Bearer ${tok}` } }];
}

// decoded body bytes, counted when the consumer reads the body (compressed tile responses carry no content-length)
function countBody(res, st) {
  const ab = res.arrayBuffer.bind(res), tx = res.text.bind(res);
  res.arrayBuffer = async () => { const v = await ab(); st.bytes += v.byteLength; return v; };
  res.text = async () => { const v = await tx(); st.bytes += v.length; return v; };
  res.json = async () => JSON.parse(await res.text());
}

export function installFetchRetry(target = window) {
  if (target.fetch.__lsvRetry) return;
  target.__lsvNet = netStats;
  const raw = target.fetch.bind(target);
  const wrapped = async (input, init) => {
    let url = typeof input === 'string' ? input : (input.href || input.url || String(input));
    const host = HOSTS.find((h) => h.re.test(url));
    if (!host) return raw(input, init);
    if (typeof input !== 'string') input = url;      // URL objects from the auth plugins
    [input, init] = moveIonToken(input, init);
    const st = stat(host.name);
    for (let a = 0; ; a++) {
      st.requests++;
      let res = null, err = null, timedOut = false;
      // own controller per attempt, linked to the caller's signal (which keeps aborting the body read after the headers arrived)
      const ctl = new AbortController();
      init?.signal?.addEventListener('abort', () => ctl.abort(), { once: true });
      const timer = setTimeout(() => { timedOut = true; ctl.abort(); }, TIMEOUT_MS.value);
      try { res = await raw(input, { ...init, signal: ctl.signal }); } catch (e) { err = e; } finally { clearTimeout(timer); }
      if (init?.signal?.aborted || (err?.name === 'AbortError' && !timedOut)) throw err || new DOMException('aborted', 'AbortError');
      if (timedOut) { st.timeouts++; err = new TypeError(`no response within ${TIMEOUT_MS.value / 1000} s`); res = null; }
      if (res) {
        st.status[res.status] = (st.status[res.status] || 0) + 1;
        if (res.ok) { st.ok++; countBody(res, st); return res; }
        st.last = `HTTP ${res.status}`;
        if (!RETRY_STATUS(res.status) || a + 1 >= host.tries) return res;
      } else {
        st.netErrors++; st.last = String(err?.message || err);
        if (a + 1 >= host.tries) throw err;
      }
      st.retries++;
      await sleep(backoffMs(a, host.baseMs, res?.headers.get('retry-after')));
    }
  };
  wrapped.__lsvRetry = true;
  target.fetch = wrapped;
}
