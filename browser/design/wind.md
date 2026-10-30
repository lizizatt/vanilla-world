# Procedural wind

One deterministic wind field drives wave-top spray and blowing dust/snow. Render-only: Rust physics and the shared Gerstner waves are never changed.

## Field (`wind.js`, constants in `wind-config.js`)

`windAt(a, x, z, t)` returns `{dir, speed, strength, gust, storm}` for a chart position and the wave clock (sim ticks / 120, wrapped at 1024 s; every gust frequency is an integer multiple of 2π/1024 so the wrap is seamless).

- **Base**: the latitude belt wind (`beltWind` from `cloud-flow.js`, flat chart: east +x, north -z) scaled by `beltScale`, with a slow per-position veer.
- **Zone character** (`zoneCharacter`): `sea` (wave mask at the eye), `snow` / `desert` (weather climate reason), then name patterns (`coast`, `mountain`, `forest`), else `plains`. Each zone has a `floor`, `gain` and `gust`; forest is sheltered, desert/snow/mountain are exposed. The runtime eases zone parameters (`tau` 3 s) so borders never pop.
- **Gusts**: three travelling sines over position and time.
- **Storm**: `weather.state.level` ramps in `storm.add` yd/s. The Maelstrom adds a Rankine swirl with inflow plus a boost inside `core + halo`.
- `strength` is speed over `maxSpeed`, clamped to 0..1. Effect ramps: `sprayK` / `dustK` / `snowK` are exactly 0 below their `on` thresholds.

## GPU mirror (`wind-wgsl.js`)

`windWGSL()` emits `windAt(a0,a1,a2,xz,t) -> vec4f(dirX, dirZ, speed, strength)` reading the three-vec4 block from `packWind`. `wind.test.mjs` checks the emitter carries every constant; `wind-parity.mjs` runs it as a compute shader in Edge against the CPU (worst error ~6e-5 dir, ~8e-4 yd/s).

## Layers (`renderer-wind.js`, `wind-particles.js`)

- `stepWind` (after `stepWeather`) takes one CPU sample at the eye and updates `WindRuntime`. Wind is on when weather is on and the tier is not `off`.
- `drawWind` returns 0 and records no pass when no layer is above threshold. Otherwise one depth-tested pass draws:
  - **Spray**: instanced streaks in a 56 yd world-anchored box, placed on crest tops of the shared Gerstner surface (`waveVertex`, mask and uniform of the water pass), gated by local wind strength and wave amplitude.
  - **Dust / snow**: streaks hugging the ground under the eye (ray cast through `cameraFloor`, re-queried 0.3 s), drifting with a CPU-integrated wrapped offset, faded with height above ground.
- Tier gating reuses `weatherQuality` (`resolveWeatherTier`): particle counts `off 0 / low 320 / standard 1100 / high 2600`.

## Hooks

- `seaState(..., windStrength)` can only raise the whitecap wind term (`windSeaK`); `windWaveHint` is an unwired hook for amplitude, deliberately not applied so render and physics waves keep matching.
- `worldTest.windStorm(v)` forces storm level, `worldTest.wind()` reports stats, `worldTest.windMael()` the Maelstrom centre.

## Verification

`node --test wind.test.mjs`; `PORT=<free> node wind-parity.mjs`; screenshots: `PORT=<free> WOW_DATA=... node heavy-lock.mjs -- node wind-shots.mjs [spray|dust|snow]` -> `runtime/gate-preview/wind-*.png` (run each scene in its own process; the camera pose is re-applied during waits).
