# Design: depth buffering and culling across systems

Status: recommendation (no code changed). Inputs: `world-renderer.js` draw(), `renderer-init.js`, `renderer-*.js`, `space.js`, `shadow.js`, `clouds.js`, `audit-culling.mjs`, `HARDENING.md`.

## Current state
Every pass uses `depth24plus`, one clear to 1.0, mixed `less`/`less-equal`/`always`. Order: sky/dome -> planet -> patches -> terrain -> scene, then shadows, clouds (reads scene depth, linearised with its own near), props, particles (read-only). Planet R = 42,785 yd; camera to about 100k yd. Culling logic is per system.

## Recommendation: documented layered passes plus shared culling helpers
1. `render-passes.js`: one table of passes (order, projection range, clear/load/store, depth compare, depth write). Pipelines take their depth state from it, replacing the scattered descriptors in `renderer-init.js`.
2. Split far/planet (sky, analytic globe, patches; far range) from near world (terrain, ocean, actors, craft; near range), with an explicit depth clear between. Shadows, clouds, props and particles load near depth with declared read policy; the cloud depth linearisation reads its near/far from the same table.
3. `visibility.js`: tested pure helpers (sphere/frustum, horizon, distance/LOD, planet-occlusion). Each system keeps its own budgets and policy but stops re-implementing spatial tests. `audit-culling.mjs` gains horizon/planet false-negative checks.

## Rejected (for now): global reversed-Z + one central culling pass
Elegant, but it requires simultaneous changes to projection, analytic patch depth, cloud depth reconstruction, shadows and particles, and HARDENING records no precision artefact on ascent today. Keep as an option: the pass table (step 1) makes a later switch a single-table change if precision defects appear. A central draw-list culler is deferred until the shared helpers show real duplication left over.

## Migration
1. Pass table and constants, same behaviour (assert generated descriptors equal current ones).
2. Unify cloud/shadow near-far reads on the table.
3. Split planet/near passes with a depth clear; verify seam and ascent continuity.
4. Extract `visibility.js`; migrate systems one at a time.
5. Re-evaluate reversed-Z against measured precision captures (near ground, R, 100k yd).

## Risks
Extra clear cost; seam artefacts at the pass boundary; cloud depth mismatch. Gate on ascent continuity, cloud sweeps, screenshots, zero-void audit, GPU timings, draw counts, drive p99.

## Success
All depth state defined in one module, no per-system duplicated culling math, no visual regressions, stable p99.
