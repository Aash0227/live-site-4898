// BIM render modes, materials, lighting and highlight for the Fragments model (see docs/BIM-RENDERING.md).
//  realistic   - the Revit materials exactly as the model carries them (IFC surface styles from the Revit export: colour, transparency;
//                roughness from the Revit material's Smoothness), physically based (MeshStandardMaterial), sun + sky + environment light,
//                neutral tone mapping. Elements whose ONLY materials are Revit's built-in placeholders (no material assigned in the model)
//                get a documented neutral fallback per category (FALLBACK): nothing is made up where the source has information.
//  engineering - one colour per BIM category group (ENGINEERING) with an on-screen legend, for inspection and coordination.
// Selection and hover colours are far from every category colour (CIE76 dE > 50, checked by scripts/test-rendering.mjs).
import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

// Revit category -> group. Groups that do not occur in a model simply have no elements (Vestibule has no framing / columns / roofs).
const GROUP_OF = {
  walls: ['Walls', 'Curtain Panels', 'Curtain Wall Mullions', 'Curtain Systems'],
  floors: ['Floors', 'Ceilings', 'Structural Area Reinforcement'],
  roofs: ['Roofs', 'Fascias', 'Gutters', 'Roof Soffits'],
  structure: ['Structural Framing', 'Structural Columns', 'Columns', 'Structural Foundations', 'Structural Connections', 'Structural Trusses', 'Structural Beam Systems', 'Structural Rebar'],
  doors: ['Doors'],
  windows: ['Windows'],
  stairs: ['Stairs', 'Runs', 'Landings', 'Supports', 'Railings', 'Top Rails', 'Handrails', 'Ramps'],
  mep: ['Plumbing Fixtures', 'Mechanical Equipment', 'Electrical Equipment', 'Electrical Fixtures', 'Lighting Fixtures', 'Lighting Devices', 'Sprinklers',
    'Air Terminals', 'Ducts', 'Duct Fittings', 'Duct Accessories', 'Flex Ducts', 'Pipes', 'Pipe Fittings', 'Pipe Accessories', 'Flex Pipes', 'Cable Trays',
    'Cable Tray Fittings', 'Conduits', 'Conduit Fittings', 'Communication Devices', 'Data Devices', 'Fire Alarm Devices', 'Security Devices', 'Nurse Call Devices'],
};
const CAT_GROUP = new Map(Object.entries(GROUP_OF).flatMap(([g, cats]) => cats.map((c) => [c, g])));
export const groupOf = (cat) => CAT_GROUP.get(cat) || 'other';

// ENGINEERING: muted, mutually distinct category colours (min pairwise dE76 ~ 30).
export const ENGINEERING = {
  walls: { label: 'Walls', color: '#d9cbb0' }, floors: { label: 'Floors / slabs', color: '#5b7fb0' }, roofs: { label: 'Roofs', color: '#c4473a' },
  structure: { label: 'Structural framing / columns', color: '#3f8a5c' }, doors: { label: 'Doors', color: '#8b5e3c' }, windows: { label: 'Windows', color: '#59c3e3' },
  stairs: { label: 'Stairs / railings', color: '#e0b83a' }, mep: { label: 'Fixtures / MEP', color: '#7a5fb5' }, other: { label: 'Other', color: '#7c7c7c' },
};
// REALISTIC fallback, used ONLY for elements whose every material is a Revit placeholder (see isPlaceholder). Neutral, unsaturated tones that
// read as "unspecified" rather than as a real finish; provenance: this file, not the model.
export const FALLBACK = {
  walls: '#d6d1c7', floors: '#b4b0a8', roofs: '#9a958d', structure: '#a9a9a4', doors: '#b9ad9c', windows: '#a9bccb', stairs: '#c3beb4', mep: '#d8d8d4', other: '#c8c8c8',
};
export const SELECT = '#ff1493', HOVER = '#7dff3a';
// Revit's built-in placeholder materials (assigned when nothing was chosen in the model) and category materials without a colour.
const PLACEHOLDER = /^(default( (wall|floor|roof|form|light source))?|<unnamed>|<by category>)$/i;
export const isPlaceholder = (m) => !m || m.FromCategory && !m.Color || PLACEHOLDER.test(m.Name || '');

// Revit materials of one element, from the site export (model.json: element.r = [[batch, start, count]], batch.mat -> materials[]).
export function materialsOf(el, site) { return [...new Set((el.r || []).map(([b]) => site.batches[b]?.mat))].filter((k) => k != null).map((k) => site.materials[k]); }

// Physically based materials: Fragments creates one MeshLambertMaterial per material definition; swap each for a MeshStandardMaterial
// with the same colour / opacity / sidedness. Roughness = 1 - Smoothness/100 of the Revit material with that colour (mean if several
// share it, 0.5 = Revit default if none). Metalness 0: the export carries none and it is not guessed from names.
export function installPBR(frags, revitMats) {
  const byHex = new Map();
  for (const m of revitMats) if (m.Color) { const k = m.Color.toLowerCase(); if (!byHex.has(k)) byHex.set(k, []); byHex.get(k).push(m); }
  const list = frags.models.materials.list;
  const swap = (key, m) => {
    if (!m || !m.isMeshLambertMaterial) return;
    const src = byHex.get('#' + m.color.getHexString()) || [];
    const smooth = src.length ? src.reduce((a, x) => a + (x.Smoothness ?? 50), 0) / src.length : 50;
    const s = new THREE.MeshStandardMaterial({ color: m.color.clone(), opacity: m.opacity, transparent: m.transparent, side: m.side, depthTest: m.depthTest,
      depthWrite: m.depthWrite, roughness: THREE.MathUtils.clamp(1 - smooth / 100, 0.1, 1), metalness: 0, userData: { ...m.userData, revit: src.map((x) => x.Name) } });
    list.set(key, s); m.dispose();
  };
  list.onItemSet.add(({ key, value }) => swap(key, value));
  for (const [k, v] of [...list]) swap(k, v);
}

// Lights, environment, tone mapping, shadows, optional ambient occlusion (GTAO). Shadows are limited to the model's surroundings.
export function createLighting({ renderer, scene, camera }) {
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.NeutralToneMapping; renderer.toneMappingExposure = 1;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  const pmrem = new THREE.PMREMGenerator(renderer), env = pmrem.fromScene(new RoomEnvironment(), 0.04).texture; pmrem.dispose();
  const hemi = new THREE.HemisphereLight(0xdfe9ff, 0x6b6250, 1.0), sun = new THREE.DirectionalLight(0xfff3df, 2.4);
  scene.add(hemi, sun, sun.target);
  // sun from the south-south-west, 50 deg up (a fixed, documented choice; not a solar ephemeris)
  const SUN_DIR = new THREE.Vector3(-0.35, 0.77, 0.53).normalize();
  Object.assign(sun.shadow, { bias: -0.0004, normalBias: 0.04, radius: 3 }); sun.shadow.mapSize.set(2048, 2048);
  let box = new THREE.Box3(new THREE.Vector3(-30, -10, -30), new THREE.Vector3(30, 30, 30));
  function fitSun() {
    const c = box.getCenter(new THREE.Vector3()), r = box.getSize(new THREE.Vector3()).length() / 2 + 12;
    sun.target.position.copy(c); sun.position.copy(c).addScaledVector(SUN_DIR, r * 2);
    Object.assign(sun.shadow.camera, { left: -r, right: r, top: r, bottom: -r, near: r * 0.5, far: r * 3.5 }); sun.shadow.camera.updateProjectionMatrix();
  }
  fitSun();
  const state = { mode: 'realistic', shadows: false, ao: false };
  let composer = null, aoPass = null;
  async function ensureComposer() {
    if (composer) return;
    const [{ EffectComposer }, { RenderPass }, { GTAOPass }, { OutputPass }] = await Promise.all([import('three/examples/jsm/postprocessing/EffectComposer.js'),
      import('three/examples/jsm/postprocessing/RenderPass.js'), import('three/examples/jsm/postprocessing/GTAOPass.js'), import('three/examples/jsm/postprocessing/OutputPass.js')]);
    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    const rt = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType, samples: 4 });
    composer = new EffectComposer(renderer, rt);
    composer.addPass(new RenderPass(scene, camera));
    aoPass = new GTAOPass(scene, camera, size.x, size.y); aoPass.blendIntensity = 0.85; aoPass.updateGtaoMaterial({ radius: 0.6, distanceExponent: 1.5, thickness: 1, scale: 1 });
    composer.addPass(aoPass); composer.addPass(new OutputPass());
  }
  function apply() {
    const real = state.mode === 'realistic';
    scene.environment = env; scene.environmentIntensity = real ? 0.55 : 0.35;
    hemi.intensity = real ? 0.75 : 1.1; sun.intensity = real ? 2.4 : 1.8;
    renderer.shadowMap.enabled = state.shadows; sun.castShadow = state.shadows;
    scene.traverse((o) => { if (o.material) [].concat(o.material).forEach((m) => (m.needsUpdate = true)); });   // shadow on/off recompiles
  }
  apply();
  return {
    state, sun,
    setSiteBox(b) { box = b.clone(); fitSun(); },
    async set(p) { Object.assign(state, p); if (state.ao) await ensureComposer(); apply(); },
    // shadow flags for meshes Fragments creates while streaming tiles
    flagShadows(root, receiveOnly = false) { root.traverse((o) => { if (o.isMesh && !o.userData.lsvShadow) { o.castShadow = !receiveOnly; o.receiveShadow = true; o.userData.lsvShadow = true; } }); },
    resize(w, h) { if (composer) { composer.setPixelRatio(renderer.getPixelRatio()); composer.setSize(w, h); } },
    render() { if (state.ao && composer) composer.render(); else renderer.render(scene, camera); },
  };
}

// Per-element styling on the Fragments model and the proxy instances: base (mode), hover, selection. All Fragments calls go through one
// queue so a fast sequence of clicks / hovers / mode switches is applied in order and never leaves a stale highlight behind.
export function createStyler({ model, frags, proxy, proxyEls, idOfEl, els, site }) {
  const proxyOfEl = new Map(proxyEls.map((i, k) => [i, k]));
  const unassigned = els.map((e) => { const ms = materialsOf(e, site); return ms.length === 0 || ms.every(isPlaceholder); });
  const proxySrc = new THREE.Color(site.materials.find((m) => m.Key === 'proxy-bbox')?.Color || '#5fa8e0');
  const SEL = { color: new THREE.Color(SELECT), renderedFaces: 1, opacity: 1, transparent: false };
  const HOV = { color: new THREE.Color(HOVER), renderedFaces: 1, opacity: 1, transparent: false };
  let mode = 'realistic', sel = -1, hov = -1, job = Promise.resolve();
  const queue = (fn) => (job = job.then(fn).catch((e) => console.error('styler', e)));
  // what an element should look like right now: 'sel' | 'hov' | a colour | null (= the model's own material)
  const want = (i) => (i === sel ? 'sel' : i === hov ? 'hov' : mode === 'engineering' ? ENGINEERING[groupOf(els[i].cat)].color : unassigned[i] ? FALLBACK[groupOf(els[i].cat)] : null);
  async function restyle(ids) {
    const groups = new Map(); let proxyDirty = false;
    for (const i of ids) {
      if (i < 0) continue;
      const w = want(i);
      if (proxyOfEl.has(i)) { proxy.setColorAt(proxyOfEl.get(i), w === 'sel' ? SEL.color : w === 'hov' ? HOV.color : mode === 'engineering' ? new THREE.Color(w) : proxySrc); proxyDirty = true; continue; }
      if (idOfEl[i] == null) continue;
      const k = w ?? 'src'; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(idOfEl[i]);
    }
    if (proxyDirty) proxy.instanceColor.needsUpdate = true;
    // setColor wins over highlight in Fragments, so an element keeps exactly one of: source material, a category colour, a highlight
    for (const [k, lids] of groups) {
      if (k === 'src') { await model.resetColor(lids); await model.resetHighlight(lids); }
      else if (k === 'sel' || k === 'hov') { await model.resetColor(lids); await model.highlight(lids, k === 'sel' ? SEL : HOV); }
      else { await model.resetHighlight(lids); await model.setColor(lids, new THREE.Color(k)); }
    }
    if (groups.size) await frags.update(true);
  }
  // proxies: white material, the colour lives in the instance colours (material colour x instance colour)
  proxy.material.color.set(0xffffff); for (let k = 0; k < proxyEls.length; k++) proxy.setColorAt(k, proxySrc); proxy.instanceColor.needsUpdate = true;
  return {
    get mode() { return mode; }, get selected() { return sel; }, get hovered() { return hov; }, unassigned, idle: () => job,
    setMode(m) { mode = m; proxy.material.opacity = m === 'engineering' ? 0.9 : 0.55; return queue(() => restyle(els.map((_, i) => i))); },      // engineering: proxies opaque enough to read their colour
    select(i) { const prev = sel; sel = i; return queue(() => restyle([prev, i])); },
    hover(i) { if (i === hov) return job; const prev = hov; hov = i; return queue(() => restyle([prev, i])); },
  };
}

// Edge lines of every element (one LineSegments, one draw call), hidden per element through a visibility texture so hide / isolate /
// filters apply to them as well. Built from Fragments geometry (model space) -> world by the model's placement.
export async function createEdges({ model, idOfEl, thresholdDeg = 28 }) {
  const items = idOfEl.map((l, i) => [i, l]).filter(([, l]) => l != null);
  const geo = await model.getItemsGeometry(items.map(([, l]) => l));
  const pos = [], el = [], v = new THREE.Vector3();
  geo.forEach((parts, k) => {
    for (const md of parts) {
      if (!md.positions || !md.indices) continue;
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(Float32Array.from(md.positions), 3)); g.setIndex(new THREE.BufferAttribute(md.indices, 1));
      const e = new THREE.EdgesGeometry(g, thresholdDeg), p = e.attributes.position;
      for (let j = 0; j < p.count; j++) { v.fromBufferAttribute(p, j).applyMatrix4(md.transform); pos.push(v.x, v.y, v.z); el.push(items[k][0]); }
      g.dispose(); e.dispose();
    }
  });
  const n = idOfEl.length, W = Math.min(4096, n), H = Math.ceil(n / W), visData = new Uint8Array(W * H).fill(255);
  const visTex = new THREE.DataTexture(visData, W, H, THREE.RedFormat, THREE.UnsignedByteType); visTex.needsUpdate = true;
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('el', new THREE.Float32BufferAttribute(el, 1));
  const mat = new THREE.ShaderMaterial({
    uniforms: { vis: { value: visTex }, W: { value: W }, H: { value: H }, color: { value: new THREE.Color(0x1d2026) }, opacity: { value: 0.35 } },
    vertexShader: `attribute float el; uniform sampler2D vis; uniform float W, H; varying float vOn;
      #include <clipping_planes_pars_vertex>
      void main() { vec2 uv = vec2((mod(el, W) + 0.5) / W, (floor(el / W) + 0.5) / H); vOn = texture2D(vis, uv).r;
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0); gl_Position = projectionMatrix * mvPosition; gl_Position.z -= 0.0004 * gl_Position.w;
        #include <clipping_planes_vertex>
      }`,
    fragmentShader: `uniform vec3 color; uniform float opacity; varying float vOn;
      #include <clipping_planes_pars_fragment>
      void main() { if (vOn < 0.5) discard;
        #include <clipping_planes_fragment>
        gl_FragColor = vec4(color, opacity); }`,
    transparent: true, depthWrite: false, clipping: true,
  });
  const lines = new THREE.LineSegments(g, mat); lines.matrixAutoUpdate = false; lines.matrix.copy(model.object.matrixWorld); lines.matrixWorldNeedsUpdate = true; lines.frustumCulled = false;
  lines.renderOrder = 2;
  return { lines, segments: pos.length / 6, setVisible(on) { for (let i = 0; i < n; i++) visData[i] = on[i] ? 255 : 0; visTex.needsUpdate = true; } };
}
