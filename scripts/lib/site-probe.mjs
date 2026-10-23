// Browser-side probe for site analysis and demolition tests. `installProbe(page)` defines window.__probe in the viewer page:
//   enablePhoto()        switch the photoreal layer on (UI checkbox) and wait for the vertical calibration
//   settle(opts)         wait until both tile sets have nothing downloading/parsing for `quiet` consecutive checks
//   look(eye, target)    move the viewer camera
//   ortho(opts)          top-down orthographic capture of a set of layers: 'height' (Float32 world y, NaN = nothing) or 'color'
//                        (RGBA8, linear: the render target gets no output colour-space conversion). Returns base64.
//   stats()              tile and draw statistics of the last frame
// Nothing here changes tile data: captures render the already-loaded meshes into an offscreen target.
export const PROBE_JS = String.raw`(() => {
  if (window.__probe) return 'already';
  const A = window.__app, T = A.THREE, sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const b64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); };
  const busy = (t) => t ? t.stats.downloading + t.stats.parsing + (t.stats.queued || 0) : 0;
  const P = {
    async enablePhoto(timeout = 90000) {
      const cb = document.querySelector('#optPhoto');
      if (!cb.checked) { cb.checked = true; cb.dispatchEvent(new Event('change')); }
      const t0 = performance.now();
      while (!A.photo.calibration && performance.now() - t0 < timeout) await sleep(500);
      return { calibration: A.photo.calibration, ms: Math.round(performance.now() - t0) };
    },
    async settle({ quiet = 4, timeout = 90000, every = 500 } = {}) {
      const t0 = performance.now(); let q = 0;
      while (performance.now() - t0 < timeout) {
        await sleep(every);
        q = busy(A.tiles) + busy(A.photo.tiles) === 0 ? q + 1 : 0;
        if (q >= quiet) break;
      }
      return { ms: Math.round(performance.now() - t0), settled: q >= quiet, photo: A.photo.tiles ? { ...A.photo.tiles.stats } : null };
    },
    look(eye, target) { A.camera.position.set(...eye); A.controls.target.set(...target); A.controls.update(); A.camera.updateMatrixWorld(); },
    layers() {
      const L = { photo: A.photo.root, terrain: A.tiles.group, model: A.model.object, proxy: A.proxy };
      for (const k of ['demolitionFill', 'demolitionOutline', 'lot']) if (A[k]) L[k] = A[k];
      return L;
    },
    ortho({ layers = ['photo'], kind = 'height', cx = 0, cz = 0, half = 64, px = 1280 } = {}) {
      const { renderer, scene } = A, L = P.layers();
      const cam = new T.OrthographicCamera(-half, half, half, -half, 1, 4000);
      cam.position.set(cx, 1500, cz); cam.up.set(0, 0, -1); cam.lookAt(cx, 0, cz); cam.updateMatrixWorld(); cam.updateProjectionMatrix();
      const keep = new Set(layers.map((k) => L[k]).filter(Boolean));
      const vis = scene.children.map((c) => [c, c.visible]);
      scene.children.forEach((c) => { c.visible = keep.has(c) ? (c === A.photo.root ? true : c.visible) : false; });
      const height = kind === 'height';
      const rt = new T.WebGLRenderTarget(px, px, { type: height ? T.FloatType : T.UnsignedByteType, format: T.RGBAFormat, depthBuffer: true });
      const bg = scene.background, ov = scene.overrideMaterial, cc = renderer.getClearColor(new T.Color()), ca = renderer.getClearAlpha();
      scene.background = null; renderer.setClearColor(0x000000, 0);
      if (height) scene.overrideMaterial = new T.ShaderMaterial({ side: T.DoubleSide,
        vertexShader: 'varying float vy; void main(){ vec4 w = modelMatrix * vec4(position, 1.0); vy = w.y; gl_Position = projectionMatrix * viewMatrix * w; }',
        fragmentShader: 'varying float vy; void main(){ gl_FragColor = vec4(vy, 1.0, 0.0, 1.0); }' });
      renderer.setRenderTarget(rt); renderer.clear(); renderer.render(scene, cam); renderer.setRenderTarget(null);
      let out;
      if (height) {
        const f = new Float32Array(px * px * 4); renderer.readRenderTargetPixels(rt, 0, 0, px, px, f);
        const h = new Float32Array(px * px);
        for (let r = 0; r < px; r++) for (let c = 0; c < px; c++) { const s = ((px - 1 - r) * px + c) * 4; h[r * px + c] = f[s + 1] > 0.5 ? f[s] : NaN; }
        out = b64(new Uint8Array(h.buffer));
      } else {
        const u = new Uint8Array(px * px * 4); renderer.readRenderTargetPixels(rt, 0, 0, px, px, u);
        const o = new Uint8Array(px * px * 4);
        for (let r = 0; r < px; r++) o.set(u.subarray((px - 1 - r) * px * 4, (px - r) * px * 4), r * px * 4);
        out = b64(o);
      }
      rt.dispose(); if (scene.overrideMaterial && scene.overrideMaterial !== ov) scene.overrideMaterial.dispose();
      scene.overrideMaterial = ov; scene.background = bg; renderer.setClearColor(cc, ca);
      vis.forEach(([c, v]) => { c.visible = v; });
      return { kind, cx, cz, half, px, mPerPx: (2 * half) / px, data: out };
    },
    stats() { const r = A.renderer.info.render; return { calls: r.calls, triangles: r.triangles, photo: A.photo.tiles ? { ...A.photo.tiles.stats } : null }; },
  };
  window.__probe = P; return 'installed';
})()`;

export async function installProbe(page) { return page.evaluate(PROBE_JS); }
