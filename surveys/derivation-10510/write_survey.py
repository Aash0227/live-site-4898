import json, math, os
HERE = os.path.dirname(os.path.abspath(__file__))
g = json.load(open(os.path.join(HERE, 'geo_out.json')))
t = json.load(open(os.path.join(HERE, 'tie.json')))
sv = {
 "project": "Sarkar Residence, 10510 Madera Dr, Cupertino, CA 95014 (APN 326-35-053, Tract 1960)",
 "pdf": "C:/4898_project/site-viewer/10510 MADERA DR, SARKAR RESIDENCE_CITY APPROVED SET_05 FEB 2026.pdf",
 "sources": [
  {"id": "A-1.001", "pdfPages": [4], "what": "site layout 1\"=10' (raster site plan): setbacks 9'-8\" right / 11'-5 3/8\" side / 20'-7 3/8\" front (level 1), lot sides 223'-7 1/8\" and 100'-0\", site benchmark, basis of bearings, site data (APN 326-35-053, AREA = 10,454 S.F.)"},
  {"id": "A-1.002", "pdfPages": [5], "what": "area plan 1\"=30': lot lines N46°10'43\"W 223.60' and S43°49'17\"W 100.00', neighbouring lots on Madera Drive"},
  {"id": "A-1.003", "pdfPages": [6], "what": "demolition plan 1\"=10' (vector): property line, existing main house (2,027 sq ft, to be demolished) and pool, spot grades 307.8-309.7, benchmark mag nail 308.74', LOT GROSS AREA 10,376± SF, street curve L=149.71' R=178.00' Δ=48°11'23\""},
  {"id": "C1", "pdfPages": [99], "what": "Osuna Engineering horizontal control and grading plan 1\"=10' (vector): property line S46°10'43\"E 223.03', side S43°49'.. W 100.00', lot front arc L=103.43' R=178.00' Δ=33°17'31\", street curve L=149.14' Δ=48°00'27\", FF 310.73 (first floor), GFF 309.23 (garage), basis of bearings N88°59'01\"E 422.03 M-M calc. per R1, north arrow"},
  {"id": "S-202, S-205", "pdfPages": [6, 9], "pdf": "C:/4898_project/QA-QC automation/inputs/STAMPED_10510 Madera Dr-DWG-20260526.pdf", "what": "structural floor plans with north arrow; the QA/QC registration of these sheets to the Revit model (validation/MADERA/phase3/correspondences.json, confirmed hold downs) gives the model axes"},
  {"id": "model-facts", "what": "4898 fragexport-lite run 20261022_161118 on the staging copy of MADERA_V2_detached_COPY.rvt: project base point and survey point at the internal origin, angle to true north 0, Site Location 'Boston, MA' (Revit default): the model is not georeferenced"}
 ],
 "lotBearing": {
  "text": "N46°10'43\"W",
  "azimuthDeg": 313.821389,
  "where": "rear lot line (Southern Pacific Company side) N46°10'43\"W 223.60' (A-1.002, A-1.003) / S46°10'43\"E 223.03' (C1); its perpendicular S43°49'17\"W 100.00' is the right side line"
 },
 "modelXAzimuthDeg": 133.821389,
 "modelAxes": {
  "+x": "S46°10'43\"E, along the rear lot line toward the 100 ft right side (sheet right on C1, A-1.001, A-1.003 and the structural plans)",
  "+y": "N43°49'17\"E, toward the rear lot line / railway (sheet up)",
  "basis": "QA/QC registration of the structural sheets to the model (S-205: 8 confirmed hold downs, rotation 0.11 deg, 0.05563 ft/pt = 1/4\"=1'-0\", rms 0.27 ft; S-202: 14, rotation 0.7 deg, rms 2.3 ft): model +x = sheet right, +y = sheet up. The structural (S-202, S-205) and civil (C1) north arrows both point 315.0 deg from sheet-up and both sheets draw the building the same way round (garage on the left; the model's garage slab is at low x). The model's own true-north angle is 0 (not set)."
 },
 "firstFloor": {"level": "Level 1", "ffeFt": 310.73, "datum": "NAVD88 (project benchmark, see benchmarks)", "sheet": "C1", "source": "C1 'FF 310.73' (three labels on the first floor)"},
 "garageSlab": {"level": "GRADE LEVEL", "elevationFt": 309.23, "datum": "NAVD88 (project benchmark)", "source": "C1 'GFF 309.23' (garage finish floor); the model's GRADE LEVEL is 1.5 ft below Level 1, exactly FF - GFF"},
 "benchmarks": [
  {"name": "Project benchmark: assumed benchmark, mag nail on the street near the southerly lot corner (A-1.001, A-1.003, C1)", "elevationFt": 308.74, "datum": "NAVD88 (as stated on the sheets, but described as 'assumed')"}
 ],
 "lotSpotGradeRangeFt": [307.8, 309.7],
 "lotSpotGradeDatum": "NAVD88 (project benchmark)",
 "lotSpotGradeSource": "A-1.003 existing spot grades on the lot (street top of curb / flow line 306.86-308.92 excluded)",
 "modelTie": {
  "modelFt": g["modelTie"]["modelFt"],
  "lat": round(g["modelTie"]["lat"], 9), "lon": round(g["modelTie"]["lon"], 9),
  "what": "centre of the Revit stem-wall rectangle (24 'Stem wall-8\"' walls, 58.68 x 57.47 ft = the plan's 58'-8\" x 57'-5 1/2\")",
  "how": "(1) model stem walls centred on the C1 first-floor walls (58.78 x 57.44 ft digitised): the lot's NE corner (rear line / right side) is at model (85.554, 73.436) ft; right setback 9.58 ft (plan 9'-8\"), rear 11.26 ft (plan 11'-5 3/8\"); (2) the A-1.003 lot outline matches C1's (front curve median 0.38 ft, NE corners aligned); (3) the A-1.003 existing house (146 hatch end points) fitted to the OpenStreetMap building way 377407262 '10510 Madera Drive' with the survey bearing held: rms %.2f m" % (t["fixedRmsFt"] * 0.3048),
  "accuracyM": 3,
  "checks": {"esriPointAddressM": 2.25, "nominatimM": 4.09, "censusInterpolatedM": 28.1,
             "osmFitRmsM": round(t["fixedRmsFt"] * 0.3048, 2), "osmFitFreeRotationOffDeg": round(math.degrees(t["free"][0]) + 43.821389, 2)}
 },
 "lot": {
  "cornersLatLon": g["lotCornersLatLon"],
  "polygonModelFt": g["lotPolygonModelFt"],
  "areaSqFt": round(g["areaSqFt"], 1),
  "source": "A-1.003 property line digitised from the vector PDF (115 points, simplified to 30 within 0.1 ft), placed by the model tie; rear 223.86 ft and side 100.02 ft as drawn"
 },
 "discrepancies": [
  "Rear lot line: 223.60 ft (A-1.002 / A-1.003, A-1.001 223'-7 1/8\") vs 223.03 ft (civil C1); A-1.003 draws 223.86 ft.",
  "Lot area: 10,454 sq ft (site data on A-1.001 / A-1.003) vs 10,376± sq ft (A-1.003 'LOT GROSS AREA'); the digitised A-1.003 outline is 10,443 sq ft.",
  "Basis of bearings: the architectural sheets cite S16°21'30\"E on the monument line of Madera Drive (Tract 1960, Book 91 of Maps p. 50); civil C1 cites N88°59'01\"E 422.03 ft M-M calc. per R1. Different monument lines; that they give the same frame is not shown.",
  "North arrows on C1 and S-202 are drawn exactly 45 deg from sheet-up; the lot lines as plotted with their bearings put north 43.82 deg from sheet-up (1.18 deg apart). The bearings are used.",
  "Street curve data: C1 L=149.14' Δ=48°00'27\" vs A-1.003 L=149.71' Δ=48°11'23\" (both R=178.00').",
  "The OpenStreetMap outline of the existing house, fitted with free rotation, turns %.1f deg away from the survey bearing (rms %.2f m free vs %.2f m held): the OSM outline or the drawn existing house is off in orientation; the bearing is held." % (math.degrees(t["free"][0]) + 43.821389, t["freeRmsFt"] * 0.3048, t["fixedRmsFt"] * 0.3048)
 ],
 "notVerified": [
  "Horizontal position: tied through the existing house to an OpenStreetMap building outline (imagery / county import, accuracy unknown), not to a monument or lot-corner coordinates. Expected error a few metres (stated 3 m).",
  "The record bearing frame (Tract 1960 / R1) against true north: not read; typically within about 1 deg.",
  "Datum: the project benchmark is an 'assumed' mag nail labelled NAVD88; USGS 3DEP gives 309.61 ft at the building centre against nearby spot grades of 308.3-309.5 ft: consistent within about 0.5 ft, but not a published mark.",
  "FF 310.73 is read from C1 only (no architectural sheet states the first-floor elevation above datum).",
  "Model axes rest on the structural-sheet registration and the matching north arrows; the Revit model has no true north, no shared coordinates and the default Site Location (Boston)."
 ],
 "derivation": "surveys/derivation-10510/ (PyMuPDF + numpy scripts run against the PDFs above and the fragexport-lite site export)"
}
json.dump(sv, open(r'C:\4898_project\svw\madera\surveys\10510-madera-dr.json', 'w', encoding='utf-8'), indent=2, ensure_ascii=False)
print('written', len(sv['lot']['cornersLatLon']), 'lot corners')
