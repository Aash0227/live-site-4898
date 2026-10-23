// Drawings tab: the permit-set intelligence of a revision (permit.json v1, written by 4898.PermitIntel through permit/extract.py).
// Everything shown carries its source sheet / page; nothing is inferred here. Callouts on sheets the QA/QC engine REGISTERED to the
// model (registrations[].status = placed, PDF pt -> Revit internal ft) can be shown as 3D markers at their level; others stay 2D-only.
import * as THREE from 'three';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const pct = (x) => (x == null ? '' : Math.round(x * 100) + '%');

export async function loadDrawings({ base, L, scene, el, tabButton }) {
  const permit = await fetch(base + 'permit.json').then((r) => (r.ok ? r.json() : null)).catch(() => null);
  if (!permit) { tabButton.style.display = 'none'; return null; }
  const meta = await fetch(base + 'permit/meta.json').then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const thumbs = new Set(meta?.thumbnails || []);
  const reg = new Map(permit.registrations.filter((r) => r.status === 'placed' && r.pdfToModelFt).map((r) => [r.page, r]));
  const count = (k) => permit[k]?.length ?? 0;
  const byKind = permit.callouts.reduce((m, c) => m.set(c.kind, (m.get(c.kind) || 0) + 1), new Map());

  // 3D markers: callout targets on registered sheets -> Revit internal ft (X, Y, level elevation) -> viewer frame
  const markers = new THREE.Group(); markers.visible = false; scene.add(markers);
  const COLORS = { hold_down: 0xff3b30, column: 0x34c759, shear_wall: 0x0a84ff, beam: 0xffcc00 };
  const geo = new THREE.SphereGeometry(0.18, 12, 8);
  let placed = 0;
  for (const c of permit.callouts) {
    const r = reg.get(c.source?.page); if (!r || r.levelElevationFt == null) continue;
    const [[a, b, tx], [cc, d, ty]] = r.pdfToModelFt;
    for (const t of c.targets) {
      const X = a * t.x + b * t.y + tx, Y = cc * t.x + d * t.y + ty;
      const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: COLORS[c.kind] ?? 0xffffff, depthTest: false }));
      m.position.set(X, Y, r.levelElevationFt + 0.5).applyMatrix4(L); m.renderOrder = 5; m.userData = { callout: c.id }; markers.add(m); placed++;
    }
  }

  const sheetRows = permit.pages.map((p) => `<tr><td>${p.page}</td><td>${esc(p.sheet?.value || '—')}</td><td>${esc(p.title?.value || p.planTitle || '')}</td><td>${esc(p.discipline || '')}</td><td>${esc((p.scaleText || [])[0] || '')}</td>
    <td>${thumbs.has(p.page) ? `<a href="${base}permit/thumbs/p${p.page}.jpg" target="_blank" rel="noopener">view</a>` : ''}</td></tr>`).join('');
  const schedRows = permit.schedules.map((s) => `<details><summary>${esc(s.title || s.kind)} <span class="muted">· ${esc(s.source?.sheet || '')} p.${s.source?.page ?? '?'} · ${s.rows.length} rows · ${pct(s.confidence)}</span></summary>
    <table><tr>${s.header.map((h) => `<th>${esc(h)}</th>`).join('')}</tr>${s.rows.slice(0, 60).map((r) => `<tr><td colspan="${Math.max(1, s.header.length)}">${esc(r.rowText)}</td></tr>`).join('')}</table></details>`).join('');
  const regRows = permit.registrations.map((r) => `<tr><td>${esc(r.sheet)}</td><td>${r.page}</td><td>${esc(r.status)}</td><td>${esc(r.level || '')}</td><td>${pct(r.matchedShare)}</td><td>${r.medianResidualIn != null ? r.medianResidualIn.toFixed(2) + '"' : esc(r.reason || '')}</td></tr>`).join('');
  el.innerHTML = `<div class="small">${esc(permit.source.fileName)} · ${permit.source.pageCount} pages · SHA-256 ${esc(permit.source.sha256.slice(0, 12))}… · ${esc(permit.tool?.name || '')} ${esc(permit.tool?.version || '')}${permit.run ? ` · ${permit.run.totalSeconds} s` : ''}</div>
    <div class="kv">${[['Sheets', permit.pages.filter((p) => p.sheet?.value).length], ['Levels', count('levels')], ['Grids', count('grids')], ['Dimensions', count('dimensions')], ['Schedules', count('schedules')],
      ['Callouts', [...byKind].map(([k, n]) => `${k} ${n}`).join(', ') || 0], ['Registered sheets', `${reg.size} of ${permit.registrations.length}`]].map(([k, v]) => `<div class="k">${k}</div><div class="v">${esc(v)}</div>`).join('')}</div>
    <label class="row"><input type="checkbox" id="optCallouts" ${placed ? '' : 'disabled'}> Drawing callouts in 3D (${placed} on registered sheets)</label>
    <div class="grp"><div class="grp-h"><span>Sheets</span></div><table class="tbl"><tr><th>p.</th><th>Sheet</th><th>Title</th><th>Disc.</th><th>Scale</th><th></th></tr>${sheetRows}</table></div>
    <div class="grp"><div class="grp-h"><span>Schedules</span></div>${schedRows || '<div class="muted small">none read</div>'}</div>
    <div class="grp"><div class="grp-h"><span>Sheet registration to the model</span></div><table class="tbl"><tr><th>Sheet</th><th>p.</th><th>Status</th><th>Level</th><th>Lines</th><th>Residual</th></tr>${regRows}</table></div>
    ${permit.unknowns?.length ? `<div class="grp"><div class="grp-h"><span>Not known</span></div><ul class="small">${permit.unknowns.map((u) => `<li>${esc(u)}</li>`).join('')}</ul></div>` : ''}
    <div class="muted small">PDF coordinates are drawing coordinates, not geographic. Source: permit.json (4898.PermitIntel over the QA/QC engine).</div>`;
  el.querySelector('#optCallouts')?.addEventListener('change', (e) => { markers.visible = e.target.checked; });
  return { permit, markers, placed };
}
