# BIM picking, highlight and render modes

## Picking (`viewer/picking.js`)
- **Root cause of the "clicks don't select" bug:** `FragmentsModel.raycast({mouse})` expects CLIENT coordinates (it subtracts the canvas
  rect itself). The old code passed canvas-relative coordinates, so every Fragments ray was cast ~300 px left of the pointer (the left
  panel's width). Only the door/window proxies (picked with a separate Three raycast) worked. Baseline with real clicks: 22 % correct,
  0 % for walls, floors, stairs and fixtures (`reports/picking-baseline-chrome.json`).
- Now: `raycastAll` with client coordinates, surface hits only, skipping hidden / filtered / isolated elements and anything cut by the
  section plane; door/window proxies compete by distance. Geographic layers (terrain, imagery, Google photoreal, OSM) are never ray-cast:
  **BIM always wins** and tiles can never intercept a pick.
- **Coplanar duplicates:** the Vestibule model has whole-level slabs (e.g. element 943, 12,005 sq ft) at exactly the same top elevation as
  room floors (175 sq ft). That is a model issue (they z-fight on screen). Among hits within 5 mm of the nearest, the smallest element wins.
- Click = one primary pointer pressed and released within 5 px (mouse) / 8 (pen) / 12 (touch); a drag is a camera move, never a pick.

## Highlight and modes (`viewer/materials.js`)
- Selection `#ff1493`, hover `#7dff3a`, both CIE76 dE > 50 from every category colour. An element shows exactly one of: its source
  material, a category colour, a highlight (Fragments' `setColor` wins over `highlight`, so they are made mutually exclusive).
- **Realistic:** the materials the Revit export carries (IFC surface styles: colour, transparency, smoothness -> roughness), physically
  based, sun + sky + environment light, sun shadows limited to the site box, optional contact shading (AO), edges.
  Vestibule's real materials ARE mostly grey (`Mgo board` #787878 on 443 element parts) and are shown as such. Only elements whose every
  material is a Revit placeholder (`Default Wall`, `Default Floor`, `<By Category>` ...) get the neutral fallback `FALLBACK` in
  `materials.js` (provenance: this file, not the model). No finish is invented.
- **Engineering:** one colour per category group (`ENGINEERING`): walls, floors/slabs, roofs, structural framing/columns, doors, windows,
  stairs/railings, fixtures/MEP, other; legend in Site > Display. Proxies are drawn more opaque in this mode.
- Mode, edges, shadows and AO are remembered per browser (`localStorage` key `lsv.render`).

## Tests (real input events, puppeteer, AMD iGPU)
| Test | Result (2026-10-22) |
|---|---|
| `node scripts/test-picking.mjs --browser chrome` | main 143/144 = 99.3 % correct, properties panel 100 %, highlight 99.3 %; isolate, filter, section, BIM-over-tiles pass; hide 8/10 and camera 0/6 fail: all failing cases involve the whole-level slabs above |
| `node scripts/test-picking.mjs --browser firefox --quick` | main 38/39 = 97.4 %, panel 100 %, highlight 100 %; hide, isolate, filter, section pass; camera, tiles fail (same slabs, small sample) |
| `node scripts/test-rendering.mjs` (Chrome) | all checks pass: palette distinctness, persistence, on-screen category coding, hover; fps realistic default 111, engineering 105, +AO 38 (AO off by default) |
| direct probe (bt.mjs) | highlight on screen in both modes: 1,004 px (realistic) / 877 px (engineering) change on select; persists after a camera move |

Known limits: the camera-move scenario's pixel check is unreliable on the coplanar slabs (they z-fight), so it still reports 0/6 although
the direct probe shows the highlight survives camera movement. Not tested on a phone.
