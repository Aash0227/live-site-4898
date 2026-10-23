# GPU selection and performance (laptop: AMD Radeon iGPU + NVIDIA GeForce RTX 3050 Laptop, 4 GB)

## Which GPU does the browser use? (measured, `node scripts/bench-gpu.mjs --probe`)
| Browser | Default | WebGL powerPreference 'high-performance' | Per-launch option |
|---|---|---|---|
| Chrome 155 | AMD iGPU | AMD iGPU (ignored) | `--force_high_performance_gpu` or `--use-adapter-luid=<NVIDIA LUID>` -> RTX 3050 |
| Edge 155 | AMD iGPU | AMD iGPU (ignored) | `--force_high_performance_gpu` -> RTX 3050 |
| Firefox 153 | AMD iGPU | AMD iGPU (ignored) | none works (`webgl.power-preference-override`, `webgl.disable-angle` stay on AMD) |
So the page cannot pick the RTX itself; only the browser launch option or the Windows per-app setting can.

## Is the RTX faster? (`node scripts/bench-gpu.mjs --gpu igpu,rtx --runs 2 --seconds 15`, Chrome, vsync off = render cost)
| Scenario (iso pose) | iGPU fps / GPU ms per frame | RTX fps / GPU ms per frame |
|---|---|---|
| BIM only (Fragments) | 338 / 0.67 | 416 / 0.08 |
| + terrain + imagery | 219 / 2.39 | 350 / 0.17 |
| + Google photoreal (299 draw calls, 0.28 M tris) | 109 / 6.0 (p95 frame 18 ms) | 171 / 0.64 (p95 16.6 ms) |
Load / settle times are network bound and equal on both (photoreal settled 10-12 s either way). With the RTX the frame is CPU bound
(~9.5 ms median with photoreal), so on a 60 Hz display both reach 60 fps on these scenes; the RTX gives ~9x GPU headroom (shadows, AO,
larger models such as Madera). Verdict: use the RTX for this viewer; it is faster in every measured scenario, not slower.

## How to make your browser use the RTX (you do this; it is a Windows setting, not changed by us)
1. Windows Settings > System > Display > Graphics.
2. "Add desktop app" > browse to `C:\Program Files\Google\Chrome\Application\chrome.exe` (Edge: `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`, Firefox: `C:\Program Files\Mozilla Firefox\firefox.exe`).
3. Click the app > Options > "High performance (NVIDIA GeForce RTX 3050 Laptop GPU)" > Save. Restart the browser completely.
   NVIDIA Control Panel equivalent: Manage 3D settings > Program Settings > add the browser > "High-performance NVIDIA processor".
4. Verify: open the viewer with `?debug=1` (the info line shows the WebGL renderer: it must name the NVIDIA GPU), or chrome://gpu > "GL_RENDERER".
Quick test without changing settings (Chrome/Edge): start the browser with `--force_high_performance_gpu`.
