#!/usr/bin/env node
// Browser-free checks of the geographic-layer loading logic: fetch retry policy (viewer/net.js), error classification and the
// failed-tile supervisor (viewer/geostatus.js). No network, no ion usage.   node scripts/test-tiles-unit.mjs
import assert from 'node:assert/strict';
import { backoffMs, installFetchRetry, netStats, TIMEOUT_MS } from '../viewer/net.js';
import { classifyError, supervise } from '../viewer/geostatus.js';

let pass = 0; const ok = (name) => { pass++; console.log('ok  ', name); };
const resp = (status, headers = {}) => new Response(status === 204 ? null : 'x', { status, headers });

// backoff: exponential, full jitter in [0.5, 1] x, capped at 15 s; Retry-After (seconds / HTTP date) wins
for (let a = 0; a < 8; a++) { const v = backoffMs(a, 500); assert(v >= Math.min(15000, 500 * 2 ** a) * 0.5 && v <= Math.min(15000, 500 * 2 ** a)); }
assert.equal(backoffMs(3, 500, '2'), 2000);
assert(Math.abs(backoffMs(0, 500, new Date(Date.now() + 3000).toUTCString()) - 3000) < 1100);
assert.equal(backoffMs(0, 500, '9999'), 60000);
ok('backoff exponential + jitter + cap, Retry-After seconds and date');

// fetch wrapper against a scripted fake fetch
function fake(script) { const calls = []; const t = { fetch: async (u, init) => { calls.push({ u: String(u), init }); const s = script.shift(); if (s instanceof Error) throw s; return resp(s, s === 429 ? { 'retry-after': '0' } : {}); } }; installFetchRetry(t); return { t, calls }; }
{ const { t, calls } = fake([503, 502, 200]); const r = await t.fetch('https://terrain.reearth.land/x.terrain'); assert.equal(r.status, 200); assert.equal(calls.length, 3); ok('5xx retried until success'); }
{ const { t, calls } = fake([401, 200]); const r = await t.fetch('https://tile.googleapis.com/v1/3dtiles/a.glb'); assert.equal(r.status, 401); assert.equal(calls.length, 1); ok('401 not retried'); }
{ const { t, calls } = fake([403, 200]); const r = await t.fetch('https://api.cesium.com/v1/assets/1/endpoint'); assert.equal(r.status, 403); assert.equal(calls.length, 1); ok('403 not retried'); }
{ const { t, calls } = fake([429, 200]); const r = await t.fetch('https://tile.googleapis.com/v1/3dtiles/b.glb'); assert.equal(r.status, 200); assert.equal(calls.length, 2); ok('429 retried (Retry-After honoured)'); }
{ const { t, calls } = fake([503, 503, 503, 503, 503, 503, 503, 503]); const r = await t.fetch('https://www.gstatic.com/draco/versioned/decoders/1.5.7/draco_decoder.wasm'); assert.equal(r.status, 503); assert.equal(calls.length, 4); ok('bounded: draco host gives up after 4 attempts and returns the last response'); }
{ const { t, calls } = fake([new TypeError('Failed to fetch'), 200]); const r = await t.fetch('https://server.arcgisonline.com/t/1'); assert.equal(r.status, 200); assert.equal(calls.length, 2); ok('network error retried'); }
{ const ac = new AbortController(); ac.abort(); const e = new DOMException('aborted', 'AbortError'); const { t, calls } = fake([e, 200]);
  await assert.rejects(t.fetch('https://tile.googleapis.com/v1/3dtiles/c.glb', { signal: ac.signal }), { name: 'AbortError' }); assert.equal(calls.length, 1); ok('aborted request not retried'); }
{ const { t, calls } = fake([200]); await t.fetch('https://example.com/a'); assert.equal(calls[0].u, 'https://example.com/a'); ok('other hosts pass through untouched'); }
{ const { t, calls } = fake([200]); await t.fetch(new URL('https://api.cesium.com/v1/assets/2275207/endpoint?access_token=SECRET&v=1'));
  assert(!calls[0].u.includes('SECRET') && calls[0].u.includes('v=1')); assert.equal(calls[0].init.headers.Authorization, 'Bearer SECRET'); ok('ion token moved from the URL to an Authorization header'); }
{ TIMEOUT_MS.value = 200; let n = 0; const t = { fetch: (u, init) => (++n === 1 ? new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')))) : Promise.resolve(resp(200))) };
  installFetchRetry(t); const before = netStats.terrain.timeouts; const r = await t.fetch('https://terrain.reearth.land/1/0/0.terrain');
  assert.equal(r.status, 200); assert.equal(n, 2); assert.equal(netStats.terrain.timeouts - before, 1); TIMEOUT_MS.value = 25000; ok('a request that never answers is aborted after the timeout and retried'); }
{ const { t } = fake([200]); const r = await t.fetch('https://tile.googleapis.com/v1/3dtiles/d.glb'); const before = netStats.google.bytes; await r.arrayBuffer(); assert.equal(netStats.google.bytes - before, 1); ok('decoded body bytes counted'); }

// error classification
const c = (m, u) => classifyError(new Error(m), u, { origin: 'http://127.0.0.1:5192', online: true });
assert.equal(c('CesiumIonAuthPlugin: Failed to load data with error code 401', 'https://api.cesium.com/v1/assets/2275207/endpoint').kind, 'auth');
assert.match(c('CesiumIonAuthPlugin: Failed to load data with error code 403', 'https://api.cesium.com/v1/assets/2275207/endpoint').msg, /Allowed URLs.*127\.0\.0\.1:5192/);
assert.equal(c('CesiumIonAuthPlugin: Failed to load data with error code 404', 'https://api.cesium.com/v1/assets/2275207/endpoint').kind, 'asset');
assert.match(c('GoogleCloudAuth: Failed to load data with error code 403', 'https://api.cesium.com/v1/assets/2275207/endpoint').msg, /^Google/);
assert.deepEqual([c('Failed to load model with error code 429').kind, c('Failed to load model with error code 429').permanent], ['quota', false]);
assert.deepEqual([c('Failed to load model with error code 503').kind, c('Failed to load model with error code 503').permanent], ['server', false]);
assert.equal(c('Failed to fetch').kind, 'network'); assert.equal(c('NetworkError when attempting to fetch resource.').kind, 'network');
assert.equal(classifyError(new Error('Failed to fetch'), '', { online: false }).kind, 'offline');
assert.equal(c('THREE.DRACOLoader: decoder failed to load wasm').kind, 'draco');
for (const k of [401, 403, 404]) assert.equal(c(`CesiumIonAuthPlugin: Failed to load data with error code ${k}`, 'https://api.cesium.com/v1/assets/1/endpoint').permanent, true);
ok('error classification: 401/403/404/429/5xx/network/offline/draco, permanent vs retryable');

// supervisor on a fake TilesRenderer: a failed tile is retried with backoff, bounded; a permanent error is not retried
function fakeTiles() {
  const L = {}; const t = { stats: { queued: 0, downloading: 0, parsing: 0, loaded: 10, failed: 1, refused: 0 }, visibleTiles: new Set(), errorTarget: 20, resets: 0,
    downloadQueue: { running: false }, parseQueue: { running: false }, processNodeQueue: { running: false }, lruCache: { cachedBytes: 0, maxBytesSize: 1 },
    addEventListener: (n, f) => (L[n] = f), removeEventListener: () => {}, resetFailedTiles() { this.resets++; this.stats.failed = 0; }, emit: (n, e) => L[n](e) };
  return t;
}
{ const t = fakeTiles(); const sv = supervise(t, { maxRounds: 2 }); t.emit('load-error', { tile: {}, error: new Error('Failed to load model with error code 503'), url: 'https://tile.googleapis.com/x.glb' });
  let s = sv.assess(0); assert.equal(s.state, 'degraded'); assert.match(s.detail, /retry 1\/2/);
  await new Promise((r) => setTimeout(r, 1100)); assert.equal(t.resets, 1); s = sv.assess(2000); assert.notEqual(s.state, 'degraded');
  t.stats.failed = 1; s = sv.assess(3000); assert.match(s.detail, /retry 2\/2/); await new Promise((r) => setTimeout(r, 2100)); assert.equal(t.resets, 2);
  t.stats.failed = 1; s = sv.assess(6000); assert.match(s.detail, /retries used up/); assert.equal(s.action, 'retry'); await new Promise((r) => setTimeout(r, 300)); assert.equal(t.resets, 2);
  sv.dispose(); ok('failed tiles: retried with backoff, bounded at maxRounds, then a manual Retry action'); }
{ const t = fakeTiles(); const sv = supervise(t); t.emit('load-error', { tile: {}, error: new Error('Failed to load model with error code 403'), url: 'https://tile.googleapis.com/x.glb' });
  const s = sv.assess(0); assert.equal(s.state, 'degraded'); await new Promise((r) => setTimeout(r, 1200)); assert.equal(t.resets, 0); sv.dispose(); ok('permanent tile error (403): not retried automatically'); }
{ const t = fakeTiles(); t.stats.failed = 0; const sv = supervise(t, { settleMs: 1000 }); assert.equal(sv.assess(0).state, 'refining'); assert.equal(sv.assess(1000).state, 'complete');
  t.stats.queued = 3; assert.equal(sv.assess(1100).state, 'loading'); assert.match(sv.assess(1100).detail, /10 of 13/); sv.dispose(); ok('complete only after the settle window; loading shows n of m'); }
console.log(`PASS ${pass} checks`);
