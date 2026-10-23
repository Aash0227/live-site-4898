# Google photoreal loading: root causes, fixes, tests

**Root causes found** (deterministic fault injection in `scripts/test-tiles.mjs`):
1. A failed tile counts as "download finished" for the 3D Tiles traversal: its parent is replaced anyway and the failed area stays a
   HOLE for the rest of the session (nothing re-requested it). That is the "loads fully in one browser, incompletely in another" symptom:
   which tiles fail (network blip, throttling, a hidden/background tab) differs per browser session.
2. A failed Cesium ion endpoint / Google root request is swallowed by the ion plugin: the layer reports a loaded root without a tileset
   and stays empty forever.
3. A request that never answers held its queue slot forever.
4. A hidden page stops requestAnimationFrame, so tiles stop refining (the in-app browser pane when it is not shown).

**Fixes:** `viewer/net.js` bounded retries with backoff + jitter for terrain / imagery / ion / Google / Draco (Retry-After honoured; no
retry on 401/403/404 or aborts; 25 s first-byte timeout per attempt; the ion token moved from the URL to a header);
`viewer/geostatus.js` state model idle / connecting / loading / refining / complete / degraded / failed / paused with an on-screen
indicator, bounded re-requests of failed tiles, actionable messages (401 token, 403 allowed URLs, 429 quota, offline, decoder blocked,
WebGL context lost -> reload), context-loss handling; `photoreal.js` root rebuild with backoff, leak-free retry, calibration after the
mesh settles. `?photo=1` auto-enables the layer, `?debug=1` shows GPU + fps.

**Tests (2026-10-22, same revision, same pose, fresh profile per run):**
`node scripts/test-tiles.mjs --browser chrome,firefox,edge --runs 2`: 6/6 runs reach the objective "complete" state (nothing queued /
downloading / parsing for 3 s, no tile left to refine, nothing refused or failed): 356 tiles loaded, 0 failed, 90 visible in every run;
complete after 14.6 / 14.9 s (Chrome), 22.7 / 18.1 s (Firefox), 20.6 / 19.2 s (Edge).
Fault injection (Chrome): `--inject tile503` (every 7th tile fails once) -> complete, 0 failed; `--inject endpoint503` -> complete;
`--inject endpoint401 --expect failed` -> state "failed" after 3.1 s with "Cesium ion rejected the token (401) ..." and no retry loop.
Edge launches under puppeteer with `--edge-skip-compat-layer-relaunch` (scripts/lib/browser.mjs).
