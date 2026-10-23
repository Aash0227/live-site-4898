# Visual demolition of the existing building (Vestibule)

**What is removed:** the existing one-storey commercial building ON the lot. Designation from the drawings: C-2.0 Demolition Plan
(permit set p.75: "ALL EXISTING BUILDINGS, STRUCTURES, AND ON-SITE IMPROVEMENTS ARE PROPOSED TO BE REMOVED", limits = the lot) and the
ALTA survey SU-3 (p.95, 2025): the building is already gone on site (BROKEN EDGE OF PAVEMENT outlines the cleared pad; current Esri
imagery shows bare soil). Google's mesh predates the demolition.
**What is kept:** the adjoining white-roof NEIGHBORING STRUCTURE (Lands of Baliweed LLC, APN 170-03-077, 0.2 ft clear, RF 110.8 / 97.3)
is outside the limits of demolition (SU-3), and every tree, road and other building.

**Footprint:** measured on the Google mesh (height above the survey terrain, top-down capture at 0.1 m; each face by a half-height crossing,
median of transects, faces +-0.15 m), 10 vertices, 739.3 m2; 94 % inside the surveyed lot as placed, 98.8 % after the registration shift;
IoU 0.75 with the SU-3 broken-edge pad. Evidence: `surveys/demolition/vestibule-evidence.json` (generator `surveys/demolition/vestibule.py`);
data: `surveys/demolition/vestibule-demolition.json` = the revision's `demolition.json`.

**Registration:** Google's mesh is offset from the survey frame by 2.49 m (median of 5 feature deltas: neighbour walls/ends, Esri pad;
sigma 0.57 / 0.32 m, rotation residual -0.43 deg). That offset is why the new building appeared to overlap the neighbour's roof.
Site > "Align Google mesh to the survey" shifts ONLY the Google mesh (default on; the survey frame and the Revit model never move).

**How:** `viewer/demolition.js` patches every Google tile material (`onBeforeCompile`, shared program): fragments inside the polygon(s)
and below the height cap (7.89 m, highest roof equipment + 0.5 m; tree crowns above are kept) are discarded. Exact for any polygon
(also non-convex, up to 8 polygons / 64 vertices), holds while tiles stream and refine. Clipping planes were rejected (convex only, one
hole per material); per-tile triangle culling would have to be redone on every refinement. The pad is filled with a neutral
cleared-ground colour (#9c8f7c, not imagery: the Esri photo inside the pad and the Google texture both show the old roof); the
neighbour's party wall, never photographed, is closed with a neutral wall whose height is measured on the neighbour's roof (4.37 m).
With a demolition file the survey terrain is hidden under the photoreal mesh (no lot-wide hole any more). No Revit element and no
Google data is changed.

**Test** `node scripts/test-demolition.mjs` (Chrome, real Google tiles, BIM hidden during the comparison): outside the projected
footprint prism (+4 px) 0 of ~630k pixels change in the top, oblique and street poses; inside, 92 % (top) / 58 % (oblique) of the
pixels change and the interior shows the cleared pad (99.5 % top view); stable while tiles refine (99.8 % over 33 samples).
Untested: phones; Firefox for this test.
