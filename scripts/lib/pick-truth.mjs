// Ground truth for picking tests, computed in the page WITHOUT the viewer's picking code: an ID-colour render pass of the meshes that
// are actually on screen (Fragments tile meshes carry a per-vertex item id; proxies are instances), read back from the GPU.
// Identity is resolved independently of the app's own maps: itemId -> localId -> IFC GlobalId (Fragments API) -> model.json element.
// Install with page.evaluate(PICK_TRUTH_JS) after the viewer is ready; then window.__pt.* is available.
export const PICK_TRUTH_JS = String.raw`(async () => {
  const A = window.__app, T = A.THREE, R = A.renderer, M = A.model;
  const rev = new URLSearchParams(location.search).get('rev') || (await (await fetch('/revisions/index.json')).json()).revisions[0].id;
  const site = await (await fetch('/revisions/' + rev + '/model.json')).json();
  const els = site.elements, byGuid = new Map(els.map((e, i) => [e.ifc, i]));
  const proxyEls = els.map((e, i) => i).filter((i) => els[i].detail === 'BoundingBoxProxy');   // instance order = export order (checked in selfCheck)
  const KIND = { frag: 255, proxy: 200, geo: 100 };
  const vs = (inst) => 'attribute vec4 id;\nvarying vec4 vId;\n#include <clipping_planes_pars_vertex>\nvoid main(){\n vId = id;\n vec4 mvPosition = vec4(position, 1.0);\n' +
    (inst ? ' mvPosition = instanceMatrix * mvPosition;\n vId = vec4(float(gl_InstanceID % 256), float(gl_InstanceID / 256), 0.0, 0.0);\n' : '') +
    ' mvPosition = modelViewMatrix * mvPosition;\n gl_Position = projectionMatrix * mvPosition;\n#include <clipping_planes_vertex>\n}';
  // Fragments writes (itemId + 1) big-endian into the 4 bytes of 'id' (x = most significant): the low 3 bytes go out as rgb (itemId < 2^24)
  const fs = (kind, inst) => 'varying vec4 vId;\n#include <clipping_planes_pars_fragment>\nvoid main(){\n#include <clipping_planes_fragment>\n gl_FragColor = vec4(' + (inst ? 'vId.xyz' : 'vId.yzw') + ' / 255.0, ' + (kind / 255).toFixed(6) + ');\n}';
  const mk = (kind, inst, side) => new T.ShaderMaterial({ vertexShader: vs(inst), fragmentShader: fs(kind, inst), clipping: true, side, blending: T.NoBlending, transparent: false });
  const matFrag = [T.FrontSide, T.BackSide, T.DoubleSide].map((sd) => mk(KIND.frag, false, sd)), matProxy = mk(KIND.proxy, true, T.FrontSide);
  const matGeo = new T.ShaderMaterial({ vertexShader: '#include <clipping_planes_pars_vertex>\nvoid main(){ vec4 mvPosition = modelViewMatrix * vec4(position,1.0); gl_Position = projectionMatrix * mvPosition;\n#include <clipping_planes_vertex>\n}',
    fragmentShader: '#include <clipping_planes_pars_fragment>\nvoid main(){\n#include <clipping_planes_fragment>\n gl_FragColor = vec4(0.0, 0.0, 0.0, ' + (KIND.geo / 255).toFixed(6) + ');\n}', clipping: true, side: T.DoubleSide, blending: T.NoBlending });
  const itemToEl = new Map();       // Fragments itemId -> element index (via localId and GUID)
  async function resolveItems(itemIds) {
    const need = [...new Set(itemIds)].filter((x) => !itemToEl.has(x)); if (!need.length) return;
    const lids = await M.getLocalIdsFromItemIds(need); const guids = await M.getGuidsByLocalIds(lids);
    need.forEach((it, k) => itemToEl.set(it, guids[k] != null && byGuid.has(guids[k]) ? byGuid.get(guids[k]) : -3));
  }
  // One ID frame of what is on screen now. withGeo: geographic layers (terrain, imagery, photoreal, OSM) are drawn first as 'geo' so a
  // pixel where they are in front of the BIM is known. Returns codes per drawing-buffer pixel: -1 background, -4 geo, el index otherwise.
  async function frame({ withGeo = false } = {}) {
    const w = R.domElement.width, h = R.domElement.height;
    const rt = new T.WebGLRenderTarget(w, h, { depthBuffer: true });
    const saved = [], hide = [];
    // same face culling as the displayed material (Fragments shells are front-side unless the IFC style says both)
    const pickM = (m, x) => (Array.isArray(m) ? m[x.side] : m);
    const swap = (o, m) => { saved.push([o, o.material]); o.material = Array.isArray(o.material) ? o.material.map((x) => (x.visible ? pickM(m, x) : x)) : pickM(m, o.material); };
    A.scene.traverse((o) => {
      if (!o.isMesh && !o.isLine && !o.isPoints) return;
      let inModel = false; for (let p = o; p; p = p.parent) if (p === M.object) inModel = true;
      if (inModel) { if (o.geometry.attributes.id) swap(o, matFrag); else hide.push(o); }    // LOD wire boxes carry no id: left out
      else if (o === A.proxy) swap(o, matProxy);
      else if (withGeo && o.isMesh) swap(o, matGeo); else hide.push(o);
    });
    const vis = hide.map((o) => o.visible); hide.forEach((o) => (o.visible = false));
    const bg = A.scene.background; A.scene.background = null;
    const prevRT = R.getRenderTarget(), prevClear = R.getClearAlpha(), prevColor = R.getClearColor(new T.Color());
    R.setRenderTarget(rt); R.setClearColor(0x000000, 0); R.clear(); R.render(A.scene, A.camera);
    const px = new Uint8Array(w * h * 4); R.readRenderTargetPixels(rt, 0, 0, w, h, px);
    R.setRenderTarget(prevRT); R.setClearColor(prevColor, prevClear); A.scene.background = bg;
    saved.forEach(([o, m]) => (o.material = m)); hide.forEach((o, k) => (o.visible = vis[k])); rt.dispose();
    const codes = new Int32Array(w * h), items = new Set();
    for (let p = 0; p < w * h; p++) {
      const a = px[p * 4 + 3], v = px[p * 4] | (px[p * 4 + 1] << 8), big = ((px[p * 4] << 16) | (px[p * 4 + 1] << 8) | px[p * 4 + 2]) - 1;
      if (a === KIND.frag) { codes[p] = -100 - big; items.add(big); } else if (a === KIND.proxy) codes[p] = v < proxyEls.length ? proxyEls[v] : -3; else if (a === KIND.geo) codes[p] = -4; else codes[p] = -1;
    }
    await resolveItems([...items]);
    for (let p = 0; p < w * h; p++) if (codes[p] <= -100) codes[p] = itemToEl.get(-100 - codes[p]);
    const rect = R.domElement.getBoundingClientRect();
    return { w, h, codes, sx: w / rect.width, sy: h / rect.height, left: rect.left, top: rect.top };
  }
  // element visible pixel regions; candidate click points = pixels whose (2r+1)^2 neighbourhood is that element only, nearest the region's median
  function candidates(f, r = 3) {
    const per = new Map(), { w, h, codes } = f;
    const step = Math.max(1, Math.round(f.sx));
    for (let y = r * step; y < h - r * step; y += step) for (let x = r * step; x < w - r * step; x += step) {
      const c = codes[y * w + x]; if (c < 0) continue;
      let ok = true; for (let dy = -r; dy <= r && ok; dy++) for (let dx = -r; dx <= r; dx++) if (codes[(y + dy * step) * w + x + dx * step] !== c) { ok = false; break; }
      if (!ok) continue; let a = per.get(c); if (!a) per.set(c, (a = [])); a.push([x, y]);
    }
    const out = [];
    for (const [i, pts] of per) {
      const mx = pts.map((p) => p[0]).sort((a, b) => a - b)[pts.length >> 1], my = pts.map((p) => p[1]).sort((a, b) => a - b)[pts.length >> 1];
      let best = pts[0], bd = Infinity; for (const p of pts) { const d = (p[0] - mx) ** 2 + (p[1] - my) ** 2; if (d < bd) { bd = d; best = p; } }
      // CSS client coordinates of the pixel centre (canvas buffer y runs bottom-up in readPixels)
      out.push({ i, cat: els[i].cat, n: pts.length, cx: f.left + (best[0] + 0.5) / f.sx, cy: f.top + (h - 1 - best[1] + 0.5) / f.sy });
    }
    return out;
  }
  const codeAt = (f, cx, cy) => { const x = Math.floor((cx - f.left) * f.sx), y = f.h - 1 - Math.floor((cy - f.top) * f.sy); return x < 0 || y < 0 || x >= f.w || y >= f.h ? -1 : f.codes[y * f.w + x]; };
  // what is behind the front-most code at a point (BIM only): render again with the front element excluded is not needed: the
  // BIM-only frame is the policy truth (BIM always wins over geographic layers), so 'behind geo' = code in a frame without geo.
  let last = null;
  // displayed colour (mean of a (2r+1)^2 block) at a client point, from the on-screen canvas (preserveDrawingBuffer)
  function screenRGB(cx, cy, r = 2) {
    const gl = R.getContext(), rect = R.domElement.getBoundingClientRect(), sx = R.domElement.width / rect.width;
    const x = Math.floor((cx - rect.left) * sx), y = R.domElement.height - 1 - Math.floor((cy - rect.top) * sx), n = 2 * r + 1, px = new Uint8Array(n * n * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.readPixels(x - r, y - r, n, n, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const s = [0, 0, 0]; for (let k = 0; k < n * n; k++) for (let c = 0; c < 3; c++) s[c] += px[k * 4 + c];
    return s.map((v) => v / (n * n));
  }
  // self-checks of the truth itself: proxy instances sit on their element's exported box; identity round trip over the whole model
  async function selfCheck() {
    const L = new T.Matrix4().fromArray((await (await fetch('/revisions/' + rev + '/alignment.json')).json()).internalToLocalM);
    let proxyBad = 0; const m = new T.Matrix4(), c = new T.Vector3();
    proxyEls.forEach((i, k) => { A.proxy.getMatrixAt(k, m); const b = els[i].bb; c.set((b[0] + b[3]) / 2, (b[1] + b[4]) / 2, (b[2] + b[5]) / 2).applyMatrix4(L); if (c.distanceTo(new T.Vector3().setFromMatrixPosition(m)) > 0.01) proxyBad++; });
    const withIfc = els.map((e, i) => i).filter((i) => els[i].ifc);
    const lids = await M.getLocalIdsByGuids(withIfc.map((i) => els[i].ifc));
    const found = withIfc.map((i, k) => [i, lids[k]]).filter(([, l]) => l != null);
    const back = await M.getGuidsByLocalIds(found.map(([, l]) => l));
    const data = await M.getItemsData(found.map(([, l]) => l), { attributesDefault: true, relationsDefault: { attributes: false, relations: false } });
    let guidBad = 0, tagBad = 0; const seen = new Map(); let collisions = 0;
    found.forEach(([i, l], k) => { if (back[k] !== els[i].ifc) guidBad++; if (String(data[k]?.Tag?.value) !== String(els[i].id)) tagBad++; if (seen.has(l)) collisions++; seen.set(l, i); });
    const withGeo = new Set(await M.getItemsIdsWithGeometry());
    const geoNotMapped = [...withGeo].filter((l) => !seen.has(l)).length;
    return { proxies: proxyEls.length, proxyBad, ifcElements: withIfc.length, foundInFragments: found.length, guidRoundTripBad: guidBad, ifcTagNotElementId: tagBad, localIdCollisions: collisions,
      uniqueIds: new Set(els.map((e) => e.id)).size === els.length, uniqueUids: new Set(els.map((e) => e.uid)).size === els.length, uniqueGuids: new Set(els.map((e) => e.ifc).filter(Boolean)).size,
      geometryItems: withGeo.size, geometryItemsWithoutElement: geoNotMapped };
  }
  window.__pt = { rev, els, frame: async (o) => (last = await frame(o)), candidates: (o) => candidates(last, o), codeAt: (cx, cy, f) => codeAt(f || last, cx, cy), screenRGB, selfCheck,
    elementsIn: (f) => { const s = new Set(); for (const c of (f || last).codes) if (c >= 0) s.add(c); return [...s]; },
    pixelsOf: (i, f) => { let n = 0; for (const c of (f || last).codes) if (c === i) n++; return n; }, get last() { return last; } };
  return true;
})()`;
