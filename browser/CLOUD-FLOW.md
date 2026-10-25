# Worldwide cloud flow model (proposal)

Status: proposal only. No renderer code changed. Numbers are estimates from reasoning and published figures, not measurements.

## 1. Goals and constraints

- A globe-wide cloud field whose structure reads as Earth-like from orbit: banded belts, a tropical convergence line, mid-latitude comma/frontal swirls, calm subtropical clear zones, and no ugly stretching toward the poles.
- The **Maelstrom stays permanent**, at its fixed world location, and its influence diffuses outward as spiral bands and a cyclonic wind anomaly.
- Flow is shaped by planet rotation (Coriolis, global cells) and by land vs ocean from the tile registry.
- Hosted build has **no WoW data**: it must work from the procedural registry (`proceduralProvider`, `FALLBACK_RECTS`) alone. Real ADT data only refines it.
- Budget: WebGPU only (as today). Must not add a pass that costs more than ~0.3 ms on an iGPU at 1080p, and CPU work must stay under ~1 ms/frame.
- Deterministic (seeded) so Monte Carlo tests are reproducible. Radius 42,785 yd; 1 unit = 1 yd.

## 2. How clouds work today

- `clouds.js`: one fullscreen-triangle ray march (`NS=8` Standard, 28 High) through a 520 yd slab at ~1577 yd. Density is analytic value noise (`sheetDensity`), no textures. Funnel is a second 14-step cylinder march.
- Spherical shell (now the only path, constant `SHELL_CURVATURE = 1/R`): the `SHELL_CURVATURE` uniform and the `cloudUniform` frame (`planetFrame` east/up/south + `WORLD_CENTRE` + `PLANET_RADIUS`) map the ray onto an **equirectangular lat/lon** coordinate (`theta = arc/(k*R)`), so the noise is sampled in (lon, lat) space.
- The Maelstrom is a *static analytic* decoration (eye, eye wall, 3 arms around `maelstromCentre(manifest)`) layered on the noise; nothing flows. `cloud-march.js` is a pure-JS mirror used by `clouds-sweep.test.mjs` (seeded Monte Carlo over eyes/rays/time) and `clouds-shell.test.mjs` (shell roots, extent, orbit continuity).
- `space.js` fades `clouds` by altitude; `tile-registry.js` exposes `surfaceTexel`/`bakeSurface` (height, water) which is the only land/ocean source.

**Why the poles look wrong:** noise is isotropic in (lon, lat), but one degree of longitude shrinks by cos(lat). Features pinch into vertical streaks converging at the poles, and the noise has no notion of flow direction or latitude bands, so there is nothing "meteorological" to see.

## 3. Candidate architectures

### A. Analytic flow field (no simulation)
Closed-form wind u(lat,lon,t) = zonal belts (easterly/westerly/easterly) + Maelstrom vortex + land perturbation from a baked mask; clouds are noise **advected by the field via domain warping** (curl noise + two-phase flow-map blend, Valve style).
- Pros: no sim, no state, trivially deterministic, hosted-safe, cheap.
- Cons: cannot make real fronts or persistent wakes; land effects only as a static warp.
- Cost: CPU ~0; texture 1 static 512x256 RG16F wind map (0.5 MB, baked once, ~5-10 ms at load); GPU +0.05-0.1 ms (two extra samples + warp).

### B. Coarse advected-density simulation on a cube-sphere (stable fluids)
6 faces x 128x128 (or 6 x 256^2) grid of density + moisture. Each step: semi-Lagrangian advect, diffuse, inject sources, relax toward a climatological target. Wind from A (plus buoyant/pressure effects optional). GPU compute render of 6 layers.
- Pros: genuine evolving flow, Maelstrom wake spreads and wraps, no pole singularity, land blockage emergent.
- Cons: state to manage (save/load, hosted resync), numerical diffusion, face-seam sampling, compute pass + more code; non-deterministic across GPUs unless fixed-step CPU.
- Cost: GPU compute 6x128^2 = 98k cells/step, ~0.05-0.15 ms/step, 1-2 steps/s is plenty (clouds move slowly); textures 6x128^2 RGBA16F = ~1.5 MB (x2 ping-pong). CPU ~0.
- CPU-only fallback: the same grid in JS ~98k cells x ~40 flops ~ 3-5 ms/step, at 1 step/s amortised ~0.1 ms/frame (but upload cost).

### C. Precomputed seasonal/day-cycle cloud-coverage atlas
Offline (or load-time) bake N keyframes of density on an octahedral or cube map, then loop and cross-fade with flow-map warping.
- Pros: best look control, tiny runtime.
- Cons: no live Maelstrom feedback, large asset (e.g. 8 frames x 512x512 = 8 MB) or a baking pipeline; looping is visible when looking for it.
- Cost: GPU ~0.1 ms; CPU ~0.

## 4. Recommendation: A at runtime, with a B-lite upgrade path

Ship **A on a cube-sphere/octahedral flow texture**, and treat B as an optional second stage only if A reads as static from orbit. A gets 80% of the visual win (banding, spiral Maelstrom, pole-correct stretching) for ~0.1 ms with no state. Both A and B share the same wind field and source model, so B reuses A's work.

### Wind model (the Earth-inspired part)
Per latitude φ (hemisphere-symmetric, flipped Coriolis sign across the equator):
- Hadley cell: surface **trade winds** 0-30° blow toward the equator with a westward component (easterly); **ITCZ** convergence band near the thermal equator where cloud coverage is boosted.
- Ferrel cell 30-60°: surface **westerlies** (eastward), storm-track bands of comma-shaped cloud with higher coverage.
- Polar cell 60-90°: **polar easterlies**, thin stratified cloud; 30° and 90° are subsiding/clear bands.
- Define u_zonal(φ) as a smooth sum of three cosine-lobe bands and v_merid(φ) from cell mass continuity; scale the whole thing by one constant so a 100 s cloud drift is visible from orbit.
- The sign convention follows Coriolis: low-pressure whirl is counter-clockwise in the north, clockwise in the south (existing code already chooses CCW for the Maelstrom in the north; keep that).

### Land/ocean from the registry
Bake once from `bakeSurface` into a low-res mask M(lat,lon) in [0,1] (1 = land, blurred ~1°-2° to give coastlines) plus a smoothed height H:
- **Land-sea contrast:** land dries and breaks up cloud (coverage x (1 - 0.35 M)) in the interior, coastal convergence adds a thin band along windward coasts (use gradient of M dotted with the wind).
- **Orographic lift/blocking:** add a wind deflection -k * max(0, u . grad H) * normal and a coverage boost on windward slopes (lift) with rain shadow lee (decay), using the smoothed H gradient.
- **Roughness/drag:** reduce wind speed over land by ~25-40%, which makes wakes and swirls form at coasts when advected.
- On the hosted build the registry is procedural (`FALLBACK_RECTS` + noisy coastlines) so the same bake works with no data; with ADT data the mask simply gets richer.

### Maelstrom as a pinned vortex source
- Treat the Maelstrom as a **Rankine-like vortex** (solid-body rotation inside the eye wall, ~1/r decay outside) whose centre is `maelstromCentre(manifest)` converted to lat/lon. Its tangential speed uses a fixed strength that is **added to the wind every frame** and never advected away. It is a source term, not state, so it cannot drift or decay.
- Inflow spiral: add a radial component toward the centre (angle of ~20° off tangential) so streamlines spiral in like a real cyclone's bands.
- Density source: constant injection ring at the eye wall radius and spiral arms, plus a persistent cloud-free eye. In A this is the existing analytic arms, but now warped by the same flow; in B it is a fixed source/sink in the grid so moisture is re-seeded every step.
- Diffusion outward: far-field wind anomaly falls off with a smooth kernel (e.g. exp(-r/R_far), R_far ~ 8-12k yd), so the planet sees a cyclonic perturbation that merges into the Ferrel westerlies; it is blended into the global field rather than cut off.
- Keep existing eye/wall/funnel shapes untouched so the near-field look and funnel march are unchanged.

### Pole handling
- Do **not** sample noise in (lon, lat). Sample 3D noise at the unit-sphere direction (x,y,z), or use a **cube-sphere** (6 faces) or **octahedral** 2D map for any stored texture. 3D noise at the direction is isotropic everywhere and has zero singularity.
- Advect in the tangent frame: wind is stored as an east/north vector but converted to a 3D tangent vector, and the flow-map warp offsets the sample direction on the sphere (rotate by small angle), never in lon/lat. Near the poles east/north degenerate; fade zonal speed to ~0 above 80° and use a vector field defined directly from the pole axis (tangent = axis x position) there.
- The stored wind and mask textures use an octahedral map (single 2D texture, bilinear friendly except at the fold, mitigated with a 1-texel border), or a 6-face array if we choose B.

### Rendering integration
- `cloudUniform` gains: a wind/mask texture (RG16F + R8 on octahedral 256x256), a time phase for two-phase flow blending, global strength. The shell march keeps its geometry; only the noise lookup point is replaced by `warp(dir, t)` (two flow phases p0, p1 offset by half a cycle, blended by a triangle wave to hide the reset; cost = 2x noise taps).
- Coverage is `coverage(φ, M, H)` times the noise; Maelstrom arms read in the same warped space.

## 5. Milestones (small, testable)

1. **Pure-JS wind model** (`cloud-flow.js`, no GPU): `wind(dir)` for zonal belts + Coriolis sign; unit tests on belt signs at fixed latitudes.
2. **Sphere-safe noise:** replace (lon,lat) noise with 3D-direction noise in `cloud-march.js` mirror; test pole stretch metric (below).
3. **Maelstrom vortex term** as an additive source; test pinned position, circulation sign, decay.
4. **Registry bake:** `bakeLandMask(registry,size)` -> mask + gradient H; test coastline response on procedural registry.
5. **Flow-map warp** in the mirror and WGSL (two-phase blend); test continuity in time (no jump at phase wrap).
6. **GPU wiring:** texture upload + uniform; golden-image check at 3 orbit poses (existing `race-clouds-*.mjs` scripts).
7. *(Optional)* B-lite sim at 128^2 per cube face behind a flag if A looks static.

## 6. Tests (Monte Carlo, same style as the cloud sweeps)

Seeded `rng`, N=3000 random samples each, run inside `node --test`, no GPU:
- **Finite/in-range:** random positions and times: wind finite, |u| <= vmax, coverage in [0,1], no NaN at the poles.
- **Belt signs:** for random lats in the trade/Ferrel/polar bands, mean zonal component has the expected sign in both hemispheres; Coriolis mirror symmetry between hemispheres within tolerance.
- **Pole isotropy:** at lat in {0, 45, 80, 89} compare the noise's mean absolute gradient along east vs north on the tangent plane; ratio must stay within 0.8-1.25 (today's lon/lat noise would fail, so this proves the fix).
- **Maelstrom pinned:** for 1000 random times/seeds the vortex centre equals `maelstromCentre`; circulation near the eye has the northern-hemisphere sign; speed profile is monotonic out to the wall then decays; far field returns to base wind within a tolerance.
- **Land response:** with a procedural registry, mean coverage over interior land < mean over open ocean at equal latitude; windward-slope coverage > leeward; wind speed over land < over ocean.
- **Temporal continuity:** two-phase warp: change in sampled density across a phase wrap is below a bound; sweeping t over random starts never produces a jump.
- **Shell compatibility:** re-run `clouds-shell.test.mjs` and `clouds-sweep.test.mjs` unchanged to prove existing geometry/occlusion guarantees still hold.

## 7. Hosted fallback (no data)

All of A runs from the procedural registry: mask from `FALLBACK_RECTS` with noisy coastlines, no heights beyond the procedural provider. Cost of the bake: a 256x256 octahedral evaluation of `surfaceTexel` ~65k calls ~ 5-15 ms once at load. If the manifest changes, re-bake. No network assets are required.

## References

- Hadley/Ferrel/polar cells: https://en.wikipedia.org/wiki/Atmospheric_circulation ; https://www.noaa.gov/jetstream/global
- Trade winds, westerlies, polar easterlies: https://en.wikipedia.org/wiki/Trade_winds ; https://en.wikipedia.org/wiki/Westerlies
- ITCZ: https://en.wikipedia.org/wiki/Intertropical_Convergence_Zone
- Coriolis effect: https://en.wikipedia.org/wiki/Coriolis_force
- Orographic lift: https://en.wikipedia.org/wiki/Orographic_lift
- Tropical cyclone structure, spiral bands: https://en.wikipedia.org/wiki/Tropical_cyclone ; Rankine vortex: https://en.wikipedia.org/wiki/Rankine_vortex
- Stable Fluids (Stam 1999): https://www.dgp.toronto.edu/public_user/stam/reality/Research/pdf/ns.pdf
- Curl noise for procedural fluid motion (Bridson et al. 2007): https://www.cs.ubc.ca/~rbridson/docs/bridson-siggraph2007-curlnoise.pdf
- Flow maps (Valve, "Water Flow in Portal 2", SIGGRAPH 2010): https://advances.realtimerendering.com/s2010/Vlachos-Waterflow(SIGGRAPH2010).pdf
- Horizon Zero Dawn clouds (Schneider): https://advances.realtimerendering.com/s2015/The%20Real-time%20Volumetric%20Cloudscapes%20of%20Horizon%20Zero%20Dawn%20-%20ARTR.pdf
- Microsoft Flight Simulator clouds/weather overview: https://www.flightsimulator.com/ (developer blog posts on weather)
- No Man's Sky atmosphere/clouds talks: https://www.gdcvault.com/ (Innes McKendrick, procedural world generation)
- Cube-sphere and octahedral mapping: https://en.wikipedia.org/wiki/Quadrilateralized_spherical_cube ; Cigolle et al., "A Survey of Efficient Representations for Independent Unit Vectors": https://jcgt.org/published/0003/02/01/
- Sphere-safe noise on the sphere (3D noise at direction): https://iquilezles.org/articles/fbm/

Sources are cited for ideas only; no code was copied. Specific URLs for the MSFS and No Man's Sky items are landing pages/talk indexes, not verified deep links.


## Implementation notes (as built, M1-M6)

Deviations from the proposal:
- Sine-free `hash3` plus 3D value noise sampled at the planet-sphere position (`sphereAt`) replaces the octahedral texture; poles are isotropic by construction (tested).
- The land mask is an equirect 256x128 RGBA8 baked from the tile registry (procedural fallback, no WoW data needed), re-baked only when continent rects change (`CloudMask` in clouds.js).
- Land effect is additive coverage (`landCoverage`, x(1-storm)) plus wind drag (`landDrag`), not a multiplicative modifier.
- Flow-map blend window is [.4,.6] of the triangle wave, so the second phase is sampled ~20% of the time.
- Sweep tests: alpha-vs-march tolerance .32 (step aliasing); horizon test skips eyes within the polar degenerate zone.
- M7 (B-lite fluid sim) skipped: the two-phase warp plus the pinned vortex animates clearly, the field is not static.

Results: `node --test browser` 549 pass / 0 fail; drive gate handler p99 2.3 ms (max 5); render p99 < 8 ms; far-orbit captures at poles, Maelstrom and equator show no pinching.