# Design: weather (rain and snow)

Status: proposal (no code changed). Inputs read: `design/{clouds,time,elune,far-to-near}.md`, `CLOUD-FLOW.md`, `cloud-config.js`, `cloud-flow.js`, `clouds.js` (`sheetDensity`, `cloudBody`, `cloudUniform`), `cloud-march.js`, `renderer-clouds.js`, `sky.js` (`SkyCatalog`, Light/LightParams bands), `sky-coupling.js`, `particles.js`, `world-audio.js`, `regime.js`, and the Rust `area_table.rs` (`is_cold`). Game data is read at runtime only; nothing derived from it is committed.

## Goals (user request)
1. Rain (snow in Winterspring, Dun Morogh, Alterac Mountains and any other winter zone) falls **depending on cloud coverage**.
2. You **see precipitation approaching in the distance under the clouds, then it envelops you**.
3. **Not every cloud rains.** The distinction must look natural.

## 1. How others do it

| Concern | Technique | Seen in |
|---|---|---|
| Which clouds rain | Weather *cells* / fronts: a slowly moving low-frequency field (state per region, not per cloud) selects precipitation; cloud density is raised and darkened where it is wet | Red Dead 2 / GTA V (weather zones and cell blending), MSFS (3D weather grid, METAR-driven), Sea of Thieves (storm fronts that travel), UE5 Ultra Dynamic Weather (community) |
| Cloud/rain coupling | Cloud model exposes a **precipitation mask / rain-cloud type** (cumulonimbus, nimbostratus: thick, dark, flat base). Rain falls only from the base of those types | UE5 Volumetric Clouds + Niagara (material outputs a rain mask used by gameplay/particles), Unity HDRP Volumetric Clouds presets (Cloudy/Stormy/Overcast), Horizon Zero Dawn / Forbidden West (Guerrilla: weather map channels = coverage, precipitation, cloud type; rain follows the precipitation channel) |
| Distant curtains | Rain seen far away is not particles. Options: (a) textured, scrolling, vertical **curtain cards** or a shader layer in view space with soft top fade into the cloud base; (b) **virga**: streaks hanging from the base that fade before the ground; (c) **rain shafts** = ray-marched density column in the same volume as the clouds (Frostbite/Decima style), shaded by the same light | Horizon (rain shafts in the cloud volume), Flight Simulator (volumetric rain shafts), RDR2 (distant rain sheets), Skyrim/Witcher (fog+streak layers) |
| Near precipitation | Camera-attached particle volume ("rain box"): a few thousand streaks (rain) or flakes (snow) in a box that follows the camera, wrapped with modulo so no allocation; velocity from gravity plus wind **plus camera velocity** (stretch along relative motion); GPU or vertex-shader driven | Unity VFX Graph, UE Niagara rain systems, Valheim, Minecraft (column heights + heightmap occlusion), Skyrim |
| Occlusion | Rain must not fall indoors/under roofs: top-down depth/height map ("rain occluder camera"), or a single heightfield test per column | UE5 / Frostbite "precipitation occlusion", Minecraft heightmap, Sea of Thieves |
| Wetness | Global material params: darken albedo, lower roughness, add specular; ramp in over seconds, dry over minutes; snow = whitening by up-facing normal threshold, optionally accumulation with time | RDR2, The Last of Us 2, Frostbite, Unity HDRP wetness |
| Atmosphere | Fog density up, visibility down, sun and shadows dimmed, sky/cloud colour desaturated, light-level reduction, ambient lightning | universal |
| Audio | Layered loops: distant rain (low-passed) fading to heavy rain as cell coverage at the listener rises; surface-dependent patter; thunder with distance delay | universal |
| WoW itself | Zone weather is a **server-driven, per-zone state** (type + intensity, changes every few minutes) broadcast as a packet; the client shows a camera-attached particle effect, adjusts Light/fog and plays a sound. 1.12 has no distant rain, rain does not come toward you, and clouds are skybox art unrelated to it. We keep its *cold zone* semantics but not its model | WoW 1.12 |
| Minecraft / Valheim | Global on/off state, no spatial structure: the failure mode we are explicitly avoiding ("rain everywhere or nowhere") | |

Takeaway: all modern titles separate **(a) a low-frequency precipitation field**, **(b) a cloud type/density that agrees with it**, and **(c) three presentation tiers** (volume/curtain far, particles near, surface response). That is the structure below.

## 2. Which clouds rain: the precipitation cell field

### Existing system (relevant facts)
- Clouds are a spherical shell at planet radius, density from `sheetDensity(pos,t)` in WGSL: `coverage = base(lat band + land lift/coast + storm) ...`, noise advected by an analytic wind (`cloud-flow.js` `beltWind`, two-phase flow map, `c.bend.w/z`), thresholded as `top = n - (1-coverage)`. `cloud-march.js` is a deterministic **CPU mirror**; `CloudClock` drives time (wall clock, not scaled).
- Cloud base altitude is `CLOUD_ALTITUDE - CLOUD_THICKNESS/2` (~1060 yd); High tier grows towers to +2400 / -160 yd where `coverage` is high.
- Therefore the CPU can already answer "is there cloud density at this ground point" through the mirror; the design reuses that instead of inventing a second cloud layer.

### Core idea
Precipitation is **a second field `P(x,t)` (0..1) defined on the same flow-advected noise space as the clouds, evaluated from the cloud's own `coverage` and body density**:

```
wet(x,t) = smoothstep(c0, c1, coverage(x,t))          // only thick/high-coverage regions can rain (base 0.62..0.8)
         * smoothstep(d0, d1, bodyDensity(x,t))       // and only where the rendered body is actually dense (cloud base above x)
         * cell(x,t)                                  // coherent mask that picks WHICH of those clouds rain
P = wet * lifecycle(cell id, t) * climate(zone)       // climate: 0 desert/space, 1 temperate, snow flag
```

- **`cell(x,t)`**: a separate, *lower frequency* 3D noise (wavelength ~6-12 kyd, roughly 3-6x the cumulus wavelength) sampled at the same advected point `Q` as the clouds (reuse `flowShift`) and a **slower evolution rate**. Because it is advected by the same wind as the clouds the rain moves with its cloud and never slides off it. Thresholded at ~0.55 so ~25-35% of dense cloud is wet. Wet regions are blobs a few kyd wide, not per-puff speckle, which is what makes it look natural: big thick dark clouds rain, little cumulus never does.
- **Hysteresis / soft thresholds**: the on-threshold is higher than the off-threshold (Schmitt: start at 0.58, stop at 0.48) applied to the *time-smoothed* value, so cells do not flicker at their boundary. On GPU use two smoothsteps with a per-cell time phase; on CPU keep a small per-cell state machine (below).
- **Lifecycle** (per cell, cheap): a cell is a spatial hash bucket (bucket = floor of advected position / cell size). Its age phase `u = fract(t/T + hash(bucket))` with T = 8-20 sim-minutes drives an envelope: build-up (clouds darken first, 15%), rain (peak, 55%), decay (virga, thinning, 30%). Intensity = envelope * wet. Cells are not individually simulated entities, so there is no spawn/despawn cost and any point is O(1) to query.
- **Cloud darkening and base lowering**: feed `P` back into `sheetDensity`: `coverage += k*P` (thicker), the extinction/albedo darkens (`shade *= mix(1, .45, P)`), the base drops (`DOWN*grow` already exists in High; extend `grow` with `P`), and the underside tints grey-blue. The precipitation is thus visibly *caused* by the cloud above it, and the rain is hidden by nothing because it is inside the same density function. Build-up before rain (darkening) gives players a cue.
- **Natural distinction**: (1) only high-coverage clouds, (2) only a coherent minority via the cell field, (3) lifecycle so rain arrives and leaves, (4) virga/light rain at the cell edge and decay (intensity < 0.25 does not reach the ground: streaks fade by a fall distance proportional to intensity), (5) climate and orographic lift (windward land `maskAt().y`) bias wetness so mountains/coasts rain more.
- **Shared source of truth**: one `weather-field.js` with the formulas and a WGSL emitter (as `flowWGSL()` does) plus parity tests vs the CPU mirror. Same deterministic CPU function drives audio, particles, fog and the wetness uniform, so there is no GPU read-back.

### Wind and approach
Cells move with `beltWind(lat)` (typical 10-30 yd/s; a 6 kyd cell crosses in ~4-10 min) plus the existing flow warp. A player standing still sees a cell approach at wind speed; a pod at 200+ yd/s overtakes cells quickly (see section 4). The orographic bias keeps rain stuck to windward slopes.

## 3. Climate and zones

Runtime inputs only (no committed data):
- **`AreaTable.dbc` flags bit `0x1` = snow** (already parsed: `AreaTableCatalog::is_cold` with the documented one-hop parent inheritance; e.g. Dun Morogh incl. Coldridge sub-areas). Snow if the area is cold, else rain. The browser needs this flag per ground position: the existing `SkyCatalog`/`mapPosition` path resolves map+x,z to a Light zone, and a baked **climate mask** (equirect RGBA8 alongside `bakeLandMask`: R temperature class, G aridity, B snow flag, A reserved) is built once from the area-id grid (ADT chunk area id -> `AreaTable`) at load. Sampled in the shader with the same `maskAt` pattern so distant snow is also visible.
- **Aridity** (no rain): by authored zone name list/flags (Tanaris, Silithus, Durotar, Badlands, Barrens in part, Searing Gorge, Burning Steppes, Blasted Lands, Un'Goro none) *or* by existing `bandCoverage` clear belt (`clearAt ~ .49 rad`) plus `landCov` dryness; both multiply into `climate`. Deserts get dust haze at most, never precipitation. Barrens: light rare rain (aridity 0.7).
- **Latitude/altitude fallback** for areas with no authored flag (open ocean, unnamed map): temperature from latitude and ground altitude: `T = 1 - |lat|/lat_max*0.8 - alt/3000*0.5`; snow when `T < 0.2`; tundra/ice caps always snow; equatorial ocean heavy rain bias (ITCZ). A tall peak therefore snows even in a temperate zone (snow line ~1500 yd above its zone temperature), and precipitation type **changes with altitude along a descent** with a 100-300 yd mixing band (sleet/rain-snow dither), so flying down from a snow cloud you see snow turn to rain.
- **Elune**: no weather by default (airless moon, no cloud shell; `ambientFor` gives it black sky). Climate multiplier 0, shader branch compiled out when the nearest body is Elune. Decision for the user (open question 5); a later opt-in could add ash/moon-mote effects in the Moonglade graft only.
- **Space/orbit**: no particles and no wetness above the `atmosphere` regime (`regimeOf`), but wet cells stay legible: the cloud shader stretches and darkens them (section 4.4, `weather.look`, `spaceLook`/`spaceRain`).

## 4. Rendering plan (WebGPU, p99 < 20 ms handler budget)

Budget (target on the reference GPU, additive to the current frame): **<= 0.5 ms GPU** for all weather and **<= 0.3 ms CPU** per frame; precipitation off or reduced in Low quality and by the existing `SlowFrameGuard` (30 ms window), which already downgrades clouds.

### 4.1 Distant curtains (the "see it coming" feature), three layers
1. **Rain shafts inside the cloud march (preferred)**: in `renderer-clouds.js`'s march, after hitting the cloud base, march the column *below* the base toward the ground for rays that pass under a wet cell: density `= P(x,t) * streakNoise(x.xz scaled, y*stretch + t*fallSpeed) * (1 - smoothstep(0, fall(P), baseY - y))`. Fall-distance limit gives **virga** for weak cells, full curtain to the ground for strong ones. 6-8 extra steps only on pixels where the CPU says a wet cell is within view (a 16-bit cell-in-view mask or screen tile flag avoids cost elsewhere). Lit by the cloud's sun term and fogged, so it matches the cloud colour. Cost: bounded by the existing step cap (Standard 8 / High 28), plus the column steps.
2. **Fallback / Standard tier**: a world-space **curtain layer** drawn as a ring of ~16-24 soft vertical quads (billboard ribbons) per visible wet cell edge, centred at cell boundary points (found on the CPU by sampling `P` on a polar grid around the camera, e.g. 64 azimuth x 6 radii, 400 samples = trivial), top aligned to cloud base, bottom to ground height at that point (heightfield sample or "base - fall"), alpha scrolled streak texture, fog-tinted. One draw, instanced.
3. Note (curved deck): the curtain march follows the rendered cloud's curved shells (`worldAt` height and world xz for the grid lookup, `shellRoots` for the base exit), so a ray that rises above the falling-away deck ends there. A flat base plane painted rain wall across clear sky off to the sides at altitude (shell curvature drops the deck thousands of yd by 13 km).
3. **Haze**: wet cells also tighten fog toward the cell (see 4.4), which hides seams of the above and gives the grey veil seen on approach.

The CPU polar sampling also yields the **nearest wet-cell distance and bearing**, used by audio and UI (and as the on/off gate of the shaft pass).

### 4.2 Near field (enveloping)
- A **camera-attached box** (e.g. 60 x 40 x 60 yd, 2-4k instances) in a new particle kind pair `rain` / `snow` in `particles.js` or a dedicated instanced pass (the shared CPU ring buffer `ParticlePool` of 2048 is too small and CPU-simulated; use a vertex-shader-driven instance grid with `wrap(pos - camera)` instead, so there is zero CPU simulation).
- Density scale = `P_local(camera)` (the smooth CPU value) so as the cell edge passes the density ramps from nothing to heavy over ~300-1500 yd: that gradient is the *enveloping* moment. Streak length from relative velocity (wind + camera velocity + fall speed ~ 9 yd/s rain, 1.5 snow with turbulence).
- Slightly larger box and a second sparse far shell (200-500 yd, thin streak cards) bridge near particles and the curtain.
- **Occlusion**: cheap height test per column against the terrain/WMO top at the box cells (CPU 16 x 16 grid per frame sampling the physics height) so there is no rain indoors or under overhangs; skip for v1 (accept rain through roofs) with a documented limitation.
- **Pod / flight / space**: pod uses camera-relative relative-velocity streaks (long streaks at speed, motion-blur look) and windshield-free (no droplet decals v1). Fly camera at altitude inside a cell works the same; the box is simply positioned in camera frame. The near field and curtain stay at full strength through the cloud layer (base to top, `curtainFade`) and fade to 0 over `W.curtain.fade` above the cloud top, so nothing pops at the base. Above `atmosphere` regime (`regime.js`) the whole system is gated off. Very fast flight (> 800 yd/s) switches streaks to a screen-space radial smear instead of per-particle.

### 4.3 Wetness and snow
- One uniform `wet` (0..1, time-smoothed: +0.15/s wetting, -0.01/s drying) and `snow` (accumulation 0..1, +0.004/s while snowing, -0.002/s melt in non-cold areas). Terrain/model fragment shaders add: `albedo *= mix(1,.7,wet)`, `rough` lowering / specular boost, and `albedo = mix(albedo, white, snow*smoothstep(.5,.9,normal.y))`. Water surfaces get ripple particles (existing `ripple` kind) on a sparse set. Wet state is a single value per frame, not per tile, v1 (global response) with a per-area climate scale.

### 4.4 Atmosphere
- Fog distance multiplied by `1 - .6*P_local` and fog colour mixed toward the cloud-underside grey; ambient/sun scaled by `1 - .45*Pcloud` (the zone Light bands from `SkyCatalog.sample` stay the baseline). Weather multipliers are applied after `matchHour` so time of day is preserved (`design/time.md`).
- **Lightning (optional, phase 4)**: only in cells with `P > .8` and warm climate: a rare flash (sun/ambient spike, bolt billboard from base) with the thunder delay `distance/343*...` into audio.

### 4.5 Audio hooks (`world-audio.js`)
`weatherLevel({near,distance,type})`: a band-passed noise bed whose gain follows `P_local`, a low-passed "distant rain" bed whose gain follows `max(0, 1 - nearestWetDistance/6000)`, snow = muffled wind bed. Reuses the `windLevel` pattern (pure function + tests). Wind bed already scales with speed and air density, so no change in orbit.

### 4.4 Rain from inside the layer and from orbit
- **In the layer** (weather-curtain.js): curtainFade(eyeY,base) is 1 up through the cloud top (`base+W.layer.top`) then fades out. layerWeight (smoothstep over ase+-W.layer.blend) tells the curtain shader the camera is inside; samples then rise into the layer as shafts that thin out above W.layer.mid/	op and with haze distance (W.layer.haze), and the base-shell exit is skipped. The near box uses the same fade.
- **From above and orbit** (clouds.js): the cloud shader multiplies the cloud density P by wxSpaceRain(P,noise,k) and dims wet cells (W.space: streak, dim, stretch). k is uniform slot 23, `spaceLook(height,on)` (ramp W.space.ramp). WeatherRuntime.look keeps {wet:1,on:1} in orbit (where `on` is 0) so every wet cell shows; Elune and off give {0,0}. Streaks are Standard/High only (ainStreak); Low keeps the plain darkening. No particles. CPU twin: `spaceRain` in weather-field.js; GPU parity checked by weather-parity.mjs.
- Captures and cost A/B: ace-weather-aloft.mjs (in-cloud, below-base, above, orbit, cost) -> untime/gate-preview/aloft-*.png.

## 5. Phased plan

| Phase | Work | Files (expected) | Tests | Perf |
|---|---|---|---|---|
| 0 | Spec and constants: `weather-config.js` (thresholds, speeds, lifecycle T, climate table) | new `weather-config.js` | config shape/range tests | none |
| 1 | CPU field: `weather-field.js` (`precipAt(lat,lon,alt,t)`, cell lifecycle, hysteresis) built on `cloud-flow.js` `flowShift`/`beltWind`, climate (`bakeClimateMask` from the area grid + `is_cold` flag exposed to JS) | new `weather-field.js`, `weather-climate.js`, edit `cloud-flow.js` (export advected point helper), `cloud-march.js` (mirror coverage) | determinism, advection-with-cloud (cell moves with wind), ~30% wet fraction, hysteresis, desert zero, snow in Dun Morogh/Winterspring/Alterac, Elune zero | CPU < 0.1 ms |
| 2 | Cloud coupling: WGSL emitter `weatherWGSL()`; darken/thicken/lower base under wet cells; parity tests with the mirror | `clouds.js`, `cloud-config.js`, `renderer-clouds.js`, `weather-field.js` | WGSL signature parity, existing cloud sweep/shell/alignment tests still pass with weather off, base lowering monotone | +0.05-0.1 ms |
| 3 | Distant shafts/virga in the cloud pass (High) and curtain ribbons (Standard); polar sampler for nearest wet cell | `clouds.js`/`cloud-shader`, new `weather-curtain.js`, `renderer-clouds.js` | polar sampler finds seeded cell, curtain ends at base/ground, off outside atmosphere | <= 0.3 ms |
| 4 | Near particles + fog tightening + sky/ambient dimming + audio | new `weather-particles.js` (+ shader), `sky-coupling.js`, `sky.js` uniform, `world-audio.js` | density follows distance to cell edge, pod/fly relative-velocity streaks, quality tiers, audio pure-function tests | <= 0.2 ms, 3k instances |
| 5 | Wetness/snow cover, ripples, optional lightning, occlusion heightmap | terrain/model shaders, `particles.js` | wet smoothing, snow accumulation/melt | <= 0.1 ms |

Each phase ships behind a `settings.weather` flag (default off until Phase 4 is visually verified), with golden captures (clear / approaching / inside / snow zone / orbit) and a smoke script modelled on `race-clouds-storm.mjs` that pins a cell on the camera path (`weatherLock` test hook like `timeLock`).

## 6. Options and recommendation

- **A. Cell field coupled to the cloud density (recommended).** Precipitation derived from the existing cloud function plus a coherent cell mask; shafts inside the cloud march; near particle box. Pros: rain physically under rendered cloud, moves with it, one wind, deterministic CPU mirror for audio/fog. Cons: touches the cloud shader (parity tests required).
- **B. Independent weather grid (RDR2/MSFS style), clouds adapt.** A coarse authored/simulated grid drives both. Pros: gameplay control, explicit states; cons: a second spatial state to keep in sync, risk of rain with no visible cloud, more memory.
- **C. WoW-style per-zone state, camera effect only.** Cheapest (no approach, no shafts). Does not meet the "coming towards me" goal; keep as the Low-quality fallback.

Recommend **A** with C as the Low fallback, phases 0-4 first.

### Risks
Cloud shader cost and parity drift (mitigate: shared emitter, tests, tier guard); climate mask needs area ids at the right resolution (ADT chunk area id is 33.3 yd class, a 256x128 mask is too coarse for zone borders: bake a second coarse mask for distant weather, and sample the live area id near the camera); snow and rain mixing at zone borders (blend over 300 yd); fast pod flight outrunning curtains (use smear); curtain popping at cell birth (fade over `lifecycle` build-up); high-altitude cells with ground far below (shaft fall limited to ~2 kyd then fade); sim vs wall time (clouds use wall clock, the cell lifecycle should too, to stay aligned until the cloud clock scales; reuse `CloudClock`).

### Open questions for the user
1. Rain frequency: ~30% of dense cloud (default) or rarer/event-like?
2. Should rain be permitted to fall *at all* in zones flagged dry, e.g. rare Barrens showers?
3. Snow accumulation on terrain (persistent, melts) or purely falling flakes?
4. Lightning and thunder in v1, or later?
5. Elune: stay weatherless, or add dust/mote effects in the Moonglade graft?
6. Is rain through roofs/indoors acceptable for v1 (no occlusion map)?
7. Should the Maelstrom storm always carry heavy rain (recommended, `storm` already marks it)?

## Status
Option A implemented (phases 0-5). Limits: climate is per current area, no occlusion, curtain assumes flat ground, Low tier is a small near box (not a screen overlay), flash is a screen veil, thunder has no distance low-pass, ThunderClap cue name unverified against the MPQ.


## Coverage retune
Measured with weather-coverage.mjs (real land mask, 3000 points x 90 steps of 120 s). Before (coverage [.3,.42], cell gate [.41,.61], period 1100): land soft(P>=.1) 31.8%, raining(P>=.5) 17.6%, 9% of time raining under cloud <.42, mean dry spell 27 min (sea: 18.2% / 6.3%). After (coverage [.4,.5], gate [.46,.62], period 450): land 18.5% / 10.1%, 30% of dense cloud rains, wet spell ~10 min, dry spell ~60 min, nothing under cloud <.4 (sea 5.6% / 2.6%). Unresolved climate (no area yet) is dry, not wet. Guarded by weather-coverage.test.mjs.


## Spawn fix
Rain showed at the Steamwheedle spawn under a clear sky (coverage .18): the Maelstrom storm term bypassed both the coverage gate and the dry climate (storm ~.3 gave P=.158). It is now gated by the rendered cloud coverage (config storm.cover [.25,.4]) in the CPU density, the WGSL cloud body and weather-field. Land coverage after: visible 12.6%, hard 6.6% (before the fix 18.4% / 10.1%, which included that false storm rain). Regression: weather-coverage.test.mjs.


Wind-driven dust and blowing snow share the weather tiers; see [wind.md](wind.md).
