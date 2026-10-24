# Design: orbital mechanics, camera and movement controls

Status: recommendation (no code changed). Inputs: `space.js`, `planet-frame.js`, `planet-physics.js`, `flight.js`, `orient.js`, `world-camera.js`, `camera-collision.js`, `world-input.js`, `app-frame.js`, `SPACE-PHYSICS.md`, Rust `flats-racer-physics`.

## Recommendation: keep module boundaries, add a typed contract
Do not rewrite into one controller. Instead:
1. Extract pure functions from existing modules: input -> action mapping, throttle/axis shaping, `flightBoost`, camera spring/clearance, chart <-> planet conversion, attitude stepping. Keep public call sites.
2. Centralise tuning in named, versioned, frozen tables (flight speeds in `flight.js`, orientation fades in `orient.js`, camera constants in `world-camera.js`, planet ramps in `space.js`).
3. Adopt two cheap ideas from the state-machine proposal without the rewrite: a canonical `Intent` object produced by `world-input.js`, and an explicit `regime` tag (`ground | atmosphere | orbit`) derived in one place from altitude/handoff bands, consumed by camera and HUD.
4. Rust remains authoritative below `H_flat`; do not duplicate integration in JS.
5. Tests: quaternion norm/finite, chart round-trip error (< 1e-6 yd), monotone/smooth tuning curves, camera clearance, input-device equivalence, fixed-step determinism, golden takeoff/orbit/landing traces, boundary tests at `H_flat`/`H_edge`.

## Rejected: single regime controller owning one f64 planet-frame state
It makes continuity and replay architectural, but it couples input, sim, camera, render and HUD, risks feel regressions, and duplicates what Rust already owns. Revisit only if tests expose a real cross-module transition bug that the `regime` tag and boundary tests cannot fix.

## Migration
Intent + regime tag (no behaviour change) -> pure-function extraction -> tuning tables -> property/feel tests -> optional later move of f64 orbital integration into Rust where fixed-step state already lives.

## Risks
Duplicate tuning during transition; handoff discontinuities; accidental feel change. Mitigate with a single source of truth per constant and golden traces.

## Success
Feel tests unchanged, handoff velocity/orientation discontinuity < 1%, deterministic replay, no per-frame allocation increase.
