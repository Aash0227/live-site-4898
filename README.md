# Live-Site Viewer - 4898 El Camino Real (Aron Terrace / Vestibule)

Revit 2023 model -> IFC -> That Open Fragments -> web viewer in its real site: terrain + imagery, Google Photorealistic 3D Tiles (via
Cesium ion), visual demolition of the existing building, BIM picking with Revit identity, engineering / realistic modes,
permit-set intelligence. Published from Revit with the 4898 add-in's **Live Site** panel.

**Setup on a laptop:** clone, then `powershell -NoProfile -ExecutionPolicy Bypass -File setup.ps1 -EnvFile <office .env>`
(or open the folder in Claude Code and say "set this up" - see `CLAUDE.md`). The add-in installer is the release asset
`4898-Revit2023-Installer-v1.0.0.exe` (one file, per user, no admin).

**Viewer:** `python serve.py --port 8780` -> http://127.0.0.1:8780/viewer/?project=vestibule (`?photo=0` = no Google layer,
`?debug=1` = GPU + fps). Published 4898 revisions are in `data/revisions/`.

Docs: `docs/` (picking/materials, tile loading, GPU, demolition, projects).
