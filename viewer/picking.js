// Picking: a pointer position -> one exported Revit element (index into model.json elements), or -1.
// Policy: BIM always wins. Only the Fragments model and the door/window proxies are candidates; geographic layers (terrain, imagery,
// Google photoreal, OSM boxes) are never ray-cast, so they can neither intercept nor be selected. Elements that are hidden (filter,
// hide, isolate) or cut away by the section plane are skipped, so a click lands on what is actually drawn there.
import * as THREE from 'three';

// Coplanar duplicates (e.g. a whole-level slab under room floors at the same top elevation) are a real tie: the GPU z-fights them. Among
// hits within TIE metres of the nearest one the SMALLEST element wins, so a click on a room floor selects the room floor, not the slab.
const TIE = 0.005;
export function createPicker({ canvas, camera, model, proxy, proxyEls, elOfLocal, isOn, proxyShown, clipPlanes, sizeOf = () => 0 }) {
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
  const kept = (p) => clipPlanes().every((pl) => pl.distanceToPoint(p) >= 0);      // three.js clips where the signed distance is < 0

  // Fragments hits along the ray, nearest first, that are drawn: mapped to an element, visible, not clipped. raycastAll + our own
  // ordering instead of raycast(): raycast() returns one hit chosen with a snapping score and knows nothing about our section plane.
  async function fragHit(cx, cy) {
    // RaycastManager.screenToCast() subtracts the canvas rect itself, so `mouse` must be in CLIENT coordinates (not canvas-relative).
    const hits = (await model.raycastAll({ camera, mouse: new THREE.Vector2(cx, cy), dom: canvas })) || [];
    const cand = [];
    for (const h of hits) {
      if (h.rayDistance > 1e-3) continue;                                    // edge / point snaps near the ray, not surface hits
      const i = elOfLocal.get(h.localId);
      if (i == null || !isOn(i) || !kept(h.point)) continue;
      cand.push({ i, d: h.point.distanceTo(camera.position), point: h.point });
    }
    if (!cand.length) return null;
    const dMin = Math.min(...cand.map((c) => c.d));
    return cand.filter((c) => c.d <= dMin + TIE).sort((a, b) => sizeOf(a.i) - sizeOf(b.i) || a.d - b.d)[0];
  }
  function proxyHit() {
    if (!proxyShown()) return null;
    for (const h of ray.intersectObject(proxy)) {
      const i = proxyEls[h.instanceId];
      if (i != null && isOn(i) && kept(h.point)) return { i, d: h.distance, point: h.point };
    }
    return null;
  }
  async function pick(cx, cy) {
    const r = canvas.getBoundingClientRect();
    if (cx < r.left || cy < r.top || cx >= r.right || cy >= r.bottom) return null;
    camera.updateMatrixWorld();
    ndc.set(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const p = proxyHit();                      // before the await: hover and click picks may interleave on the shared raycaster
    const f = await fragHit(cx, cy);
    return !f ? p : !p ? f : p.d < f.d ? p : f;
  }
  return { pick, pickAt: async (cx, cy) => (await pick(cx, cy))?.i ?? -1 };
}
