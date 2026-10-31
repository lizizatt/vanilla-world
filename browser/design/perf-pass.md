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
