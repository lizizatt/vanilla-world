# Performance pass 2 (profiling + first fixes)

Profiling report followed by the implemented fixes (see "Results" at the end). Baseline for comparison is `perf-pass.md` (pass 1).

## Method and caveats

- Machine: the dev box, headless Edge (WebGPU), 1280x720, **uncapped** frame rate (`--disable-frame-rate-limit --disable-gpu-vsync`), WoW 1.12 data (read-only), SWE1R data loaded, podracer selected, time locked to noon, shadows off, music/sound off.
- Harness: `node heavy-lock.mjs --label perf-matrix -- node perf-matrix.mjs <label> [cell|prefix* ...]` -> `test-results/perf-matrix/<label>.json` (not committed).
  Settle 6 s, sample 10 s per cell. Per cell: rAF interval mean/p95/p99, frames over 25 ms with the overlapping long task and worker requests,
  `WorldRenderer.draw` CPU, worker request round trips grouped by action, CDP CPU profile (self time by function and file, 200 us sampling), V8 heap, script ms per second.
  Elune moon (data-free) is `perf-elune.mjs`. Streaming used the existing `stream-stress.mjs` (`STREAM_ROUTE=quick`).
- Base settings: cloud High, weather High, particles Medium, waves/scenery/distant/horizon/planet on. Cells override one knob on top of a pose.
- **Noise is large.** Same-cell repeats differ by up to 1.2 ms mean and 2x in frames >25 ms (e.g. `coast-fly` 7.26 -> 6.09 mean, 20 -> 5 frames >25 ms; `coast-fly/weather-standard`
  8.66 -> 6.33 mean, 36 -> 10). The first sweep also ran later cells while other jobs shared the machine. **Treat differences under ~1 ms mean or ~2x in >25 ms counts as inconclusive**; only the big deltas below are called out.
- The CDP profiler itself adds ~100 ms stalls at sample start; rerunning with `PROFILE=0` (`noprof`) kept the stall pattern, so they are not only profiler artifacts (see item 2).
- GPU time is **not directly measured** (no timestamp-query). Proxy: frame ms minus `draw` CPU, and `createCommandEncoder` self-time in the CPU profile (it blocks when the GPU queue is full): 40% of script time in storm and above-cloud, 5-15% elsewhere, so cloud/storm poses are GPU-bound, ground/coast poses are CPU/driver-bound.
  Microbench GPU numbers from pass 1 (1080p) still apply to relative shader cost.
- Worker numbers are request round-trip latency (include queueing behind other worker work), not worker CPU. Worker memory is not observable from the page.
- Load time: 6.8-8.9 s from file selection to world ready (Edge, cached data), 10.8 s for Elune incl. 6 s wait.

## Matrix (mean / p95 / p99 frame ms, frames >25 ms in 10 s, draw CPU ms, script ms per s, heap MB)

Pose rows (all quality tiers at defaults above):

| Cell | mean | p95 | p99 | >25 | draw | script/s | heap |
|---|---|---|---|---|---|---|---|
| ground (Elwynn, no weather) | 4.53 | 7.8 | 13.5 | 3 | 3.25 | 812 | 32 |
| ground-weather | 7.05 | 12.7 | 24.1 | 10 | 5.63 | 872 | 37 |
| coast | 5.68 | 10.1 | 16.3 | 2 | 4.38 | 840 | 36 |
| shoal (14 yd over the surf) | 5.80 | 11.3 | 15.6 | 2 | 4.76 | 889 | 42 |
| ocean | 6.31 | 11.9 | 16.0 | 5 | 5.37 | 898 | 38 |
| in-cloud | 7.67 | 13.1 | 24.9 | 11 | 6.63 | 904 | 19 |
| above-cloud | 8.97 | 14.2 | 27.1 | 21 | 8.11 | 942 | 35 |
| orbit | 4.45 | 8.3 | 9.2 | 1 | 3.52 | 863 | 24 |
| storm | 8.76 | 13.5 | 25.6 | 15 | 7.67 | 915 | 36 |
| wind-storm | 7.23 | 11.7 | 23.5 | 9 | 6.29 | 924 | 22 |
| coast-fly (260 yd/s) | 7.26 | 13.5 | 27.7 | 20 | 5.88 | 899 | 44 |
| ocean-fly (400 yd/s) | 8.38 | 12.6 | 26.2 | 16 | 6.67 | 829 | 29 |
| hispeed-fly (3000 yd/s, 300 yd alt) | 9.01 | 14.1 | **109.2** | 28 | 5.56 | 866 | 64 |
| pod-ground (podracer drawn, 300 yd/s) | 6.35 | 11.2 | 17.6 | 6 | 4.85 | 879 | 24 |
| Elune orbit-down / limb / low-up (data-free) | 2.73 | 5.2 | 6.1 | 0 | 2.1 | n/a | 10-30 |

Repeat of the heaviest cells (second run, same build) for the noise floor: ground 4.71 (11.6 p99), storm 8.80 (26.8), coast-fly 6.09 (16.6), hispeed-fly 10.73 (112.5), storm/particles-high 10.75 (30.5).

Setting sweeps on `coast-fly` (mean / p99 / >25):

| Setting | mean | p99 | >25 | Reading |
|---|---|---|---|---|
| default | 7.26 (6.09 rerun) | 27.7 (16.6) | 20 (5) | |
| cloud Standard | 6.07 | 22.0 | 8 | within noise on this pose (clouds are far/low weight at the coast) |
| clouds off | 6.09 | 12.1 | 6 | |
| weather off | 6.06 | 11.6 | 5 | |
| weather Standard / Low | 8.66 (6.33 rerun) / 6.03 | 45.1 (21.7) / 12.3 | 36 (10) / 5 | Standard was noise; Low looks best |
| particles off / low / high | 7.56 / 7.91 / 7.09 | 39 / 41 / 30 | 26 / 30 / 16 | **No gain from fewer particles**; the stalls are not particle cost |
| waves off | 7.17 | 30.1 | 19 | within noise: waves are not a frame-time cost here |
| scenery off / distant off | 6.44 / 6.33 | 23.2 / 21.4 | 9 / 7 | small, within noise |
| horizon off | 6.49 | 38.5 | 22 | draw CPU -1.3 ms but frame unchanged (GPU/stall bound) |
| **planet off** | **4.76** | 17.0 | 7 | **-2.5 ms mean (-34%), draw CPU -2.3 ms, heap -23 MB** |
| lean (Standard clouds, Low weather, low particles, waves off) | 6.38 | 12.9 | 5 | |
| bare (everything off) | 1.31 | 3.0 | 4 | floor: terrain + sky + water only |

Other sweeps:

| Cell | mean | p99 | >25 |
|---|---|---|---|
| in-cloud: High / Standard / off | 7.67 / 5.99 / 4.25 | 24.9 / 21.0 / 8.5 | 11 / 4 / 1 |
| above-cloud: High / Standard / off | 8.97 (6.08 rerun) / 4.29 / 4.19 | 27.1 (22.6) / 8.9 / 8.5 | 21 (6) / 1 / 1 |
| storm: weather High / Standard / Low | 8.76 / 9.72 / 6.98 | 25.6 / 28.5 / 21.6 | 15 / 27 / 6 |
| storm: particles off / medium / high | 7.71 / 8.76 / **11.50** | 24.9 / 25.6 / **98.1** | 11 / 15 / **51** |
| storm: cloud Standard | 6.94 | 22.2 | 5 |
| ground: scenery off / clouds off / weather off | 5.48 / 6.65 / 6.19 | 7.7 / 11.7 / 7.9 | 1 / 3 / 1 (order drift: these ran after the sky sweeps and are all slower than the first `ground` cell; compare only within the sweep) |
| shoal: waves off / particles off | 6.10 / 6.55 | 21.4 / 21.8 | 4 / 5 (no change vs 5.80) |
| ocean-fly: waves off / particles off | 8.16 / 8.68 | 24.6 / 25.9 | 11 / 18 (no change vs 8.38) |
| hispeed-fly: scenery off / distant off / horizon off | 9.31 / 9.11 / 8.03 | 111 / 98 / 104 | 33 / 38 / 41 |
| hispeed-fly: bare | 2.91 | 10.5 | 16 |

Streaming (`stream-stress.mjs`, quick route, 8000 yd/s, 71 560 yd): 0 errors, terrain recovered 1.5 s after the stop, resident tiles stay 0-8 while moving.
The only `frameP99` outlier is the 2 s launch hitch and a 161 ms and 136 ms frame during tile wave-ins.

## Where the time goes (CPU profile, self time)

- `writeBuffer` (native) 13-24% and `createCommandEncoder` (native, GPU backpressure) 5-40% of script time. Together with `(program)` they are 50-75% of the main thread; JS is only the rest.
- `world-renderer.js` `draw` + `writeUniform` 11-19%.
- `globe-patches.js` (`stitch`, `levelAt`, `edgeLevels`) 8-18% of script at every pose; the single largest JS cost in ground poses (18.4%).
- `land-rect.js` `dropOpenSeaWater` **16-17% of script at high speed** (tile ingest), 2.5% at coast. It does `keep.push(...vertices.subarray(i, i+7))` per vertex.
- Worker: at 3000 yd/s `frame`, `shore-rows` and `wave-mask` requests each average 12 ms (p99 118 ms, max 227 ms) and total ~10 s of latency per 10 s sample, i.e. the worker is saturated and `frame` requests queue behind the shore/wave-mask slices. At 260 yd/s: `shore-rows` 316 req / 3.7 s, `wave-mask` 192 req / 2.3 s, `frame` p99 33 ms (max 116 ms). Static poses: `frame` p99 19-22 ms.
- Main-thread stalls of 95-110 ms (long tasks) occur 1-3 times per 10 s on moving poses (coast-fly 3, hispeed 17, ground-weather 1), usually in the first 2 s after motion starts. CPU samples inside them are empty (native / not JS), so they are driver or GPU waits (pipeline creation, buffer mapping, shader compile on first weather/wave use) rather than script.

### Frames over 25 ms on moving coast flights

`coast-fly`: 20 / 5 / 7 / 8 per 10 s across runs (high variance). Of the ~25 ms frames, a fixed fraction coincide with `shore-rows` (10-17 ms) and `wave-mask` worker round trips; the 100+ ms frames
coincide with the long tasks above and with `frame` round trips of 47-117 ms (worker busy). `ocean-fly`: 16 / 11 / 3 per 10 s; the 25-27 ms frames overlap `shore-rows`/`wave-mask` (7-15 ms each) in 5 of 6 listed cases.
Turning waves or particles off does not remove them (waves-off 19, particles-off 26), so the cost is the shoal/shore data pipeline (worker + upload) and not the wave shaders.

## Ranked findings

Win is mean frame ms or p99 stall unless stated; **T** = changes visuals (trade-off option, off by default).

| # | Biggest cost | Where | Est. win | Risk to look | Effort |
|---|---|---|---|---|---|
| 1 | Planet/globe mesh drawn on the ground | `globe-patches.js` (`stitch`/`levelAt` 8-18% of script), globe draw, 23 MB heap | -2.5 ms mean at coast, -0.5 to -1 ms CPU just from caching `stitch` when the camera cell is unchanged | Caching: none (identical output). Skipping the globe below an altitude where it is occluded by terrain: none if fully hidden; **T** if the horizon curve changes | Low (cache), Med (cull) |
| 2 | ~100 ms main-thread stalls on moving flights (1-3 per 10 s) and 25-40 ms frames | native, outside JS; coincide with tile/shore/wave uploads and first use of weather/wave pipelines | p99 109 -> ~30 ms at high speed if removed; 15-20 -> <5 frames >25 ms at coast | None expected once found; needs a trace (chrome tracing / WebGPU timestamp-query) before choosing a fix | Med (diagnose first) |
| 3 | Worker saturated by `shore-rows` + `wave-mask` slices at speed | worker `shore-rows`, `wave-mask`; `shore-field.js` | `frame` p99 118 -> ~30 ms at 3000 yd/s; fewer 25 ms frames at 260-400 yd/s | None if only scheduling (budget per frame, prioritise `frame`, skip while above a speed threshold); **T** only if the wave field is allowed to lag | Med |
| 4 | `dropOpenSeaWater` spread-push per vertex | `land-rect.js:30` | 16-17% of main-thread script at high speed (about 0.5-1 ms/frame average, removes tile-ingest spikes); pure CPU | None: preallocate a `Float32Array` and `copyWithin`/set; output identical | Trivial |
| 5 | `writeBuffer` 13-24% and `writeUniform` 4% | `world-renderer.js` `writeUniform`, per-draw 64-float uniform blocks, one `writeBuffer` per frame/chunk | ~0.5-1 ms CPU in dense poses; fewer driver stalls | None if batching writes or sharing the per-frame constants (view/sky/sun) across items; staging only changed items | Med |
| 6 | Cloud High raymarch | `clouds`, volumetric pass (GPU) | in-cloud 7.67 -> 5.99 (Standard) -> 4.25 (off); above-cloud 8.97/6.08 -> 4.29; about 3.4 ms at 720p, scales with pixels (9-13 ms at 1080p from pass 1) | **T**: Standard drops volumetric lighting. Safe variants: half-res/temporal reprojection (**T** softness), auto-drop to Standard when frame p95 > budget | Med |
| 7 | Rain curtain + weather High | `weather-curtain.js`, `weatherQuality: high` | storm 8.76 -> 6.98 with Low (-1.8 ms); ground-weather 7.05 vs 6.19 weather-off (+0.9 ms) | **T**: Low reduces curtain/precip fidelity. Safe: cap the march at the farthest wet ring (pass 1 idea), stop the pass when no wet cell in view | Med |
| 8 | Particles at High in storms | `particles.js` | `storm/particles-high` 11.5 mean, p99 98, 51 frames >25 ms vs 8.76 at Medium (+2.7 ms, 5 stalls) | **T** only if High is capped; otherwise none: High is opt-in, cost is not paid by Medium/Low | Low (cap or instance-limit High) |
| 9 | Horizon layer | `horizon` | draw CPU -1.3 ms (hispeed -2.7 ms), but frame did not improve (GPU/stall bound) | **T** (removes far silhouette) | Low |
| 10 | Scenery / distant | `scenery`, `distant` | -0.8/-0.9 ms mean at coast-fly, within noise | **T** | n/a, option only |

Not worth doing now (measured negligible): wave shaders and beach waves (waves off = no change at shoal, coast, ocean), wind particles (`particles-off` no gain), shore texture refresh (below the stall noise floor), `WeatherRuntime.step`.

### Suggested order

1. Items 4 and 1 (cache `stitch`, no-op fix in `dropOpenSeaWater`): free, identical output, measurable.
2. Item 2: capture a trace of one coast-fly (and `hispeed-fly`) to name the native stall before choosing a fix; this is the main user-visible p99 cost.
3. Item 3 (worker scheduling) with `stream-stress.mjs` as the gate, then item 5.
4. Items 6-9 only as quality-tier options or adaptive degradation, never silently.

## Results (implemented)

Same harness, 720p uncapped, one run per row (noise up to ~1.2 ms mean). Before = the matrix above (first sweep); after = `PROFILE=0`/profiled runs on this branch.

| Cell | before mean / p99 / >25 | after items 1-3 mean / p99 / >25 |
|---|---|---|
| ground | 4.53 / 13.5 / 3 | 3.93 / 9.4 / 2 |
| coast-fly | 7.26 (6.09 rerun) / 27.7 / 20 | 5.34 / 12.2 / 4 (other runs: 5.17 / 11.7 / 1, 6.03 / 14.1 / 6 after item 1 only) |
| ocean-fly | 8.38 / 26.2 / 16 | 5.79 / 11.7 / 1 (item 1 only) |
| hispeed-fly (3000 yd/s) | 9.01 / 109.2 / 28 | 7.04 / 44.1 / 27 (repeat runs: 7.01 / 33.1 / 24) |

1. **Streaming at speed** (`renderer-waves.js`, `app-frame.js`): the eye speed is smoothed per frame in `waveItems` (teleport jumps clamped); above `WAVE_STREAM_SPEED` = 1200 yd/s no wave-mask / shore-field refresh is requested and an in-flight sliced fetch is abandoned between slices. Outside the mask window amplitude reads 0, so the flat fill covers the sea; refresh resumes when the flight slows. Below 1200 yd/s nothing changes (260-400 yd/s flights keep full waves/shore). At 3000 yd/s `wave-mask` requests fell 825 -> ~120 and `shore-rows` 792 -> ~125 per 10 s (the rest happen before the smoothed speed crosses the threshold). **Finding that corrects the profile:** the p99 did not move from this alone (108 -> 112 ms), because the 114-ish ms worker round trips listed for `frame`/`shore-rows`/`wave-mask` were the *same* main-thread stall (the reply cannot be read while the main thread is blocked), not worker saturation. The p99 only fell once items 2-3 removed CPU on the main thread (and `stream-stress` recovery after the stop went 1.5 s -> 1.0 s).
2. **`dropOpenSeaWater`** (`land-rect.js`): preallocated `Float32Array` + `set` instead of `keep.push(...subarray)`; output identical (new test). 17% of script at 3000 yd/s -> 4.2%.
3. **Globe patches** (`globe-patches.js`): `stitch` is memoised on the exact leaf set (cell keys + limit, 8 entries), so identical leaf sets give identical output (existing 51 wave/globe/land tests pass). `stitch`/`levelAt`/`edgeLevels` dropped out of the top of the CPU profile (was 8-18% of script; `arc` from the selection walk remains at ~2-3%).

Gates: `stream-stress.mjs` (quick, 8000 yd/s) ok, 0 errors; matrix runs 0 errors, `frame` handler p99 ~20 ms (coast-fly 20.2); wave/shore/globe/land unit tests 51/51. Flat water with waves off and the wave shaders/Rust were not touched, so no `pkg` rebuild or JS/Rust parity change was needed.

### Item 4: the ~100 ms main-thread stalls (traced)

`perf-matrix.mjs` gained `TRACE=1` (Chrome tracing around the sample, reduces to events overlapping >60 ms main-thread tasks plus >3 ms GC events, in `test-results/perf-trace/`) and records synchronous WebGPU calls >8 ms (`slowGpuCalls`) and long-task times (`tasksAt`).
- Every stall is one `RunTask` -> `BeginMainFrame` -> rAF `FireAnimationFrame` -> `v8.callFunction` of our `frame` with **no child events**: not layout/style/paint, not worker messaging, not DOM.
- **Not GC:** longest GC event in any trace was 5 ms; scavenges inside the stall are tiny.
- **Not a slow WebGPU call:** during the first-seconds stall (1.1 s, 157 ms in `ground-weather`; 0.15 s, 55-169 ms in flights) no single `createRenderPipeline`/`createShaderModule`/`submit`/`writeBuffer` call exceeded 8 ms, and `CommandBufferProxyImpl::WaitForToken` was 2 ms. The stall is therefore a one-time warm-up inside script (first-use JIT/lazy compile of the weather/wave/scene paths and first tile ingest), not a driver wait as the profile guessed.
- After items 1-3 these first-second stalls disappeared from several coast-fly runs (0 long tasks in the `gpu` run; one 166 ms in the traced run) and are not reproducible enough to attribute further without a JS-level frame breakdown; they happen once per cell start and are not recurring.
- The recurring ones at 3000 yd/s (50-76 ms, 4.5-6.7 s into the run) coincide with clusters of 8-18 ms `writeBuffer`/`writeTexture`/`createCommandEncoder` calls: tile-ingest upload bursts when many new tiles arrive at once (GPU queue backpressure). A fix would be an upload budget per frame in the terrain/tile ingest path; not done here because it delays tile visibility (visual trade-off) and needs its own streaming gate run.

### Remaining / trade-off options (not done)

Item 5 (batch `writeBuffer`/`writeUniform`), the sky/weather/particle quality options (6-9), per-frame tile-upload budget (above) and skipping the globe mesh when occluded remain open; none were changed because they alter visuals or need separate validation.

## Re-run

```
node heavy-lock.mjs --label perf-matrix -- node perf-matrix.mjs full             # whole matrix, ~12 min
node heavy-lock.mjs --label perf-matrix -- node perf-matrix.mjs x coast-fly 'coast-fly/*'
PROFILE=0 SETTLE=3000 SAMPLE=4000 node heavy-lock.mjs --label perf-matrix -- node perf-matrix.mjs quick ground coast-fly
node heavy-lock.mjs --label perf-elune -- node perf-elune.mjs full
STREAM_ROUTE=quick node stream-stress.mjs                                          # self-locks, do not wrap
```
Requires `WOW_DATA` (and optionally `SWE1R_DATA`); outputs go to the git-ignored `test-results/`. Repeat any cell at least twice before trusting a sub-millisecond difference.
