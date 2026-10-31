# Performance pass

## Scope and limits

No WoW game data (`WOW_DATA`) was available on the machine used for this pass. The real-engine harnesses
(`driving-smoke.mjs`, `performance-smoke.mjs`, `race-weather*.mjs`, `race-clouds-above.mjs`) could not run, so
**mean/p95 frame time and handler p99 at real poses are NOT measured here**. Data-free GPU/CPU microbenches were used
instead. They run the real shaders and modules at 1920x1080 on a synthetic scene (headless Edge WebGPU, batched wall time,
N passes per submit, median of 5), so absolute numbers are only comparable between runs on the same machine.

## Baseline (microbench)

| Target | Pose | ms/pass |
|---|---|---|
| Rain curtain (`perf-curtain-bench.mjs`) | ground | 4.97 |
| | below cloud base | 4.94 |
| | in cloud | 4.39 |
| | above cloud | 0.08 |
| Cloud High (`perf-cloud-bench.mjs`) | ground | 8.38 |
| | in cloud | 11.96 |
| | above cloud | 12.77 |
| | orbit | 0.50 |
| | storm (weather on) | 7.28 |
| `WeatherRuntime.step` (node) | CPU | ~0.12 ms/frame |
| `shoreTexture` 96x96 (node) | CPU, main thread, per 128 yd shore refresh | ~2.4 ms |

The cloud bench agrees with the +9-11 ms High-tier cost seen in the real game.

## Ranking

1. Cloud High raymarch (8-13 ms/pass at 1080p). It already has early-outs. Reducing steps (28 sheet + 14 funnel) changes the look and is not done.
2. Rain curtain (about 5 ms/pass). Its cost is dominated by per-step `worldAt` and `precipAt` over 24 steps.
3. Periodic spikes: `shoreTexture` (2.4 ms) and the worker-side wave-mask slices (needs data to measure).
4. Weather CPU (0.12 ms/frame) is not a hotspot.

## Optimizations

| # | Change | Gain | Equivalence |
|---|---|---|---|
| 1 | Curtain shader shares the 4 grid reads between precip and the wet mask, and hoists the march invariants (`log2(ratio)`, `stepGrow`, `exp2`) | 4.97 -> 4.74 ms ground (~4.5%) | Pixel readback identical (max byte diff 0 on all poses); `weather-curtain` and `weather-wgsl` tests pass |

## Tried and reverted (no measurable gain)

- Cloud High: `continue` when the step's `absorb` is 0 (skips the light tap and shading). Output identical, but the gain was within noise (ground 8.38 -> 8.39 ms, in-cloud 11.96 -> 11.89 ms), so it was not kept. The cost is the per-step `sheetDensity` and `worldAt` work, not the skipped tail.

## Proposed, not applied (they alter the look and would need equivalence gating)

- Half-resolution curtain pass (large win, visible softening).
- Capping the curtain march at the farthest wet ring.
- Fewer cloud High steps, or evaluating `shellFwd` on the CPU as uniforms (near-exact but not bit-identical).

## Unverified

Real-pose frame time and handler p99, ocean/wind/beach cost, and pod/orbit/storm scenes. Re-run with data:

```
node heavy-lock.mjs --label perf -- node performance-smoke.mjs
node driving-smoke.mjs
node race-weather.mjs
```

Benches: `node heavy-lock.mjs --label perf-cloud -- node perf-cloud-bench.mjs <label> [compareLabel]`, and the same for `perf-curtain-bench.mjs`.

## Real-data pass (WoW + SWE1R data available)

Harness: `perf-pose.mjs` (headless Edge, uncapped, 1280x720, cloud+weather High, own server). Mean frame ms (p99), PROFILE=1 so slightly inflated.

| Pose | Baseline | After |
|---|---|---|
| ground | 9.95 (15.9) | 4.80 (10.7) |
| ground-weather | 12.54 (33.3) | 6.29 (13.7) |
| coast | 12.46 (33.3) | 5.46 (12.1) |
| ocean | 11.92 (29.6) | 5.68 (13.0) |
| in-cloud | 12.82 (30.6) | 7.82 (17.0) |
| above-cloud | 12.19 (17.2) | 7.07 (12.1) |
| orbit | 11.36 (16.9) | 4.04 (8.6) |
| storm | 12.16 (28.3) | 7.29 (11.2) |
| wind-storm | 13.83 (34.2) | 6.11 (10.6) |
| coast-fly (moving) | - | 6.42 (14.2), 4 frames >25 ms |
| ocean-fly (moving) | - | 5.51 (11.3), 1 frame >25 ms |

Wins: `activeBody()` memoized (was `new URLSearchParams` per call, ~40% of main-thread script; 4a27ccfa); `writeUniform` typed arrays + hoisted eyeZ (77422ab3, ~0.3 ms ground); curtain shader hoist (0fb149be, -4.5% GPU, pixel-identical).

Remaining CPU: writeBuffer ~22% (512 KB uniforms/frame), createCommandEncoder, globe-patches stitch/levelAt ~10%. Max-frame spikes (76-146 ms) in fly poses are rare (<=4 frames >25 ms) and not attributed.

Look-changing options (not applied): half-res curtain pass; cap curtain march at farthest wet ring; fewer cloud High steps; shellFwd to CPU uniforms; throttle/memoize globe patch selection; upload only the used uniform range.

Unverified: driving-smoke/performance-smoke handler p99 (performance-smoke driving displacement failed, not debugged); shore-texture/wave-mask slice costs not isolated; poses measured sequentially in one page (tile counts grow).
