# Perf pass 4: upload spikes and 4000 yd/s tests

## Changes
- `renderer-events.js`: `detail`, `scene`, `far-scene` and `terrain-material` uploads are generators drained under a per-frame time budget (`renderer.uploadBudget`, 4 ms, set by `world-app.js`). Results are committed atomically at the end of each event. A 50 ms timer drains the queue when there are no frames. `reset()` cancels queued events. Without `uploadBudget` behaviour is synchronous and unchanged.
- `renderer-sky.js` / `tile-registry.js`: the planet surface bake is incremental (16 rows per step), and the old map stays visible until it finishes.
- `swe1r/hud.js`: the dial is drawn once at creation to pay the first clip/text cost. `globe-patches.js`: `warmPatches()` runs at init.
- No Rust change.

## Harness numbers (perf-torture, TP_CYCLES=5, noisy shared machine)
| scenario | handler max before -> after | frames >25 ms before -> after |
|---|---|---|
| tp-azeroth-drive | 46 -> 5-12 ms (p99 <= 1.9) | 53 -> ~21 |
| tp-mixed-drive | 112 -> 5-11 ms | 86 -> ~56 |

The worst frame is unchanged (~104 ms) and comes from the first Ironforge arrival, not a handler.

## 4000 yd/s tests (`flight-4000.test.mjs`)
Cover wrap and pole fuzz, lap continuity at 30/60/144 fps, hitches, sudden stop/reverse, the wave-speed estimator, teleport vs speed, and creature sweep scale. No real bugs were found. Flat motion is scaled by (R+alt)/R in 3D, which is expected.

## Not done / unverified
- The drawWind `groundUnder` cold cost is not addressed.
- It is not confirmed that the patch and HUD warm-ups individually remove their spikes.
- The ~100 ms first-teleport frame is not investigated.
- There is no 4000 yd/s harness scenario, and queue and heap growth were not measured.
- The body-swap and stream-stress gates were not run (heavy lock contention).
