# Design: clouds

Status: recommendation (no code changed). Inputs: `clouds.js`, `cloud-flow.js`, `cloud-march.js`, `renderer-clouds.js`, `CLOUD-FLOW.md`, cloud tests.

## Recommendation: keep tiers and the JS mirror, make them data-driven
1. `cloud-config.js`: one frozen record per tier (`steps`, slab/tower extents, span caps, noise mode, light taps), plus Maelstrom and flow constants and per-tier budgets. Imported by `clouds.js`, `cloud-march.js`, `renderer-clouds.js`.
2. Generate WGSL constants from the config (extend the existing `flowWGSL()` approach); delete hand-copied `NS`, tower and cap literals.
3. Split `clouds.js` into `cloud-config`, `cloud-uniforms`, `cloud-mask`, `cloud-shader`, `cloud-noise`, with a facade re-exporting today's symbols.
4. Parity tests: config-derived extents/density/flow/Maelstrom values against both WGSL source signatures and the JS mirror. Close the known gap that the mirror's High tier substitutes analytic noise for the 64^3 texture, either by mirroring it or by documenting the tolerance.
5. Per-tier GPU timestamp and CPU-mirror telemetry with budgets (Standard about 0.3 ms / 8 steps, High about 0.8 ms / 28 steps).

## Rejected: one parametrised raymarch, delete the mirror
Attractive (one pipeline, 30-50% less cloud code), but:
- it removes the only deterministic CPU oracle used by the sweep/shell tests and CPU occlusion queries;
- it forces High's cost on every device and drops the lazy-built Standard path;
- GPU golden images alone are weaker regression protection than the current Monte-Carlo invariants.
Keep as a phase-2 option: if telemetry shows High is affordable everywhere, collapse tiers into presets of one shader after step 4 is in place (the config makes this a small change).

## Migration
config -> generated constants -> module split -> parity tests -> budgets. Each step independently shippable; golden captures (three orbit views) at each.

## Risks
Shader-generation drift; timestamp-query availability; accidental visual change in High. Fallback: Standard.

## Success
Same sweep/shell invariants, no per-tier NaNs/seams, no duplicated cloud literals, budgets enforced.
