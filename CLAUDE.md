# Live-Site Viewer 4898 - setup instructions for Claude Code

You are setting up the **4898 Revit 2023 add-in (Live Site panel)** and the **Live-Site web viewer** on a company member's Windows
laptop. When the user says "set this up", "install", or similar, do exactly this, verifying each step before the next.

## Setup (run from this repo's folder)
1. Check prerequisites and report what is missing (do not install system software without asking the user):
   Revit 2023 (`C:\Program Files\Autodesk\Revit 2023\Revit.exe`), Node.js 20+ (`node --version`), Python 3.11+ (`python --version`),
   GitHub CLI logged in (`gh auth status`). Revit must be CLOSED for the add-in install.
2. Ask the user for their Cesium ion access token (optional; enables the Google photorealistic 3D layer). Never print it, never
   commit it, never put it in a URL. Free tokens: https://ion.cesium.com -> Access Tokens (scope assets:read); add "Google
   Photorealistic 3D Tiles" (asset 2275207) to My Assets. The Community plan is NON-COMMERCIAL.
3. Run: `powershell -NoProfile -ExecutionPolicy Bypass -File setup.ps1 -CesiumToken <token>` (omit `-CesiumToken` if none).
   It installs numpy/pillow/pymupdf, downloads + installs the add-in from this repo's GitHub release (one-file installer,
   per user, no admin), runs `npm ci` + `npm run build`, writes `%LOCALAPPDATA%\4898\LiveSite\settings.json` pointing the add-in at
   this repo, starts `python serve.py --port 8780` and opens http://127.0.0.1:8780/viewer/?project=vestibule.
4. Verify: the page loads (top bar shows "Aron Terrace Apartment (Vestibule)" and a published revision); with a token the Site tab's
   "Photorealistic 3D" is ticked and Google tiles appear; `?debug=1` shows which GPU WebGL uses.
5. Tell the user: start Revit 2023; on first start Revit may ask about the 4898 add-in publisher - THE USER answers that prompt
   ("Always Load"); never click security prompts yourself.

## Daily use
- Viewer: `python serve.py --port 8780` in this folder (the add-in starts it too), then http://127.0.0.1:8780/viewer/?project=vestibule
- Revit: open the 4898 model (`Vestibule update.rvt`), save it, ribbon **4898 -> Live Site -> Publish to Viewer**. The add-in exports
  (from a copy, or read-only with the IFC step rolled back for workshared models), runs `python publish.py --project vestibule
  build ...`, publishes only a validated build (a failed build goes to `data/revisions/_failed`, the published one stays), opens the
  browser. **Open Viewer** opens the page; **Permit Set** attaches permit-set intelligence (needs the permit-intel CLI, see docs).
- Faster GPU: Windows Settings > System > Display > Graphics > add `chrome.exe` > High performance (the user does this; see docs/GPU.md).

## Rules
- Do not modify Revit models or PDFs; do not commit `.env.local`, `.rvt`, `.pdf`; do not change Windows/graphics settings yourself.
- Viewer code: `viewer/` (app.js, picking.js, materials.js, photoreal.js, demolition.js, drawings.js), pipeline `publish.py`,
  server `serve.py`, tests `scripts/test-*.mjs` (puppeteer-core with the installed Chrome/Firefox: `node scripts/test-picking.mjs`).
- Docs: `docs/BIM-RENDERING.md`, `docs/TILES-LOADING.md`, `docs/GPU.md`, `docs/DEMOLITION.md`, `docs/PROJECTS.md`.

## Troubleshooting
- Blank viewer / "dist/ is missing": `npm run build`. Port busy: `python serve.py --port 8790` and change `port` in settings.json.
- "Cesium ion rejected the token (401)": wrong/revoked token or asset 2275207 not in My Assets; fix `.env.local`, `npm run build`.
- Publish fails with an Overpass 502: a public OpenStreetMap mirror is down; publish.py tries 4 mirrors x 3; just retry later.
- Revit says "Cannot open the local model and the central model": already handled (read-only export path); update the add-in.
