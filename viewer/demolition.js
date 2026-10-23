// Visual-only demolition of a designated existing building in the Google photoreal mesh (docs/DEMOLITION.md). Nothing in the Revit
// model or in Google's data changes: fragments of the photoreal mesh that fall inside the footprint polygon(s) AND below the height cap
// are discarded in the fragment shader (exact for any polygon, even non-convex; every tile material gets the same patch, so it holds while
// tiles stream and refine). The pad is filled with a neutral cleared-ground surface and the neighbour's never-photographed party wall
// with a neutral wall. Polygons are in the Google mesh frame (localEN_m, unshifted); `setShift` follows a horizontal shift of the mesh.
import * as THREE from 'three';

const MAXV = 64, MAXP = 8;
const DECL = `uniform float uDemoOn; uniform int uDemoN; uniform vec2 uDemoPts[${MAXV}]; uniform int uDemoStart[${MAXP}]; uniform int uDemoCount[${MAXP}];
uniform float uDemoCap[${MAXP}]; uniform vec2 uDemoShift; varying vec3 vDemoWorld;
bool demoInside(vec2 q, int s, int n) { bool c = false;
  for (int i = 0; i < ${MAXV}; i++) { if (i >= n) break; vec2 a = uDemoPts[s + i], b = uDemoPts[s + (i + 1 == n ? 0 : i + 1)];
    if (((a.y > q.y) != (b.y > q.y)) && (q.x < (b.x - a.x) * (q.y - a.y) / (b.y - a.y) + a.x)) c = !c; }
  return c; }
bool demoMasked() { if (uDemoOn < 0.5) return false; vec2 q = vDemoWorld.xz - uDemoShift;
  for (int p = 0; p < ${MAXP}; p++) { if (p >= uDemoN) break; if (vDemoWorld.y < uDemoCap[p] && demoInside(q, uDemoStart[p], uDemoCount[p])) return true; }
  return false; }
`;

export function createDemolition({ scene, data }) {
  const polys = (data?.polygons || []).filter((p) => p.localEN_m?.length >= 3).slice(0, MAXP);
  const pts = [], start = [], count = [], cap = [];
  for (const p of polys) { start.push(pts.length); count.push(p.localEN_m.length); cap.push(p.maxHeightM ?? 1e4); for (const [e, n] of p.localEN_m) pts.push(new THREE.Vector2(e, -n)); }
  if (pts.length > MAXV) throw new Error(`demolition: ${pts.length} vertices, the shader holds ${MAXV}`);
  const pad = (a, n, v) => { while (a.length < n) a.push(v); return a; };
  const U = {
    uDemoOn: { value: 1 }, uDemoN: { value: polys.length }, uDemoPts: { value: pad(pts.slice(), MAXV, new THREE.Vector2()) },
    uDemoStart: { value: pad(start, MAXP, 0) }, uDemoCount: { value: pad(count, MAXP, 0) }, uDemoCap: { value: pad(cap, MAXP, 0) }, uDemoShift: { value: new THREE.Vector2() },
  };

  // cleared pad, party wall(s) and footprint outline, all in the Google mesh frame (moved with the mesh by setShift)
  const group = new THREE.Group(), outline = new THREE.Group(); group.visible = false; outline.visible = false; scene.add(group, outline);
  const fillMat = new THREE.MeshLambertMaterial({ color: data?.fill?.color || '#9c8f7c', side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
  const wallMat = new THREE.MeshLambertMaterial({ color: data?.fill?.wallColor || '#b7b1a6', side: THREE.DoubleSide });
  const walls = [];
  for (const p of polys) {
    const shape = new THREE.Shape(p.localEN_m.map(([e, n]) => new THREE.Vector2(e, n)));
    const g = new THREE.ShapeGeometry(shape); g.rotateX(-Math.PI / 2);      // (E,N) plane -> (x, -z): rotateX(-90deg) maps y=N to z=-N
    const fill = new THREE.Mesh(g, fillMat); fill.position.y = 0.03; fill.receiveShadow = true; group.add(fill);
    const ring = p.localEN_m.map(([e, n]) => new THREE.Vector3(e, 0.15, -n));
    outline.add(new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(ring), new THREE.LineBasicMaterial({ color: 0xff6a00 })));
    if (p.partyWall) {
      const [ea, na] = p.partyWall.a, [eb, nb] = p.partyWall.b, len = Math.hypot(eb - ea, nb - na);
      const w = new THREE.Mesh(new THREE.PlaneGeometry(len, 1), wallMat);
      w.position.set((ea + eb) / 2, 1.5, -(na + nb) / 2); w.rotation.y = -Math.atan2(-(nb - na), eb - ea); w.scale.y = 3;      // 3 m until fitWalls measures it
      w.userData = { a: [ea, -na], b: [eb, -nb] }; walls.push(w); group.add(w);
    }
  }
  let on = true, shown = false;
  const sync = () => { U.uDemoOn.value = on ? 1 : 0; group.visible = shown && on; };

  return {
    count: polys.length, uniforms: U, group, outline, fillColor: data?.fill?.color || '#9c8f7c',
    // patch one photoreal tile material (idempotent; programs are shared through the cache key)
    patch(m) {
      if (!polys.length || m.userData.demoPatched) return;
      const prev = m.onBeforeCompile, prevKey = m.customProgramCacheKey?.bind(m);
      m.onBeforeCompile = (sh, r) => {
        prev?.call(m, sh, r); Object.assign(sh.uniforms, U);
        sh.vertexShader = 'varying vec3 vDemoWorld;\n' + sh.vertexShader.replace('#include <project_vertex>', '#include <project_vertex>\n  vDemoWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;');
        sh.fragmentShader = DECL + sh.fragmentShader.replace(/void\s+main\s*\(\s*\)\s*\{/, (s) => s + '\n  if (demoMasked()) discard;');
      };
      m.customProgramCacheKey = () => (prevKey ? prevKey() : '') + '|lsv-demolition-1';
      m.userData.demoPatched = true; m.needsUpdate = true;
    },
    setEnabled(v) { on = v; sync(); },
    setVisibleWithPhoto(v) { shown = v; sync(); },           // fill + walls only while the photoreal layer is on
    setOutline(v) { outline.visible = v; },
    setShift(x, z) { U.uDemoShift.value.set(x, z); group.position.set(x, 0, z); outline.position.set(x, 0, z); },
    // party wall height: the neighbour's roof just outside the shared edge, measured on the (unmasked) photoreal mesh
    fitWalls(photoRoot) {
      const ray = new THREE.Raycaster(), down = new THREE.Vector3(0, -1, 0), res = [];
      for (const w of walls) {
        const [ax, az] = w.userData.a, [bx, bz] = w.userData.b, nx = -(bz - az), nz = bx - ax, L = Math.hypot(nx, nz);
        const hs = [];
        for (const s of [-1, 1]) for (let k = 1; k <= 7; k++) {                       // both sides of the edge; the higher median is the neighbour
          const t = k / 8, x = ax + (bx - ax) * t + s * nx / L * 0.8 + group.position.x, z = az + (bz - az) * t + s * nz / L * 0.8 + group.position.z;
          ray.set(new THREE.Vector3(x, 400, z), down); const h = ray.intersectObject(photoRoot, true)[0]; if (h) hs.push({ s, y: h.point.y });
        }
        const med = (a) => { const v = a.map((h) => h.y).sort((p, q) => p - q); return v.length ? v[v.length >> 1] : null; };
        const top = Math.max(med(hs.filter((h) => h.s < 0)) ?? 0, med(hs.filter((h) => h.s > 0)) ?? 0);
        if (top > 1) { w.scale.y = top; w.position.y = top / 2; }
        res.push(+top.toFixed(2));
      }
      return res;
    },
    // is world point (x, z) inside a footprint (Google frame, current shift applied)?
    inside(x, z) {
      const qx = x - U.uDemoShift.value.x, qz = z - U.uDemoShift.value.y;
      return polys.some((p, k) => { let c = false; const s = start[k], n = count[k];
        for (let i = 0; i < n; i++) { const a = pts[s + i], b = pts[s + (i + 1) % n]; if ((a.y > qz) !== (b.y > qz) && qx < ((b.x - a.x) * (qz - a.y)) / (b.y - a.y) + a.x) c = !c; }
        return c; });
    },
  };
}
