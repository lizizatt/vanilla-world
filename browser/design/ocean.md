# Design: ocean waves and an improved water shader

Status: proposal, **revision 2 (gameplay waves)**. No code changed. Revision 2 supersedes the "visual-only sea" recommendation (B0/B1) and the phase table in 2(e): see section 3 (requirements and decisions) and sections 4-9. Sections 1-2 remain as the survey of what exists and of shading options. Inputs read: `ocean-mesh.js` (+ test), `water-shader.js` (+ test), `water-stream.js`, `renderer-shaders.js`, `renderer-terrain.js`, `renderer-events.js`, `renderer-init.js`, `camera-collision.js`, `cloud-config.js`, `pole-cap.js`, `polar-light.js`, `space.js` (bend, globe sea), `particles.js` (wake/ripple), `weather-config.js`, `design/{weather,poles,elune,clouds,memory-budget}.md`, README "Authored distant water" / "Shared shoreline water shader", and Rust `voyage.rs`, `flats-racer-web/src/water.rs`. Game data is read at runtime only; nothing derived from it is committed. Numbers in yards (yd).

## 1. What exists now

### Geometry
- **Open sea** (`ocean-mesh.js`): a flat mesh at `manifest.sea_level` (0), padded by `OCEAN_FILL` = 3.04 R per side (renderer-events.js:16). 7 floats per vertex (pos, normal, material 2). Cut into `OCEAN_CELL` = 1250 yd cells **because the vertex shader bends the flat chart onto the globe**; one big quad would bend as a chord and dip under the planet. Cells touching a loaded land tile are split `SUB`=5 and cut where `coversLand` so below-sea land is not flooded. Neighbours of split cells get fan edge vertices to avoid T-junction cracks. `oceanMeshCached` memoises on inputs (4 entries); `refreshOcean` rebuilds at most 1/s when land rects change.
- **Maelstrom bowl**: when the whirlpool centre is inside the ocean the mesh contains a dense `cells`=96 square patch (side 2R = 3600 yd) displaced by `dipDepth` = `380*(1-(r/1800)^2)^2` yd, with analytic normals. `WHIRLPOOL_DIP` in `cloud-config.js` is the single source and mirrors `whirlpool_dip` in Rust (`voyage.rs set_whirlpool`), so **this is the only wave-like geometry, and it is physics-real**.
- **Authored water**: `WaterStream` (water-stream.js) streams one ADT at a time, builds "distant water" (MCLQ Ocean/Still, simplified in `water.rs`, 64 MiB `COAST_GPU_LIMIT`), `deepOceanBacking` fills authored-dry ocean cells, exterior ocean tiles come from Rust `exterior_geometry`. Detailed tile water (MCLQ lakes) and WMO MLIQ canals use the **same** shader (material 2 = ocean, 4 = coast/ramp). All flat quads at authored heights; no wave displacement anywhere.
- **Coast ramp**: authored vertex "ramp" value rides in `v.n.x` (`select(1.0,v.n.x,v.n.z>.5)`), `rampWidth=fwidth(ramp)`. Shore colour/foam fades to deep over 350-700 yd. This is not depth-buffer based: there is no scene depth read in the water fragment.
- **Racetrack basin**: the Steamwheedle raceway is below sea level but is land. Land tiles carve the ocean fill (`coversLand`, README 738 and camera-collision.js:120 "dry basins like the track have none"), so no water is drawn there; there is no flooded basin and nothing for waves to do. Waves must keep honouring `coversLand` cuts.
- **Polar**: `pole-cap.js` is a procedural ice shelf (1.09-10.94 yd above sea, `seabed` -12 yd, ice foot `rampRun` 110 yd) with small bergs (`bergBand` 547 yd, radius 6-25 yd, top 1-6 yd). Surrounding water is the same open-sea mesh; seabed shallow colour `[.2,.32,.42]` shows through (pole-cap.js:76). Polar lighting is a fixed twilight (`NORTH_TWILIGHT` -0.02 sine).
- **Elune**: airless moon; no ocean. Only graft water is Moonglade (Lake Elune'ara, elune.md:216) via `water-stream`/`set_scene_water` as an ordinary lake. Moons use their own regolith globe shader.
- **Globe from orbit**: `space.js` `surfaceSea` shades the sea on the globe mesh (same deep/shallow colours as the water shader, "no colour step at the loaded-tile edge"). The bend (`bend()`, `waterBendK()`) bends water to the sphere; above ~0.85 bend, the shader replaces flat up/view with spherical ones to stop stripes.

### Shading (`water-shader.js` `waterColor`)
- **Normals**: one 128x128 tileable value-noise normal map (3 bands, 4/8/16 cells, 8 mips, `waterNormalMips`, 87,380 B, deterministic, sampled `textureSampleGrad` with analytic derivatives). Two taps at scales 64 and 32 yd, scrolled at ~0.012 yd/s units, ripple amplitude `*.9*detail` where `detail = 1-smoothstep(160,1500,dist)`. So the sea is **flat and glassy beyond ~1500 yd, with ripple aliasing/moire reported in the README (185, 886)**.
- **Sky reflection**: not the real sky. `reflect(-view,normal)` selects a 2-stop gradient: game sky colours `u.sky[2]`/`u.sky[3]` (horizon/zenith from Light bands) or a fallback blue; no sun disc, clouds or stars are reflected. Clouds are a separate ray-march pass composited after (`renderer-sky.js:107`, `cloudMask`), so the water never sees them.
- **Fresnel**: Schlick `.02+.98(1-n.v)^5`; body colour mixes teal (.09,.43,.39) to deep blue (.025,.18,.29) by authored ramp depth (`1-exp(-4.5 d)`), forced to deep beyond 350-700 yd. No refraction, no depth-buffer absorption, no transparency (opaque, `alpha=1`).
- **Specular**: Blinn-style `pow(n.h,40)*.4` with a **hard-coded sun direction (-.3,1,.4)**, not the real sun `u.pad[1]`; fades with `detail` and night.
- **Foam**: only a band at the authored shore ramp (`depth` .015-.09 with a slow `lap` sine). No crest foam, no wake foam (the craft's spray/wake/ripple rings are CPU particles, `particles.js:191`).
- **Night**: `nightK()` multiplies colour by ~.35 and sky by dark blue; `grade()` applies game light tint. Fog: `max(distance/150000 clamp .93, valleyHaze)`, `limbGlow` at the limb.
- **Caustics, subsurface scattering, underwater view/fog, wetness, rain ripples: none.** Camera collision keeps the camera above the sea surface (`camera-collision.js waterSurface`: sea height minus whirlpool dip plus clearance), so there is no underwater view at all today.
- **Maelstrom shading**: when `u.sky[3].w` is on, the shader rotates the sample coordinates by a radius-dependent twist (wk), adds a bowl-wall slope boost, darkens the pit, a black core and log-spiral foam arms (`W.arms`=4, `pitch`, `spin`). The cloud funnel (`FUNNEL`, `MAELSTROM` in `cloud-config.js`, scaled by `STORM_SCALE`=.4) rises from the dip bottom; funnel is in the cloud march, not in the water pass.

### Physics (Rust, flat chart units)
`sample_at(p)` returns `ground` and `water` heights. Open ocean branches use `sea_height(p) = sea_level - whirlpool_dip(p)` (voyage.rs:252). Authored ADT water and WMO canal water (`set_scene_water`) are max-combined with ground. The pod/craft rides the water surface as a hover/skim vehicle (README 531: water contact is a feel edge, not buoyancy). **The surface is a pure analytic function of (x,z), with no time term.** Adding a time-varying height to physics would add a clock/determinism dependency to the sim.

### Budgets and tests that constrain us
README tracks p99 handler < 20 ms and the frame; 64 MiB distant-water cap, 8 MiB per liquid payload (`validLiquidGeometry`: exactly 21 floats per triangle, y free, normal fixed (0,1,0), material 2/4). Existing guards: `ocean-mesh.test.mjs` (dip profile, vertex layout, crack-free cells), `water-shader.test.mjs` (normal mips deterministic, byte size, shader text), `water-stream.test.mjs`, `water-smoke.mjs` (real Edge shader execution + screenshots). Weather: `weather.js`/`weather-config.js`, design/weather.md (4.3 "wetness and ripples" planned: `wet`, `snow` uniforms, ripples on water, `<= .1 ms`); `particles.js` already has `ripple` and wake.

## 2. Options

### (a) Wave geometry

| Option | What | Cost | Fits our engine | Verdict |
|---|---|---|---|---|
| A0 Normal-map only (today, better) | Keep flat plane; improve normals only (b) | ~0 verts | Perfect: no mesh/physics change | Baseline; silhouettes stay flat |
| A1 Sum-of-sines / Gerstner vertex displacement | 4-8 directional waves (wavelength 12-200 yd), analytic displacement + analytic normal, in the water vertex shader; steepness gives sharp crests | ALU only; needs vertex density | Needs a vertex grid fine enough: 1250 yd cells are far too coarse. Needs a camera-centred mesh | **Recommended for geometry** |
| A2 FFT (Tessendorf) cascades | 2-4 256^2 / 512^2 cascades (e.g. 20 / 100 / 500 / 2000 yd tiles), compute FFT each frame, displacement + slope + foam (Jacobian) textures; Sea of Thieves/AC/Crest/HDRP/UE Water | 3 compute passes x cascades (~0.4-1.2 ms GPU on mid hardware for 2x256^2), 2-4 rgba16f textures, WebGPU compute | WebGPU yes; but the engine is a render-bundle renderer without a compute path today; textures must be sampled in the VS (supported) | Best realism, wrong fit now; Phase 3 |
| A3 Projected grid / clipmap | Camera-locked polar or concentric grid in view space, displaced by A1/A2 | ~64-100k verts constant | Conflicts with bend: bend wraps the *flat chart* position, so grid vertices must be reprojected to chart (x,z) first, then displaced, then bent. Doable: grid in the chart plane, snapped to a world lattice | Needed by A1 at any scale |

**How it fits bend/tiles/curved bodies.**
- Waves are generated in **chart space (x,z,t)** *before* `bend()`: `p.y += h(x,z,t)`; `p.xz += gerstner horizontal` ; then `bend(p-eye, ...)`. Bend already handles the sphere; displacement is small (<= 8 yd) against R=42,781 so no bend change is needed. `localNight`, `limbGlow` use `v.p` and are unaffected.
- The wave **phase must use absolute chart coordinates** (`world = p.xz + (u.right.w,u.up.w)` already encodes floating-origin offset, water-shader.js `waterColor`; README 816 says phase is retained across origin changes). Reuse exactly that.
- **Mesh**: replace "flat 1250 yd cells" for the **near disc only** with a camera-centred snapped clipmap (e.g. 5 rings of a 64x64 grid, vertex spacing 1, 2, 4, 8, 16 yd... up to ~1 km, then the existing 1250 yd cells which stay flat and use normal-map detail). Rings snap to multiples of their spacing in chart coordinates, so the same vertex sits at the same chart position frame to frame (no swimming), and a geo-morph band blends the ring outer edge to its parent grid height to avoid cracks. This **coexists** with `oceanMesh`: the old mesh is kept (clipped by a disc mask: fragment/vertex discard, or the near ring simply overdraws at equal height with a depth bias; the clean way is cutting a hole in the far mesh around the camera in the VS by collapsing triangles whose centroid is within the near radius).
- **Land cuts**: the clipmap must respect `coversLand` (loaded tile rects carve the water). Cheapest: pass the land-rect list as a small uniform/storage array (rects near the camera, <= 16) and collapse/discard fragments inside land (`discard` in FS using the exact rect test, the VS keeps flat there). Coast tiles (authored MCLQ water) stay un-displaced and **fade the wave amplitude to zero over ~50-100 yd approaching a shore (ramp value r)** so lake/canal/coast water, which is authored at exact heights and physics-rideable, is not distorted. Amplitude scale: `ampK = smoothstep(.0, .06, ramp)` for authored water (reuse the `v.n.x` ramp), 1 for open-sea material 2.
- **Distant sea**: no geometry waves beyond ~1-2 km (they're sub-pixel); use A0 normals plus roughness-from-slope (Toksvig/LEAN style: average slope variance is stored per mip so far water becomes duller/broader highlight instead of aliasing; this directly cures the moire in README 185/886).
- **Normal maps for far detail**: keep the 128^2 tile but add a second, higher-frequency, **animated 2-layer** map and, for A1, an analytic-normal term plus the map as a detail bump. Optionally precompute (JS, deterministic like `waterNormalMips`) a 256^2 RG16 slope+foam-seed map so no binary asset ships.
- **LOD pop control**: geomorph per vertex by distance; amplitude of each wave is faded when wavelength < 2x local vertex spacing (it is the sum-of-sines analogue of band-limiting), moving that energy to the normal map.

**Buoyancy / physics.**
| Choice | Pros | Cons |
|---|---|---|
| B0 Visual-only waves (**superseded in rev 2: waves must now collide; see section 4**) | Physics stays the analytic `sea_height`, no time term, determinism/replay/ghost unaffected, no Rust change, shared-flight and saves unaffected, p99 unchanged. Pod already hovers; mismatch <= wave amplitude | Craft can visibly clip a crest by up to amplitude (~1-3 yd) or hover above a trough |
| B1 Render-side compensation | Pod *visual* model gets a smoothed vertical/pitch/roll offset from sampling the same Gerstner on CPU (JS `wave-math.js` shared with the shader), applied to the **rendered** pod pose only (like the existing chase-camera smoothing), physics untouched | Needs a CPU mirror (parity test, like `cloud-march.js`); small extra code. Good, cheap, and invisible to physics |
| B2 Physics buoyancy | Real wave riding | Rust change (`sea_height(p,t)`), time into sample_at, desyncs saves/replays/shared flight, breaks the authored-water max rule (ground vs water), and flat chart units make wave steepness slope-forces dubious. Not worth it for a hover racer |

Shoreline: pod/shore interaction stays as today (authored shore, physics `water` height = flat). With A1 we fade amplitude to 0 at land cuts, so no ridge intrudes into the shore or the carve. Camera: `waterSurface` clearance may add `ampMax` (a few yd) so the camera never dips under a crest (the one visible physics-adjacent change; JS only, in `camera-collision.js`).

### (b) Shading

| Feature | Option | Notes / cost |
|---|---|---|
| Reflection source | **S1 Analytic sky + sun + cloud proxy (recommended first)**: reflect vector indexes the same Light-band colours, adds the *real sun* disc/glow from `u.pad[1]`, and a cheap cloud term | ~10 ALU. Fixes the hard-coded sun direction and gives sun glints; clouds as a 2D noise proxy matching `sheetDensity` coverage so storm decks darken the horizon reflection |
| | S2 Cloud-march reflection: re-march the real cloud pass along the reflected ray at low steps (4-6) | Accurate; the cloud march is the heaviest pass, and water covers most of the screen: only on High tier and only for rays heading skyward within a distance band; or sample the **already rendered sky/cloud buffer** mirrored about the horizon |
| | S3 Planar reflection | Second scene render; engine is bundle-based and bent globe has no single plane. **Reject** |
| | S4 Screen-space reflection of the scene (terrain/pod near coasts) | Needs a colour/depth copy; ~0.5-1 ms. Useful for the pod/props at the shore; High tier only, later |
| | S5 Sky probe / env cubemap | Small (64^2x6) cube re-rendered at low rate from the sky model, sampled with roughness mip; best balance for cloud-lit reflections, cost amortised (1 face/frame). Needs a render-to-cube path (does not exist). Phase 3 |
| Refraction / absorption | Depth-based absorption needs scene depth. We have `r.depth` bound in the sky pass, but water is drawn in the terrain pass. Option: **R1** keep authored-ramp depth for coasts (shipping) and add *analytic depth from the pole/terrain seabed only where cheap*; **R2** copy depth/colour before water (an extra pass, forbidden on Standard) and read it for true depth-fade, refraction offset and shore foam | R2 is the "AAA" path. Recommended: R1 now (works everywhere, no pass), R2 as a High-tier option; since the world mostly has opaque deep sea, little is lost |
| Colour | Beer-Lambert with 3 coefficients from a per-region "water type" (tropic teal, deep blue, polar grey-green, storm dark) driven by the Light band so it matches the game's sky; replace the 2-colour mix | 6 ALU |
| Foam | **F1** crest foam from wave "Jacobian"/steepness (analytic for Gerstner: `1 - det(J)` of the displacement) thresholded and broken up by a noise texture, plus whitecaps scaled by wind; **F2** shore foam stays ramp-based (already there) and later depth-based under R2; **F3** wake foam: render the pod wake into a small camera-centred foam map (RG8 256^2) that decays; the pod's `particles.js` wake can feed it | F1 trivial with A1; F3 optional and cheap (one quad per frame) |
| Sun glint | Use the real sun and a GGX-ish lobe with roughness from the slope variance; add the long streak toward the sun low on the horizon; fade by cloud cover (S1 term) and `nightK` (moon light on water at night, scaled by moon phase if the time system exposes it) | ~8 ALU; fixes "hard-coded sun" |
| Subsurface scattering | Cheap SSS term: bright teal at wave crests when the sun is behind the wave (`pow(max(dot(view,-L),0),4)*crestHeight`), tinted by the absorption colour | 4 ALU; big visual win for 3D waves |
| Caustics | **None today.** Only meaningful in shallow water seen from above; with opaque water and no depth they cannot be placed. Option C1: analytic caustic *texture* projected onto the shallow seabed terrain shader (animated by sun and wave state) where `ramp` is small; C2 skip. Recommend **skip until R2 exists**, then 2 scrolled caustic taps at terrain shaders below sea level | Low value for a high-speed racer |
| Underwater view | Today the camera never goes under. If ever allowed (the Maelstrom pit?): exponential fog colour (absorption) + a surface "ceiling" pass with Snell window; separate fog uniform. **Out of scope; keep the clamp** | Document as non-goal |
| Wetness | The craft/pod surfaces wet with weather (design/weather.md 4.3): reuse the same `wet` uniform for a water-contact darkening (spray) | N/A to the water shader itself |

### (c) Interaction with weather, storms, polar, night

- **Wind-driven amplitude**: a single `windK` (0..1) from the weather/cloud system sets wave energy: `amp = lerp(.6, 3.0, windK)` yd (significant wave height 0.6-3 yd calm to storm, nothing like real storm seas, as the pod is a few yards and the scale of the world is 0.4 of normal), wavelength and steepness scaled with it, plus foam threshold lowered. Source: `windAt(x,z)` from `cloud-flow.js beltWind` (CPU and WGSL twin already exist, so wave direction follows the same planetary belts as the clouds: trade winds, westerlies) combined with the precipitation cell intensity from `weather-field.js`/`WEATHER` (heavier rain cell => stronger local wind). Treat as a single uniform plus per-fragment local lookup, not a texture.
- **Rain**: rain ripples are 4.3 of weather.md (rings on water under the near particle box). Cheapest: a procedural ripple normal layer in the water shader (hash-grid of expanding rings, 1-2 octaves), strength = weather `intensity`, only where `detail` is high. No particles. Surface darkens and loses glint under rain (sun term x (1-cloud), roughness up).
- **Storms/Maelstrom**: the dip bowl is the only physical wave feature; a bowl region keeps its **flat-chart analytic mesh** (dense patch, 96 cells) and the new wave displacement should *add* on top (fade amplitude to ~35% inside `DIP_R` so the walls stay readable), with the swirl of coordinates already in `waterColor` applied to the normal map layer. Add an outer "storm sea" ring: wave amplitude x2 and foam streaks along the spiral inside `MAELSTROM.radius` (9600 yd), keyed off `wk`. The funnel/clouds are untouched. Physics keeps `whirlpool_dip` (single source: `cloud-config.js`).
- **Polar ice shelf water**: calm, nearly flat, ice-flecked: wave amplitude scaled by latitude (`polarK`, e.g. down to 15% beyond 80 deg) plus "brash ice" noise darkening/whitening near bergs/shelf edge from `pole-cap.js` `bergHeight` proximity (the existing sample can drive a mask and a floating slush pattern). Water colour shifts grey-green; the shallow seabed colour already exists (`pole-cap.js:76`). The shelf and bergs themselves are terrain and untouched. Foam at the shelf edge uses the same ramp mechanism.
- **Night**: replace the global x.35 with a physically-motivated split: ambient sky reflection dim blue, sun term gone, **moon glint** (real moon direction when available from the time system), faint bioluminescence is a stylistic option (breaking wave foam emits dim cyan; off by default). Light pollution is not modelled.
- **Elune**: no ocean. Moonglade lake stays on the authored-water path with waves **disabled** (shared shader, material 4, `ampK`=0 by ramp and a `waterWaves` flag cleared on body switch), so the airless-body build never pays for it. Lakes elsewhere keep a gentle fixed amplitude (<=.15 yd) or flat.
- **Orbit/globe**: above ~2,000 yd waves are invisible; `space.js surfaceSea` already matches the water colours. Keep the **colour model shared** (one WGSL const used by both) so the new absorption/foam do not introduce a "colour step" at the loaded-tile edge; sun glint on the globe sea is cheap and gives the planet a nice specular highlight from space.

### (d) Budget, tiers, fallback, parity

- **Frame cost**: water covers up to ~50-100% of the pixels at sea. The current shader is ~60 ALU, 2 taps. Targets (mid GPU, 1080p): Standard +0.3 ms (extra vertex work on ~40k verts, 3 more texture taps, analytic sky/sun/foam); High +0.8 ms (FFT 2 cascades ~0.5 ms + S2/R2 options). p99 handler < 20 ms is unaffected on the worker side: **nothing in this design runs in the world worker or physics tick** (B0/B1); main-thread cost is a uniform write (`windK`, wave time) and, only in the clipmap phase, a once-per-origin-change mesh rebuild which must be **static** (the grid is vertex-shader snapped, so no per-frame JS mesh work; the `refreshOcean` 1/s path is unchanged).
- **Memory**: clipmap ~64-100k verts x 28 B ~ 2-3 MiB; FFT 2 cascades x 256^2 x (rgba16f disp + rgba16f slope) = 2 MiB; normal maps < 0.5 MiB; far under the memory-budget design's headroom (add a row to `memory-budget.js` estimates).
- **Quality tiers** (match the existing cloud `standard`/`high` tiers and weather tiers `off/low/standard/high`): `off` = today's shader exactly (flat, fixed normals) = the **fallback and the default until the feature is validated**; `low` = improved normals + analytic sky/sun + shore foam, no vertex waves; `standard` = low + Gerstner clipmap (4 waves) + crest foam + SSS; `high` = standard + FFT cascade(s) or 8 waves + S2 cloud reflection / SSR + R2 depth refraction and caustics-on-seabed. Auto downgrade on slow frames via the same mechanism used by weather/clouds.
- **WebGPU specifics**: FFT needs compute (workgroup memory, `rgba16float` storage textures); check features at init and drop to Gerstner otherwise. No `maxTextureDimension` or timestamp-query needs. Vertex texture fetch for FFT displacement is core WebGPU. Headless Edge SwiftShader paths run the Gerstner shader but FFT may be slow in CI: `water-smoke.mjs` should run at `standard` only.
- **Parity needs**: (1) wave function shared CPU/WGSL: a `wave-math.js` that emits the WGSL (`waveWGSL()` like `flowWGSL()`) and a CPU mirror used for the pod visual (B1), the camera clearance and tests, with a parity test against sampled GPU readback in `water-smoke.mjs` (tolerance ~1e-3 yd); (2) `WHIRLPOOL_DIP` stays the only physics wave; (3) `validLiquidGeometry` unchanged because waves are displaced in the VS, not baked into liquid payloads; (4) the ocean-mesh test (crack-free, T-junction fans) stays untouched since the far mesh keeps its shape; add clipmap invariants (snapped lattice, no overlap, geomorph ends equal parent height); (5) floating-origin: `(u.right.w,u.up.w)` phase stability test across an origin change.

### (e) Recommendation and phased plan (rev 1; the phase table below is superseded by section 8)

Recommend **A1 + B0/B1 + S1 + F1 + SSS + wind/rain hooks**, tiered, with FFT (A2) and S2/R2 as later High-tier upgrades. Rationale: a racer at 100-300+ yd/s over a 0.4-scale world needs readable crests near the camera and a calm, alias-free horizon, not a simulated ocean; sums of 4-8 Gerstner waves give crest shape, analytic normals, analytic foam and a CPU mirror (cheap to keep in step with the pod render), while FFT adds a compute path and texture plumbing the engine lacks for modest extra realism at this speed and scale.

| Phase | Scope | Files touched | Tests | Risk |
|---|---|---|---|---|
| 0 | Shader-only upgrade: real sun from `u.pad[1]`, GGX glint, slope-variance far-water roughness (kills moire), analytic sky + horizon haze, Beer-Lambert colour, SSS stub, night/moon colour, `waterQuality` uniform (`off` = bit-identical to today) | `water-shader.js`, `renderer-shaders.js`, `body-shaders.js` (shared colours), `space.js` (globe sea colour sharing) | `water-shader.test.mjs` (WGSL compiles, off path unchanged), `water-smoke.mjs` screenshots | Low; sun uniform plumbing |
| 1 | Near clipmap + Gerstner VS, amplitude fade at land cuts and shore ramp, polar/Maelstrom modulation, crest foam, Maelstrom overlay | new `ocean-clipmap.js`, new `wave-math.js` (CPU mirror + WGSL emitter), `ocean-mesh.js` (hole in the near disc), `renderer-terrain.js`, `renderer-shaders.js`, `water-shader.js`, `camera-collision.js` (clearance += amp) | `wave-math.test.mjs` (parity, continuity, band limits), `ocean-clipmap.test.mjs` (snap, ring crack-free, geomorph), `ocean-mesh.test.mjs` unchanged, smoke from orbit/shore/bowl | Medium: cracks at ring seams and near-land cut; floating-origin phase; bend interplay at high altitude (disable above regime atmosphere) |
| 2 | Weather coupling: wind direction/amp from `beltWind` + weather cell, rain ripples, wetness-style darkening, storm sea ring; render-side pod bob (B1) | `weather-field.js`/`weather-wgsl.js` (`windK`), `renderer-weather.js` (uniform), `water-shader.js`, `pod-render-frame.js`/`pose-body.js` (visual offset), `particles.js` (spray scaled by wave) | CPU/GPU windK parity, rain-ripple determinism, pod visual offset bounded | Low-medium; depends on weather.md phases landing |
| 3 (optional, High tier) | FFT cascade(s) replacing Gerstner on High, cloud-aware reflection (S2 or probe S5), depth refraction (R2), wake foam map, caustics on shallow seabed | new compute module, `renderer-init.js` (feature gate), `renderer-sky.js` (reflection source), terrain shaders | WebGPU-feature fallback tests, perf gates in the streaming benchmark | High: compute path is new; costs; CI (SwiftShader) |

Each phase ships behind the quality tier and a settings flag (default `off` until the smoke gates and the p99/frame benchmarks match baseline), keeping the physics, saves and Rust untouched.

### Quick visual references (descriptions, no prototype rendered)
1. **Glassy to rough**: today's look is a glassy blue-teal plane with fine static grain near the camera. Phase 0 keeps the shape but replaces the dull sky gradient with a horizon-brightening Fresnel band and a long sun streak that breaks into glints toward the camera.
2. **Gerstner 4 waves**, crest spacing 25/60/130/300 yd, steepness .5: rolling swells with sharpening crests, foam only on crest tops in wind > .5; amplitude visibly 1-2 yd against a hover craft; the horizon stays smooth.
3. **Maelstrom**: wave amplitude ramps to 2x within the storm radius, but inside the 1800 yd bowl the displaced walls are dominated by the analytic dip; white foam arms follow the existing log-spiral; rain ripples sparkle under the storm.

### Open questions (rev 1; answered or superseded by section 9)
1. Is a **visual-only** sea acceptable (pod/chase camera may clip or hover a few yards from a crest), or do you want a gameplay-affecting sea (Rust change, not recommended)?
2. Preferred wave scale: calm stylised swells (<= 1.5 yd) vs dramatic storm seas (up to ~5 yd, would also need B1 bob and bigger camera clearance)?
3. Is a High-tier **FFT/compute** path worth carrying (Phase 3), or stop after Gerstner?
4. Underwater view, caustics and bioluminescence: confirm non-goals?
5. Should lakes/canals/coast water also move (small amplitude) or stay perfectly flat as authored?
6. Do you want waves on Standard tier by default, or opt-in until benchmarked?
7. Moon/sun glint at night: do we have a trustworthy moon-direction/phase uniform in the time system to use?

---

# Revision 2: gameplay waves, water-contact foundation, swell flight, wake and splash

## 3. New requirements and what they change

1. **Waves collide.** Shader, JS and Rust physics evaluate the same deterministic analytic Gerstner field. This **reverses rev 1's B0/B1 (visual-only) and B2 (rejected) choices**: B2 is now the plan, made safe by determinism (no simulation state, only a pure function of position and a shared clock).
2. **Foundation for a later sailboat mode:** a water-contact/buoyancy API (submerged samples, drag, wave normals). No boat is built.
3. **Vision:** jump off swells with the pod; crash into the side of a big wave if you fly badly.
4. **Higher-fidelity wake and splash** from podracer overflight.

Facts from the code that shape this (read for rev 2): the physics crate `client/crates/flats-racer-physics` is pure Y-up hover dynamics ("collision detection and position integration belong to the caller", lib.rs:1) with `HOVER_HEIGHT` = 1.1 and a support probe reach of `max(hover+0.8, SUPPORT_REACH)`; the surface the pod rides comes from `flats-racer-web/src/voyage.rs` `sample_at(p: [f64;2], body_y)` (line 259) and `sea_height(p)` (251); positions there are `f64`. `wreck.rs` is a debug-only crash proof of concept ("nothing in `step` or the race flow calls it"); durability/heat damage exists in lib.rs:22. Because the pod hovers 1.1 above whatever the surface is, **a wave behaves exactly like terrain to the existing hover spring**, and the amplitude budget is measured against the cushion, not against the pod's size.

## 4. Shared wave model (shader = JS = Rust)

### 4.1 Function
A sum of N = 4 (default; 6 max) Gerstner components i with direction `d_i` (unit, in chart xz), wavenumber `k_i`, amplitude `A_i`, steepness `Q_i`, angular frequency `w_i`, phase `phi_i`:

```
theta_i(x,z,t) = k_i (d_i . (x,z)) - w_i t + phi_i
horizontal displacement  Dxz(p0,t) = sum Q_i A_i d_i cos theta_i
height (at rest point p0) h(p0,t)  = sum A_i sin theta_i
```
Gerstner moves vertices horizontally, so the **surface height at a fixed world (x,z)** needs the rest position p0 with `p0 + Dxz(p0,t) = (x,z)`. Shader vertices are Lagrangian (they *are* p0, displaced), so the mesh needs no inversion. **Physics and the CPU mirror must invert**: fixed-point `p0 <- (x,z) - Dxz(p0,t)`, started at p0=(x,z), **exactly 3 iterations in all three implementations** (not "until converged", so results are bit-reproducible in structure). Convergence is guaranteed by the safety rule `sum Q_i k_i A_i <= 0.9` (the displacement map is a contraction, no looping crests), enforced when configs load and by test.
Analytic normal from the same sums (partials of h and Dxz, `n = normalize(-dh/dx, 1, -dh/dz)` after the horizontal Jacobian correction), plus `dh/dt` (vertical surface speed) and orbital horizontal velocity for the contact API. The same Jacobian gives crest foam `J = det(I + dD/dp)`, so foam, collision slope and look agree.

### 4.2 Parameters and single source
- Wave set is data, in one place: new **`browser/wave-config.js`** (like `cloud-config.js` is for `WHIRLPOOL_DIP`): component table (wavelength, direction offset from wind, amplitude share, steepness share), `g_world` (deep-water dispersion `w^2 = g k`; recommend `g_world` = the physics `GRAVITY` so apparent speed feels right), master period, region table (below), caps. `wave-math.js` emits the WGSL (`waveWGSL()`, like `flowWGSL()`), a JS mirror, and **a JSON golden file** consumed by the Rust tests (Rust cannot import JS, so a generated `wave-params` constant block in `voyage.rs`/new module is produced by a script and diffed in CI like `WHIRLPOOL_DIP`'s mirror is checked today).
- **Phase-exact clock.** Choose `w_i = 2 pi n_i / T_master` with integer `n_i` (e.g. `T_master` = 1024 s) and derive `k_i = w_i^2 / g` (so wavelengths are quantised to the dispersion, which is fine). The wave clock then **wraps at `T_master` with zero discontinuity**, so `t` is always kept small (f32-safe in WGSL) and the clock never degrades over a long session.
- **Shared wave clock.** `t_wave` is derived from the **simulation tick count** (`tick * dt`, f64), not the wall clock: the worker passes the tick's `t_wave` into each wasm step (and `set_wave_time` for queries outside a step); the renderer interpolates the same value between ticks (render time = last tick time + alpha*dt) and writes it to a uniform. Replays/ghosts/shared flights reproduce waves because the clock is part of sim state. Pausing the sim pauses the waves (acceptable; a purely cosmetic `t_detail` uniform keeps ripple normals/foam animating if desired).
- **Floating origin.** CPU computes `k_i d_i . origin mod 2 pi` per origin change in f64 and uploads it as a per-wave phase offset; the shader then evaluates `k_i d_i . local_xz` in f32 (smaller arguments, no precision loss at 40 km from the chart origin). Same trick for Rust being `f64` is not needed but the shared test must cover origins up to the planet size.
- **Parity tolerance:** JS vs Rust (both f64 path): 1e-9 yd; WGSL f32 readback vs JS: 2e-3 yd height, 2e-3 normal. Golden vectors include extremes: large origins, `t` at 0 / `T_master - eps`, steep config, zero amplitude.

### 4.3 Gameplay-safe amplitude and per-region settings
Amplitude is the **most important gameplay knob**; the safe envelope is derived from the hover cushion (`HOVER_HEIGHT` 1.1, support reach ~1.9):
- **Default sea (Hs ~ 1.0, crest-to-trough ~ 2.0 yd max component sum 1.6):** a craft at cushion height skims over crests without ever being driven into them by the spring alone; low flying is rewarded, not punished.
- **Hard cap on slope** of the combined field at default regions: `|grad h| <= 0.25` (14 deg), so the hover model never sees a face steeper than a ramp it already handles. Steeper only in "swell set" and storm regions (4.4/5).
- Config validation (load time + unit test): `sum A_i <= ampMax(region)`, `max slope <= slopeMax(region)`, `sum Q_i k_i A_i <= 0.9`.

Region table (data in `wave-config.js`, mirrored to Rust, evaluated from a pure function `region(x,z)` + wind; no textures so Rust and shader agree):

| Region | Amp scale | Slope cap | Notes |
|---|---|---|---|
| Open sea, calm | 0.5 | .15 | trade-wind belts, near-glass |
| Open sea, default | 1.0 | .25 | wind from `beltWind` sets direction |
| Storm sea (inside storm cells, Maelstrom radius 9600 yd) | up to 2.5 | .5 | big swell sets (5), wake breakers |
| Maelstrom bowl (r < 1800) | 0.35 | .25 | the analytic dip dominates; waves must not obscure its walls |
| Polar water | 0.15 beyond 80 deg lat | .1 | brash ice, near flat |
| Lakes / canals / authored MCLQ/MLIQ water | **0** (default) | n/a | flat as authored (matches current physics, README 531) |
| Elune / airless | 0 | n/a | no waves; Moonglade stays flat |

### 4.4 Shore fade and the land/authored-water boundary
Waves must be **zero where water is authored** and fade over the shallows:
- `ampK = smoothstep(0, 1, ramp / ramp_full)` with `ramp_full` = 0.06 normalised ramp (about 20-40 yd of shelf, tune in smoke). Shader already has the authored `ramp` attribute (`v.n.x`). Rust builds `exterior_geometry` and the distant-water triangles from the **same** MCLQ/ramp data (`water.rs`), so Rust computes `ramp` per triangle (barycentric) with the identical function: **this is the one place shader/Rust can drift; parity test = sample N points in triangles on both sides and compare ampK**. Where ramp is unavailable (deep ocean backing, `coversLand` carved cells) ampK = 1 in the open sea and 0 on land cuts (hard stop at `coversLand` rects, including the raceway basin: never raise water into carved land).
- Physics surface = `max(ground, sea_height + wave)`. A wave never covers ground that is above the mean sea level by more than `ampMax` (it simply sinks below); crests that would lap ground <= `ampMax` high are clipped by the fade, so the pod never sees water ridges climbing the beach.
- Shader land-cut: unchanged from rev 1 (Phase 1).

### 4.5 Flat-water preservation (non-negotiable test)
With `A_i = 0` everywhere (setting `waves = off`) **`sample_at` must return bit-identical `Surface` values to today** and all existing flight/physics goldens must pass unmodified. The wave term is added in exactly one place (`sea_height`, voyage.rs:251: `sea_level - whirlpool_dip + wave(p,t)*ampK`), and the new `t_wave` argument defaults to 0 for existing callers. Add a test per surface type (open sea, whirlpool bowl, authored lake, canal, tile boundary, `coversLand` carve) that the flat path is unchanged.

## 5. Waves vs the pod: swell flight and wave-face crashes

### 5.1 Contact model (what changes in physics)
No new force model is invented for the common case: the surface is just a height field, and the existing hover spring/skim contact reads `sample_at(...)` at the support rays. Additions:
- **Surface normal** from the wave gradient is blended into the support normal so the pod banks with the slope (same path terrain slope uses).
- **Moving surface:** the contact point velocity `dh/dt` (and orbital horizontal) is subtracted from the relative velocity for support/drag. It is small (`A w` ~ 0.3-1 yd/s) next to flight speed (100-300+), and is mainly relevant to a slow pod (hovering/low speed) and the future sailboat.
- **Look-ahead lift (swell cushion):** probe 0.2-0.4 s ahead along velocity; if the surface rises toward the craft, add a smooth upward bias on the support (ground-effect cushion) so small face hits become ramps. This is what keeps default swells fair; it is *absent* above the crash threshold (below).

### 5.2 Jumping off swells
A swell crest is a launch ramp: the spring loses support as the surface falls away faster than the craft, and the craft goes ballistic. For a pod at horizontal speed `v` leaving a rising slope `s`, vertical launch speed is about `v s`, air time `2 v s / g`, apex `(v s)^2 / (2 g)`. With physics `g` = `GRAVITY` (use the real constant; numbers below assume 10.7 yd/s^2 as an illustration to be re-tuned):

| Speed v (yd/s) | slope .10 | slope .20 | slope .35 |
|---|---|---|---|
| 60  | apex 1.7 yd, air 1.1 s | 6.7 yd, 2.2 s | 20 yd, 3.9 s |
| 120 | 6.7 yd, 2.2 s | 27 yd, 4.5 s | 82 yd, 7.9 s |
| 200 | 19 yd, 3.7 s | 75 yd, 7.5 s | 229 yd, 13 s |

Design implications: (a) at race speeds a modest 0.2 slope already gives a long jump, so **default slope cap .25** and an **explicit "jump swell" region** (sets with slope up to .35-.4) rather than letting every sea be a launch pad; (b) speeds near the cap (200+) are where hits are costly, so the jump table is the tuning sheet: choose set slope so apex at cruise speed is 5-25 yd, a fun but survivable jump; (c) landing is just a normal water contact at the new face, with spray (section 7) and the skim response below the crash threshold.

### 5.3 Wave-face impact model
Treat the sea surface as a collision **mesh of height h(x,z,t)** with normal `n` (4.1). For each craft contact sample point `q` (nose, belly, both engine pods, tail; ~5-8 points) when `q.y <= h(q) + contact_eps`:
- **Closing speed** `v_n = -(v_q - v_surf) . n` (surface motion included). **Incidence angle** `a = asin(v_n / |v|)`.
- Classification (tunable constants in `wave-config.js`, mirrored to Rust):

| Class | Condition | Result |
|---|---|---|
| **Skim / graze** | `v_n <= 8 yd/s` or `a <= 6 deg` | existing hover/skim response, wake + skim spray, no damage |
| **Slap** | `8 < v_n <= 40` | inelastic bounce: remove normal velocity with restitution .25 (match `wreck.rs RESTITUTION` .3), tangential friction .08, drain 5-15% speed, splash, rumble, 0 damage; heat/durability untouched |
| **Crash (wave-face impact)** | `v_n > 40` **and** `a > 20 deg` (the nose/engine sample hits the *face*, not the back) | see below |

- **What "crash" does.** Recommended: a *wipeout*, not instant death. (1) Large impact splash (section 7), (2) speed multiplied by 0.35 along the face normal-removed velocity, (3) durability damage scaled by `v_n` (reuse the existing engine-health model, lib.rs:22) so a single bad hit hurts but a graze never does, (4) 0.8-1.5 s control-lockout/yaw-tumble impulse (torque from where the sample hit) and camera shake, (5) the pod is then re-seated on the surface in a recovery state (self-righting, regains control). Above a **catastrophic threshold** (`v_n > 90` or health 0) the race flow's existing crash outcome applies; promoting the debug `wreck.rs` PoC to be called is explicitly an **opt-in later step**, not part of this design. Open question 10 covers death vs wipeout.
- **Swell size vs speed (when a face can crash you).** For level flight at speed `v` into a face of slope `s`: `v_n = v s / sqrt(1+s^2)`. Crash needs `v_n > 40`: at s=.25 that is v > 165; at s=.5 v > 90; at s=.8 v > 65. So the default sea is **crash-free below ~165 yd/s**, near-cap flyers can crash only by flying into a face at low altitude on defaults, and **only storm/"big wave" sets** (slope .5-.8) are dangerous at cruise speed. Big wave size: height (trough to crest) 8-14 yd, wavelength 150-400 yd, period gives phase speed ~ `sqrt(g L / 2 pi)` = 14-24 yd/s (nearly static to the pod, so the wave is a deterministic "wall" you can read and path around).
- **Wave sets** (the "big wave" content): a 5th component with a travelling group envelope `e(x,t) = smoothstep` over a pulse train (period 90-180 s, set length 3-7 waves), analytic and deterministic, only in storm/set regions; steepness up to .8 but still obeying the contraction rule (so it does not loop/overturn, its look is a steep face with foam, not a barrel). No breaking-wave physics.

### 5.4 Fairness and readability
- **Readable ahead of time:** big faces are >= 8 yd tall and visible 3 s ahead (450+ yd at cruise); crest foam (Jacobian, F1), a dark trough/bright face lighting from the wind direction, whitecap lines on the crest, and distant-set silhouette are all required in Phase 1 shader output for a face to read at distance. Add a subtle audio cue (low surge) and an **optional** HUD "swell ahead" chevron (off by default).
- **Deterministic, never surprise:** no random freak waves. Sets repeat on a fixed schedule, are region-bound, and are the same in every replay.
- **Forgiveness:** (i) the look-ahead lift (5.1) turns most graze hits into ramps; (ii) crash requires *both* high closing speed and a face-on angle; (iii) hit grace: the first slap inside 2 s after a crash does not re-crash (invulnerability for recovery); (iv) the damage curve is continuous, never a cliff; (v) a "wave telegraph" setting scales amplitude down globally (assist) and is the same code path (`ampScale`).
- **No hidden collisions:** physics and render surfaces agree to <= 0.002 yd (parity test), so you can never hit a wave you can't see or fly through one you can.
- **Tunability:** the constants above live in one table, are verified by a flight test that scripts three flights (low pass, jump, face-on) at 60/120/200 yd/s and asserts outcome class.

## 6. Water-contact / buoyancy API (foundation for sailboats)

Goal: a **pure, boat-agnostic** API the pod uses now (skim contact) and a future hull will use. No boat model, no mesh, no sails; only the foundation and a test fixture.

```
trait WaterField { // Rust, in flats-racer-physics (new module `water.rs`), mirrored 1:1 in JS wave-math.js
    fn sample(&self, x: f64, z: f64, t: f64) -> WaterSample;
    fn sample_batch(&self, pts: &[[f64;2]], t: f64, out: &mut [WaterSample]);
}
struct WaterSample { height: f32, normal: [f32;3], surface_vel: [f32;3] /* dh/dt + orbital */, amp_k: f32, depth: f32 /* seabed distance, inf in deep sea */ }
fn submerged(points: &[[f32;3]] /* hull sample points in world space */, field: &impl WaterField, t: f64) -> Submerged;
struct Submerged { depth: Vec<f32> /* >0 = below surface */, normal: Vec<[f32;3]>, fraction: f32, volume: f32 /* from per-point cell volume */, centre: [f32;3] }
fn buoyancy_force(sub: &Submerged, rho: f32, g: f32) -> ([f32;3] /* force */, [f32;3] /* torque about centre */);
fn drag_force(sub: &Submerged, v_rel: [f32;3], cd: f32, area_per_point: f32) -> [f32;3];  // quadratic, along -v_rel, scaled by submerged fraction
```
- Pure functions, no state, no allocations on the hot path (caller-provided buffers), `f64` positions, `f32` outputs. Pod contact and the sailboat share the same code: the pod's support rays are 1 sample per ray with `depth = h - q.y`; a hull is the same call with N points.
- **wasm exports** (cargo agent builds): `water_sample_batch(ptr,n,t,out_ptr)` for JS/worker, so JS never loops in JS for gameplay; JS mirror exposes the same names for renderer/camera/audio.
- **Camera clearance:** `camera-collision.js waterSurface` becomes `sea_height + wave(x,z,t)` from the JS mirror plus clearance (no hand-tuned `ampMax` padding).
- **Tests with no boat:** a Rust test fixture "buoy" (a few sample points and mass) must (a) float at equilibrium in flat water at the analytic displaced-volume depth, (b) heave/pitch with the swell with bounded amplitude, (c) damp via `drag_force`, and (d) the energy never grows; deterministic across runs.
- Out of scope: hull model, rudder/keel, wind-on-sail force, anchoring, crew, water ingress.

## 7. Wake and splash from podracer overflight

### 7.1 Current state
`particles.js` already has a `ripple` and a wake (CPU particles; ripple rings and spray), sized for the flat sea; they do not interact with the wave height (a ring floats at sea level) and cannot form a trail that persists in the water.

### 7.2 Options survey

| # | Option | Look | Cost (mid GPU, 1080p) | Fit |
|---|---|---|---|---|
| W1 | **Wake ribbon / foam trail**: a camera-near strip of quads sampled from the pod's path every ~2-4 yd while low over water; foam texture, alpha-decay over 6-12 s, widens with age; vertices snapped to the wave surface (`h(x,z,t)` from the shared model so the trail rides the swells) | clear V-wake + centre churn behind a skimming pod | <= 64 segments, 256 verts, ~0.05 ms GPU, trivial CPU | Easy; best value; needs surface height mirror (4) |
| W2 | **Spray particles** (instanced billboards): emission from pod/engine points with velocity from pod velocity + normal + noise, lifetime 0.5-1.5 s, gravity; GPU storage buffer on WebGPU | rooster-tail and bow sheets | 500-2000 particles ~0.1-0.25 ms | `particles.js` extension; instanced draw is new |
| W3 | **Ripple height-field interaction**: a camera-centred, toroidally addressed 256^2 (2 yd texel -> 512 yd window, tune) wave-equation sim (ping-pong rgba16float: height, velocity, foam, spare) in a WebGPU compute pass; pod drops impulse discs at contact points; water shader samples it for extra normal/height (VS fetch) and foam | real expanding wave rings and wake pattern that interact with real waves | 0.2-0.4 ms (1 compute dispatch + 1 texture) | Needs a compute path (does not exist); High tier |
| W4 | **Skim spray when low** (continuous): emission rate = `speed * clamp(1 - alt/limit)` where `limit` ~ 2.5 yd; two side sheets + centre rooster tail; modulates W2 and W1 widths | the "I'm kissing the water" feedback loop that teaches low flight | rides W2 | Core feel feature |
| W5 | **Impact splash**: on slap/crash (5.3) spawn crown + column + shock ring: sprite/particles scaled by `v_n`, an impulse in W3 (or a foam decal in W6), a short-lived foam ring ribbon on the surface, camera shake and audio | clear, satisfying consequence for jumps/crashes | burst of 100-400 particles, one frame | Simple, needs the impact event from physics |
| W6 | **Foam map**: camera-centred RG8 256^2 foam/decay map written by W1/W5 as quads, sampled by water FS; cheaper stand-in for W3's foam channel | persistent foam without the sim | ~0.05 ms | Low tier substitute for W3 |

### 7.3 Tiers (reusing `off/low/standard/high`)
- **off:** today's rings/spray unchanged.
- **low:** W5 sprite splash + W4 skim spray (existing CPU particles, wave-surface-aware origin) + W1 ribbon with 4 s lifetime.
- **standard:** low + W2 instanced GPU-drawn spray (capped 1000) + W6 foam map + W1 8-12 s trail + audio hooks.
- **high:** standard + W3 compute height-field (2 yd texel, window 512 yd, scrolls with the camera by toroidal offset) + higher spray counts (2000) + W5 shock rings driving W3.

### 7.4 WebGPU plan
1. **Particles:** a storage buffer of N particles (pos, vel, age, size, kind), CPU-updated at standard; compute-updated at high; one instanced draw (billboards, alpha-blended, depth-tested) in the water/terrain pass after water.
2. **Ribbon:** dynamic vertex buffer rewritten each frame from a ring buffer of path samples; rendered with the shared wave height in the VS for vertical snap.
3. **Height-field:** two `rgba16float` storage textures ping-ponged, compute shader 8x8 workgroups, damped wave equation (`h'' = c^2 laplace h - damp h'`, c ~ 20 yd/s so rings are readable vs flight speed), injection list as a small uniform buffer (<= 16 impulses/frame); window recentres in whole-texel steps (toroidal addressing, no clear) with the lattice snapped to world texel spacing (same snapping rule as the clipmap) so it never swims; water VS/FS sample it bilinearly.
4. **Feature gate and fallback:** `storage rgba16float` write and compute availability check at init; failure drops `high` to `standard` silently. Headless Edge/SwiftShader smoke runs `standard`.
5. **Origin/bend:** all effects live in chart space before `bend()`, like the waves; spray beyond ~2 km culled.

### 7.5 Budgets
Standard +0.15-0.25 ms GPU total (ribbon + spray + foam map); High +0.4-0.7 ms (adds W3). Particle count and ribbon length are caps, not targets, and drop on the existing slow-frame auto-downgrade.

## 8. Revised phases, file lists, tests (supersedes 2(e) table)

Phase 1 is **already underway in a separate session** (shader). Treat it as the shader foundation and **require it to satisfy the contract in 4** before Phase 2 is written, so shader and physics start from one definition.

| Phase | Scope | Files (new = n) | Tests | Risk |
|---|---|---|---|---|
| **1 (in progress, other session): shader** | Water shading upgrade (real sun, glint, slope-variance roughness, Beer-Lambert, SSS, night), near clipmap + Gerstner VS, crest foam from the Jacobian, shore/land-cut fade, `waterQuality` tier (`off` = bit-identical to today). **Must consume `wave-config.js`/`wave-math.js` (n) as the single wave source, no private constants.** | `water-shader.js`, `renderer-shaders.js`, `renderer-terrain.js`, `ocean-clipmap.js` (n), `ocean-mesh.js`, `wave-math.js` (n, WGSL emitter), `wave-config.js` (n), `space.js` | `water-shader.test.mjs`, `ocean-clipmap.test.mjs` (n), `wave-math.test.mjs` (n; continuity, band limits, contraction), `water-smoke.mjs` | Medium: clipmap seams, floating-origin phase, bend; risk of drifting away from `wave-config.js` |
| **2: shared wave model + Rust** | `wave-config.js` finalised; `wave-math.js` CPU mirror with inversion (3 iterations), golden vectors + generated Rust constants; Rust `waves` module (`flats-racer-physics`), `sea_height` gains `+ wave(p,t)*ampK`, `t_wave` plumbed through the wasm step API (default 0), shared sim-tick wave clock in the worker/renderer, **wasm rebuild via the cargo agent** | `wave-config.js`, `wave-math.js`, `client/crates/flats-racer-physics/src/waves.rs` (n), `client/crates/flats-racer-web/src/voyage.rs` (`sea_height`, `sample_at`, `set_wave_time`), `water.rs` (ramp -> ampK), worker/world messaging, `camera-collision.js`, generated `wave-params` consts script (n) | Rust: golden parity, flat-water bit-identical (4.5), contraction/slope cap, per-surface flat tests; JS: parity vs golden; smoke: shader readback vs JS 2e-3; determinism across origin and `t = T_master` wrap | **High**: sim clock/determinism, ghost/replay/save compat (wave term is additive, default off), ramp parity, wasm size and build time |
| **3: region/shore/weather settings** | Region table active (calm/default/storm/Maelstrom/polar/lakes), wind direction from `beltWind`, amplitude scale per cell, shore fade parity, settings UI (`ampScale`, assist), `waves` flag cleared on body switch (Elune) | `wave-config.js`, `weather-field.js`/`weather-wgsl.js` (`windK`), `renderer-weather.js`, `renderer-events.js`, settings UI | region parity JS/Rust/WGSL, ampK parity on authored triangles, polar and Maelstrom cases, Elune flat | Medium; depends on weather.md phases for wind |
| **4: contact API + gameplay** | `WaterField`/`submerged`/`buoyancy_force`/`drag_force` (6), pod hover/skim reading real waves with normal + surface velocity + look-ahead lift, swell flight tuning, wave-face impact classes + wipeout (5), wave sets, camera clearance | `flats-racer-physics/src/water.rs` (n), `lib.rs`, `voyage.rs`, wasm exports (`water_sample_batch`), `camera-collision.js`, pod visuals/shake/audio hooks, `wave-config.js` (impact constants) | buoy fixture (float/heave/damp/energy), flight scripts at 60/120/200 yd/s (skim/jump/face-on), crash class table, flat-water goldens unchanged, p99 handler | **High**: feel tuning, interaction with durability/race flow, determinism, p99 |
| **5: wake and splash** | W1, W4, W5, W6, W2 (standard); wave-surface-aware origins | `particles.js`, new `wake-ribbon.js`, `splash-fx.js`, `renderer-terrain.js`/water pass, `water-shader.js` (foam map sample), audio | spawn/lifetime determinism (seeded), ribbon snap to `h`, perf cap tests, smoke screenshots, memory-budget row | Low-medium; pooling/overdraw |
| **6 (optional, High tier): height-field + FFT** | W3 compute height-field; later FFT cascade, S2/R2 from rev 1 | compute module (n), `renderer-init.js` gate, water shaders | feature-gate fallback, perf gates | High: new compute path |
| **Later (not scheduled): sailboat mode** | Hull, sails, rudder consuming section 6's API | n/a | n/a | n/a |

Rust/wasm work goes through the **cargo agent** (wasm rebuild is a step in phases 2 and 4, not hand-run), per the repository workflow. Every phase ships behind `waves`/tier flags (default off until smoke + perf match baseline); Phase 2 keeps the flat path bit-identical.

## 9. Performance budget (handler p99 ~ 20 ms is the constraint)

- **Physics/worker:** a wave sample = 4 components x (sin, cos) x 3 inversion iterations ~ 24 sincos + a small amount of arithmetic ~ 0.3-0.6 us in wasm. Pod contact ~ 8 samples/tick, buoy API <= 64 samples/tick -> **< 50 us per tick**, i.e. < 0.25% of the 20 ms handler budget. Hard rules: no allocation, no per-tick region lookups beyond a handful of arithmetic ops, batch samples via one wasm call. CI gate: a micro-benchmark asserting `sample_batch(10_000)` under a ceiling and the existing p99 handler benchmark must not regress beyond noise (<= +0.5 ms).
- **Main thread:** JS mirror <= 16 samples/frame (camera, pod visual, audio, wake ribbon); wave uniforms ~ 24 floats/frame; clipmap grid static (no per-frame mesh work), `refreshOcean` 1/s unchanged.
- **GPU (mid, 1080p):** Standard: Gerstner VS (4 waves, ~60-100k verts) + normals + foam + SSS ~ +0.3 ms; wake/splash +0.15-0.25 ms. High: +0.4-0.7 ms for the height-field, FFT optional. Auto-downgrade via the existing slow-frame mechanism.
- **Memory:** clipmap 2-3 MiB, foam/height-field textures 1-2 MiB, particles < 1 MiB, wasm growth ~tens of KiB; add rows to `memory-budget.js`.
- **Bytes:** no shipped binary assets; wave tables are tiny config.

## 10. Risks (rev 2 additions)

| Risk | Mitigation |
|---|---|
| Shader (separate session) and Rust drift on the wave function | Single `wave-config.js` + `wave-math.js` source, generated Rust constants checked in CI, golden-vector tests on all three, Phase 1 must adopt before merge |
| Time in physics breaks replays/ghosts/saves | Clock is the sim tick count; wave term additive and zero when off; bit-identical flat test; golden replays run with waves off and on |
| Gerstner horizontal displacement makes collision height wrong | Mandated 3-iteration inversion in all three, contraction cap, parity tests |
| Shore mismatch between shader ramp and Rust | Rust derives ampK from the same ramp data per triangle; parity sample test; fallback: fade to 0 at `coversLand` plus a conservative min over neighbours |
| Waves make the race unfair or unreadable | Amplitude/slope caps by region, look-ahead lift, crash requires speed + angle, wave sets deterministic and telegraphed, `ampScale` assist, scripted flight tests |
| Crash model conflicts with durability/race flow | Wipeout default, catastrophic outcome only above a high threshold, `wreck.rs` untouched; confirm with owner of race flow |
| p99 handler regression | < 50 us/tick budget, batching, benchmark gate |
| f32 precision / long sessions | Phase-exact master period, CPU-computed origin phase offsets |
| Compute path (W3/FFT) unavailable | Feature gate, `standard` fallback, SwiftShader smoke runs `standard` |
| Orbit/bend interplay | Waves disabled above the atmosphere regime; globe sea unchanged |
| wasm size/build time | Small module (~KiB), built via cargo agent |

## 11. Open questions with recommended answers

1. **Crash severity:** wipeout (speed loss, damage, brief lockout) vs instant wreck? *Recommend wipeout; wreck only above `v_n` 90 or zero health; leave `wreck.rs` debug-only for now.*
2. **Default amplitude/slope:** *Hs ~ 1.0 yd, slope cap .25; calm .5x; storm 2.5x; sets up to .5-.8 only in storm/set regions.*
3. **Crash threshold constants** (`v_n` 40, angle 20 deg, slap 8): *start there; tune with the scripted flight tests.*
4. **Do lakes/canals/coast move?** *No: flat as authored (physics today); waves fade to 0 via the ramp.*
5. **Waves default on?** *Opt-in via `waves`/tier until Phase 2-4 benchmarks match baseline; then default on at standard.*
6. **Wave clock tied to sim ticks (pause pauses waves)?** *Yes, with a cosmetic detail clock for ripples.*
7. **Shared flight/ghost compatibility:** *waves must be a deterministic function of (x,z,tick); ghosts recorded with waves off remain valid with waves off; add a version flag to recordings.*
8. **Sailboat scope now:** *API only (section 6) plus the buoy test fixture; no hull.*
9. **Jump swells as content:** *dedicated jump-swell zones, not everywhere; slope .35-.4 and clear signposting.*
10. **Should big waves be deadly in time trials/races or only a speed penalty?** *Speed penalty + damage only; no instant loss outside the existing durability rules.*
11. **Telegraph HUD / audio cue for swell sets:** *audio on, HUD chevron off by default.*
12. **Is the High-tier compute path (height-field/FFT) worth carrying?** *Defer; ship W1/W2/W4/W5/W6 first, then W3 if cost allows.*
13. **Underwater view, caustics, bioluminescence:** *non-goals.*
14. **Moon direction/phase uniform for night glints:** *confirm in the time system; if absent, use a fixed-direction moon term.*
15. **Where should the wave config live for Rust (generated constants vs runtime upload)?** *Runtime upload via `set_waves(params)` at startup from the JS single source, validated in Rust; avoids a generated file and is a one-call wasm API; golden tests still lock parity.*
16. **Amplitude vs `HOVER_HEIGHT` 1.1:** confirm the hover spring tracks waves without bouncing at the default slopes. *Recommend a Phase 2 physics spike (flat test + sinusoidal surface test) before gameplay tuning.*
