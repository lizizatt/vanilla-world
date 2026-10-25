# Globe pivot: status and hardening list

## Milestones
- M1 seam colour: done (`a7c1445`). M2 planet frame module: done (`39bac14`, not yet used by the renderer).
- M3: gravity/atmosphere hooks done (`planet-physics.js`). Reversed-Z and WDL globe height NOT done.
- M4: patch-tree globe + sparse registry, default ON (`257f4ba`..`5cb41fa`).
- M5b still blocked after M3: the baked height texture is 2048x1024 over the whole sphere (~130 yd/texel) so it carries WDL-scale relief only; authored ADT ground (~4 yd) still needs the bend shader to sit on the sphere. Removing it needs a near-field authored-terrain path (per-tile curved/sphere-mapped ADT meshes or a high-res local height tile on the patch tree) first; not a safe small step.
- M6: the landing now has "Play demo world" (procedural providers only, no game files; `8998dee`), verified in muted Edge; save/reload in demo not yet re-verified.
- M5 blocked on M3: the globe crossfade is already ~0 ([0,60] yd) but the bend shader is what curves the authored ADT tiles, so it can only go once the patch tree carries ADT/WDL height. Do M3 first.
- M5 NOT done: bend shader, crossfade ramps and the analytic sphere are still present. The analytic pass still draws
  atmosphere limb, stars and moons, so it can only shrink, not be deleted outright.
- M6 checked (muted Edge, no WoW data): hosted page loads with no console errors but stops at the "Select your World Data folder" landing gate, so the procedural-only world is unreachable without data (no demo-mode entry yet). Providers use `FALLBACK_RECTS`/procedural providers but has no final captures.

## Culling / visibility issues known
1. Maelstrom: rectangular water-mesh edge (teal vs navy globe) inside the hole at ~5-10k yd.
2. Ocean fill is one flat quad (130k yd pad); quad edge vs globe at 130k yd is not blended.
3. FIXED (065b94d): grey/navy horizon ring at 200 yd over open sea - the 130k ocean quad was bent as a chord; now 2500 yd cells.
4. FIXED: patch tree is 2:1 edge-balanced and finer patches snap odd edge vertices onto coarser neighbours (instance flags S,N,W,E); the 2% edge sink is gone. Level-0 sag ~52 yd remains.
5. Authored-tile rectangles: FIXED. `adt` chunk (tile-registry.js colour grid) is splatted from streamed minimap colour and composited over procedural land; globe surface is patched per dirty texel (<=1/s). Only tiles streamed so far have real colour.
6. Valley haze: FIXED analytically (water-shader.js `valleyHaze`): haze layer below the eye, fog = path length inside layer, so far valley floors haze behind ridges while near valley contents stay clear. No depth/draw-order change needed.
7. 500 yd Maelstrom pose sits inside the cloud layer.
8. HUD speed spike for one frame at the pole flip.
9. Bend vs globe mapping differs ~8% at world edges.

## Harness
- `ascent-continuity.mjs`: vertical ascent step gate (open sea gated at 30, Maelstrom reported).
- `audit-culling.mjs`: Monte Carlo pose sweep; `void` only gates below 20k yd (above, dark is legitimately space: at 100k yd the planet subtends ~0.3 rad half-angle so most poses see sky). Run `node audit-culling.mjs 40 7` (ground/maelstrom/openSea/pole, 50..100k yd, muted Edge): 0/40 void or pop (>30) failures. Max pop seen 26 at a ground 500 yd pose (low-altitude move of 2 yd; threshold is untuned, no visible issue). Valley-haze pose still not located by the sweep.

- M3 heights (c803899): pale cyan block near the limb at 8k yd (pose-h3d-b) FIXED: displaced-face normal shading + zero relief where registry says sea; verified at 8000 yd pitch -0.8, block is now land-coloured. Reversed-Z audit still open.

- Reversed-Z audit: all passes use depth24plus, clear 1, compare less/less-equal/always (8 pipelines + analytic patch depth). No precision artifact seen in ascent (POPS 0), so reversed-Z is deferred until one is measured; switching means changing every pipeline, the projection and the patch-shader depth together.

## Startup-smoke flake: connected gamepad
The intermittent default-spawn/saved-pose height failures were not a physics or streaming race. A physically connected controller (stick drift, jump on button 0) fed hop flag 8 into ticks, lifting the car ~0.5 yd. startup-smoke now stubs navigator.getGamepads. Real users with a controller get normal jump input; no engine change.

## 2026 hardening pass (post camera-floor/clouds/memory-budget)
- Fixed: world-engine called wasm area_at unguarded (stale pkg would throw every frame in fly mode); windLevel now tolerates NaN/undefined speed.
- Known flaky: startup-smoke occasionally times out clicking #save after fly/drive (passes on rerun); not a product failure.
- Gate caveat: drive p99 was 28-36 ms in this pass while the host sat at 100% CPU from unrelated processes (render p99 ~10 ms unchanged); needs re-measure on an idle machine.
- Not fixed: loading-smoke/music-smoke hard-code port 4183; music-smoke times out waiting for first track in this env; no dedicated space music track.

- Removed the no-WoW-data path: the 'Play demo world' button and worker route, demo night-light settlements. M6 demo notes above are historical. demo-source.js remains only because the Elune moon source reuses its ADT helpers (trim when moon-source stops importing it).
