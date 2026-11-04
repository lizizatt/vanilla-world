# Perf pass 3 — teleport and fast-flight torture cases

Scope: repeated map-panel teleports (Elune ↔ Azeroth, distant Azeroth points) and fast laps around Azeroth, with creature collision, weather, clouds and ocean on. Same playbook as `perf-pass-2.md`.

## Method

Harness: `browser/perf-torture.mjs` (new). It injects its instrumentation through route rewrites, so no product source changes. Run, from `browser`, with `WOW_DATA` and `SWE1R_DATA` set:

```
node heavy-lock.mjs --label perf-torture -- node perf-torture.mjs <label> [scenario...]
```

| Env | Default | Meaning |
|---|---|---|
| `TP_CYCLES` | 6 | teleport round trips |
| `LAP_S` | 30 | seconds flown per lap cell |
| `DETAIL_MAX` | 20000 | ms cap on waiting for a quiet state after a teleport |
| `PROFILE=0` | on | disables the CDP CPU profile (it inflates frame times) |

Scenarios: `tp-bodies-drive|fly`, `tp-azeroth-drive|fly`, `tp-mixed-drive`, `lap-800|2000|4000`, `lap-2000/{cc,waves,weather,clouds}-off`, `lap-low`, `lap-low/cc-off`. Output goes to `test-results/perf-torture/<label>.json`.

It records:
- rAF frame time (mean/p95/p99, counts over 25/50/100 ms) and long tasks;
- main-thread worker message-handler times;
- worker per-action run and queue times, plus `WorldClient.request` round trips;
- `WorldRenderer.draw` CPU time and synchronous WebGPU call counts, time and `writeBuffer` bytes per frame;
- 100 ms samples of JS heap, GPU bytes, wasm memory, tile/asset counts, and gate/required-tile/queue state;
- the worst uninterrupted main-thread task, attributed by self and inclusive time (`spikeIncl`) through a per-teleport CPU profile, and the `swapProfiles` phases;
- heap slope and heap after a forced GC over a teleport run.

Caveats. Another session shared the machine, so absolute frame times drift (frame mean 4.5 → 7 ms between runs). Deltas of the spike and long-task numbers are CPU-bound and reproduce; frame-mean deltas under about 1 ms are not trustworthy. "Time to full detail" is not reliable on Elune: the near-terrain plateau (17/26 tiles) and `far.reading` never settle, so most Elune runs hit the cap. I report gate time and required-tile time instead.

## Baseline results (before)

Teleport, drive mode, map panel, creature collision/weather/clouds/waves on:

| Case | Gate | Frame mean / p99 / max | Main-thread long task | Handler p99 / max |
|---|---|---|---|---|
| → Elune | 0.36–1.4 s | 4.1–4.8 / 17 / **173–201 ms** (1–2 frames >100 ms) | **180–195 ms, every arrival** | 0.6 / 20–29 ms |
| → Azeroth | 0.5–0.65 s | 4.5–6.1 / 17–25 / 35–88 | 0–67 ms | 0.5 / 22–67 ms |
| fly → Steamwheedle / Ironforge / Maelstrom | 0.04–1.5 s | 3.5–6.8 / 11–34 / 18–88 | 0–60 ms | 0.3–5.6 / 6–60 ms |

Flight laps at 25 s each, one profiled run:

| Lap | Frame mean / p95 / p99 | >25 ms | Max |
|---|---|---|---|
| 800 yd/s | 5.8 / 11 / 22 | 20 | 35 |
| 2000 yd/s | 6.2 / 16.5 / 28 | 63 | 39 |
| 4000 yd/s | 9.3 / 26.6 / 35 | 173 | 69 |

Without the profiler (20 s cells): 800 → 6.0 / 21 p99; 4000 → 6.8 / 29; 2000 with waves off → 7.2 / 30; weather off → 6.8 / 29; **clouds off → 5.5 / 22 with 22 frames >25 ms against 41–54**.

Memory. The JS heap saws between 250 and 460 MB. The heap after a forced GC is flat across teleports: 292 → 305 MB (12 teleports) and 343 → 261 MB (8), so there is no leak. GPU bytes: Elune about 180 MB, Azeroth 210–250 MB, and the unloaded body is shed.

## Ranked findings

| # | Cost | Evidence | Fix | Expected gain / trade-off | Status |
|---|---|---|---|---|---|
| 1 | **Elune arrival stalls the main thread 180–195 ms** | the CPU profile of the worst task: `drawBodies → otherSurface → bakeSurface` was 79%, with `feather`/`hash`/`noise` of skipped procedural chunks inside `registry.sample` | with real data the procedural continents never contribute: drop them from the bake, test seamless chunks through the provider first, patch only the colour-grid texels streamed since the last bake, and keep the far bake across swaps | bake 144 → 45 ms (bit-identical); later arrivals have no bake. Arrival long task 180–195 → 0–58 ms after the first (first still ~120 ms). No visual change | **done** |
| 2 | Azeroth cloud land-mask bake (30 ms) on first use per body | `bakeLandMask` under `CloudMask.update` | cache by rects | −30 ms on first sight when the rects match; identical output | **done** (shared) |
| 3 | `encodeHeights` of a 2 M-cell grid (~25 ms) | spike profile | constant byte for unset/sub-sea cells | 25 → 18 ms (more with a mostly-sea grid), byte-identical (checked on 2 M random cells including NaN/±0) | **done** |
| 4 | Worker `reset`/`restore` runs 230–470 ms, `rebind` 40–58 ms ×2 on each swap | `workerByAction` in the JSON; the worker's `frame` handler queues behind it (`qMax` 35–50 ms) | profile in wasm (may need Rust: e.g. avoid rebuilding unchanged tiles/physics on `reset`) | ~0.3 s faster teleport gate and no worker freeze; needs Rust, so not attempted | open (needs wasm rebuild) |
| 5 | Main-thread `scene`/`detail` message handlers of 20–68 ms after Azeroth arrival | the handler table in the JSON (`scene:68`) = asset/texture upload burst in `renderer-events.js` | spread asset/texture uploads over frames with a per-frame byte budget (as the pass-2 tile-upload-budget idea) | removes the 50–70 ms frames after a teleport; pop-in delayed by 1–2 frames | open |
| 6 | Flight laps: clouds are the largest renderable cost | clouds off: mean −1.3 ms, frames >25 ms −50%; `createCommandEncoder` 13–44% of CPU samples = GPU backpressure | fewer cloud march steps / half-res cloud buffer above ~2000 yd/s | maybe −1 to −1.5 ms/frame at speed; **visible** (softer clouds) so left to you | open (visible trade-off) |
| 7 | `writeBuffer` ≈ 0.6–0.85 MB/frame in ~10 calls (almost all the 256 B-per-item `frameUniforms`), JS GPU API ≈ 1.5–3 ms/frame | `perFrame` in the lap JSON | pack per-item uniforms smaller (shader + layout change) or upload only the visible items' changed range | −0.5–1 ms/frame; touches shaders, so out of this pass | open |
| 8 | One-off frames: `selectPatches`/`patchesAt` ~60 ms (cold, other-body globe), pod HUD `canvas.clip` ~40 ms (`swe1r/hud.js:181`), `drawWind groundUnder` | per-teleport `spikeIncl` | warm on prepare / cache clip path | ≤40–60 ms on a few arrivals | open |
| 9 | Frames >25 ms at 4000 yd/s: 52–173 per 20–25 s, p99 29–35 | lap table | the GPU-bound items above (#6, #7) | — | open |

## What changed (files)

- `tile-registry.js`: `surfaceChunks` (leave out skipped procedural chunks), seamless chunks sample the provider before computing the feather weight (pure functions, same result).
- `renderer-sky.js`: `otherSurface` uses them and patches dirty texels in place of a full re-bake; the drawPlanet bake uses `surfaceChunks`.
- `renderer-events.js`: `farColour` records dirty texels; the far-bake fields are parked and restored with the planet state (`PLANET_STATE`, `emptyPlanetState`) so a repeat swap re-bakes nothing.
- `clouds.js`: the land-mask bake is memoised by rects.
- `height-bake.js`: sea fast path.
- `tile-registry.test.mjs`: parity tests (real-data and procedural chunk sets bake bit-identically; patching dirty texels equals a full re-bake).
- `perf-torture.mjs`, `race-gate-lab.mjs` (a `setup`/`args` hook): the harness.

No Rust change. Flat water, waves and the golden parity tests are untouched (full unit suite: 1250 tests, 0 failures).

## After

Same harness (`tp-bodies-drive`, 4 cycles, loaded machine):

| Elune arrival | Before | After |
|---|---|---|
| longest main-thread task | 180–195 ms (every arrival) | 119 (first), 0, 58, 0 |
| worst frame | 173–201 ms | 113 (first), 35, 52, 35 |
| frames >100 ms | 1–2 per arrival | 0–1 (first arrival only) |

Gates: `body-swap-stress.mjs` passes (0 errors, handler p99 under its 20 ms assertion); `STREAM_ROUTE=quick node stream-stress.mjs` ok (0 errors). Lap numbers are unchanged by this pass (no lap fix was a safe clear win).

## Unverified

- The frame-time means across before/after runs are not comparable (load from other sessions); only the long-task and worst-frame deltas are claimed.
- The first Elune arrival of a session still pays about 120 ms (first bake plus first-use costs).
- Items 4–9 are measured but not fixed.
