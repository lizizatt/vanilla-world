# Design: far shader and transition to near

Status: recommendation (no code changed). Inputs: `space.js`, `globe-patches.js`, `height-bake`, `tile-registry`, `far-stream`/`far-worker`, `renderer-terrain.js`, `renderer-sky.js`, `HARDENING.md` (M5b), `GLOBE-REFACTOR.md`.

## Recommendation (now): two paths, one owned seam
- `terrain-transition.js` is the sole owner of the named ranges (`BEND_RANGE`, `GLOBE_RANGE`, `SPACE_RANGE`) and the crossfade ramps. It returns one `TransitionUniforms` struct (altitude, bend weight, far weight, shared radius/frame, fog/grade, seam version). `space.js` and the near terrain shader both consume it; `PLANET_RAMPS` leaves `space.js`.
- Shared WGSL snippets (ramps, planet-frame conversion, depth conventions, fog/grade) imported by both shader generators.
- `tile-registry`/WDL/height-bake remain the far data authority, `terrain-stream` the near residency authority; the transition module decides weights only.
- Visual regression checkpoints: low altitude, bend/globe overlap, authored-tile edge, open sea, limb, Maelstrom.

## Long-term (gated): unified patch tree
Debater A's target (one lat/lon patch tree whose leaves carry ADT/WDL/procedural height; delete bend shader and analytic terrain sphere) is the right end state, but not now:
- the baked height map is about 130 yd/texel vs 4 yd ADT relief (M5b blocker);
- estimated 15-22 days and brings cracks/LOD/streaming/precision risk and reversed-Z coupling.
Adopt it only after authored height uploads exist in `globe-patches` (step 3 below proves it) and the seam captures are green.

## Migration
1. Centralise constants and uniform packing in `terrain-transition.js`.
2. Route both shaders through it; match fog/colour/depth/height at the seam using existing registry data.
3. Prototype authored-height uploads in `globe-patches` behind a flag.
4. Only if step 3 meets metrics (patch GPU <= 1.5 ms, ~200-400 live patches, no cracks): native sphere mapping for near leaves, delete bend and analytic terrain sphere.

## Risks
Two shader paths keep some duplication and the roughly 8% bend-vs-globe mapping difference until step 4. Mitigate with shared snippets and seam captures.

## Success
No seam pop or colour step, ADT detail preserved, bounded far-worker latency, constants defined in one place.
