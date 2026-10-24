# Whole-planet tiles: design and feasibility

Status: design only. Checkpoint of the current partial-globe look: tag `globe-partial-checkpoint` (main c1811a8).

## Today

- Flat world: 64x64 ADT grid, 533.33 yd tiles, x east / z south, render-space yards. Terrain streams within ~850 yd residency (terrain-stream.js worker), WDL horizon meshes beyond it, water/coast meshes, minimap atlas colours. Physics (Rust, wasm worker) is flat.
- Globe (space.js): ONE analytic fullscreen ray-sphere pass, R = 42,785 yd (continent N-S extent / 40 deg), equirectangular lookup `lon=(x-cx)/R, lat=-(z-cz)/R`, colour from continent rects + noise. `bendShader` curves the flat terrain/water/props onto the sphere between 150-1500 yd; the globe fades in 100-800 yd.
- The boundary colour step: near the edge of authored data the terrain/horizon (real minimap colour, fog, WDL shading) meets the globe's procedural colour (different palette, no height, different shading).

## Target

Every point of the planet is covered by exactly one source of colour+height: authored tiles where they exist, procedural fill elsewhere, one shading model, tile-local flat frames near the player.

### Mapping
- Keep the equirectangular (lat/lon) frame as the *authoring* frame: a flat tile (i,j) maps to lon/lat by the same formulas, so existing ADTs, WDL, minimap atlas, saves, tracks, gates and NPC coordinates keep their meaning. Distortion over a 40 deg continent is small (cos lat ~ 0.94 at the edge) and already matches the bend.
- Far side and the unauthored 99% of lon/lat: a lat/lon quadtree (not a cube sphere) because the authored data is lat/lon-aligned and the poles are ocean/ice; poles use a fixed cap mesh. Cube-sphere only pays if we later want authored content near the poles; skip.
- LOD tree: level 0 = whole globe (2 root quads x 8 faces fine), leaves = 533 yd ADT tiles (~0.7 deg of arc at R). Nodes pick source: ADT mesh (loaded), WDL tile (4x4 per 533 tile is the existing horizon data), or procedural heightfield (noise, the same fbm as the globe). Skirts hide cracks.
- Near tiles stay flat-authored: vertices are tile-local (as now) and the vertex shader applies the existing bend; the bend and the sphere agree by construction at the tile centre. Far/low-LOD nodes are real sphere patches generated on the GPU or in the worker.

### What fills the unauthored world
Phase 1: ocean only plus the existing continents (matches today's globe). Phase 2: procedural continents/ice/mountains from fbm on the unit sphere, deterministic, with a shelf falloff around authored land so no hard edge. Hosted (no WoW data): everything procedural, plus `FALLBACK_RECTS`.

### Frames and precision
- Planet-centred f64 on the CPU (JS numbers) for the camera/craft; each frame rebase to the eye: GPU gets eye-relative f32 (already done: origin rebasing, `origin[0]%4096`). Per-tile vertices stay tile-local f32; a tile's eye-relative offset is computed in f64 and uploaded per draw.
- Radial up = +Y only at the eye; far nodes rotate by their offset from the eye (the globe pass already builds the sphere under the eye each frame).

### Physics
Stays flat locally and authoritative below the handoff altitude (see SPACE-PHYSICS.md). Flat (x,z) is the lon/lat equirectangular position, so the handoff is a pure coordinate change. Radial gravity only enters in the orbital sim; ground racing is unchanged.

### Subsystems
- Streaming worker: unchanged for ADT residency; add a node scheduler (screen-space error) that requests WDL/procedural nodes and keeps ~200-400 live patches. Memory budget: patch = 33x33 verts x 16 B = 17 KB; 400 patches = 7 MB. Minimap colour for WDL nodes reuses the existing atlas (64x64 cells, one per tile) at 32 px.
- Water: sea level is the sphere at R; shallow-water tint from the same shelf function as the land edge so it blends instead of two palettes. Existing water meshes remain near; far patches use the analytic water colour.
- Clouds: already spherical shells; no change. Fog/haze: the single global model, applied by distance to both authored and procedural patches (removes the separate globe colour).
- Gates/NPCs/props/saves/M-map: stay in flat world coordinates; only the renderer maps to the sphere. Markers use `beaconScale` (race-flags.js).
- Terrain collision/probe: unchanged (flat probes).

## Phased plan (cheapest first)
1. **Remove the colour step (1-1.5 d).** Make the globe pass the colour authority at the seam: sample the same minimap atlas / WDL average colour in the globe shader for authored rects, use the same `fogTint`/`grade` and the same lit/ambient model as terrain, and blend by a height/shelf field (distance-to-authored-edge, noisy) rather than a fog ramp. No new geometry. Visual win is most of what the user sees.
2. **Height on the globe (2-3 d).** Displace the sphere by a low-res WDL heightmap (a 64x64 R16 texture built from WDL) in the ray-march or as a mesh, so horizon silhouettes agree with the terrain and the seam has matching height.
3. **Quadtree patches for the globe (4-6 d).** Replace the analytic pass with LOD patches (authored WDL/ADT where available, procedural elsewhere), depth-tested; fade out the flat horizon meshes entirely.
4. **Procedural continents/ice/poles (2-3 d).** Biome noise, polar caps, seeded.
5. **Merge near terrain into the tree (5-8 d).** ADT tiles become leaves, drop the separate bend path (curvature is native), unify water and horizon.

Total: roughly 15-22 days; steps 1-2 (about 3-4 days) deliver the requested fix.

## Risks
- Depth precision at 1e6 yd with near 0.5 yd: needs reverse-Z or log depth; the globe pass currently writes a custom depth.
- Cracks/seams between LOD levels and between authored and procedural patches (skirts, shared edge heights).
- Bend vs sphere mismatch (~8% at world edges today); step 5 removes it, steps 1-3 keep it.
- Perf: Standard clouds + patches + props on integrated GPUs; budget 1.5 ms for patches, measure with the gate.
- Streaming latency on high-speed descent: need predictive loading by velocity along the radial.
- Hosted build has no authored colours; the procedural fill must stand alone.

## Decision needed
Go for step 1 (and 2) first; defer 3-5 until the look is judged.

## KSP/Starfield reference and the recommended pivot

Source: `space-architecture-refs.md` (KSP wiki; PQS/ScaledSpace details are community-corroborated, not re-fetched, verify against Kopernicus before copying names).

| Technique | Verdict |
|---|---|
| Floating origin, camera-relative f32 | **Adopt** (already partly: origin rebasing). Make it the only path: f64 CPU, eye-relative upload, same-frame rebase for render and physics. |
| PQS cube-sphere quadtree | **Adapt**: lat/lon quadtree (authored data is lat/lon-aligned). |
| ScaledSpace proxy + PQS swap | **Adapt**: that is our current globe + terrain crossfade. Keep a scaled proxy only for the *moons* and the far globe; for Azeroth use one patch tree so no swap altitude exists. |
| Reversed-Z / log depth | **Adopt now** (day-one decision; replaces the custom globe depth). |
| Layered near/far cameras | **Skip** (reversed-Z is simpler). |
| Starfield separate scenes | **Skip** (defeats the goal); keep as the hosted/low-end fallback only. |
| Outer Wilds small scale | **Already done** (R = 42.8 kyd), keep. |

**Pivot recommendation.** Stop patching "flat world + bend + crossfaded analytic globe". Rip out: the vertex `bendShader` path, the fullscreen analytic globe pass (as the terrain authority), `PLANET_RAMPS` crossfade ramps, the separate horizon-vs-globe palettes, and the fog-vs-globe colour mismatch. Keep: ADT/WDL parsers and the streaming worker, tile-local flat frames, flat Rust physics (as the local bubble), minimap atlas, water shading, clouds (already shells), saves/M-map in flat coordinates, procedural stars/moons. New spine: planet-centred f64 frame, one patch tree for Azeroth, reversed-Z, one shading/fog model. Steps 1-2 above are still the cheap, reversible start; they do not block the pivot.

## Data model: sparse lat/lon chunk registry (`tile-registry.js`)

Adopted from user direction. The planet is not a tile grid; it is a **registry of chunks** and everything else is ocean.

- **Chunk** `{id, kind: 'adt'|'procedural'|'poi', bounds:[lat0,lat1,lon0,lon1], priority, blend, provider}`. Bounds are arbitrary lat/lon rectangles (radians), not tied to the 533.33 yd ADT grid, so the Maelstrom can be any size and sit anywhere. A bin covered by no chunk is open ocean (`OCEAN` height/colour/water).
- **Provider** `{sample(lat,lon)->{h,rgb,water}, objects?(bounds)}`. The `adt` provider wraps the WDL/ADT streaming worker and minimap colour; `procedural` is deterministic noise (the hosted build uses only these); `poi` is a procedural or authored provider with its own local frame (it receives planet lat/lon and converts internally).
- **Seams**: each chunk feathers its weight to 0 over `blend` yd inside its bounds (smoothstep); `sample` composites chunks over the ocean underlay in priority order, so edges meet ocean with no height or colour step. Overlaps: higher priority wins where its weight is 1. `blend:0` gives a hard edge for a deliberate cut.
- **Consumers**: the patch tree (`globe-patches.js`) calls `registry.sample` per vertex for height/colour and refines where `cover()` is non-empty (finer `maxLevel` inside chunks); the streaming worker loads tiles only for `adt` chunks near the eye; gates/NPCs/props come from `provider.objects`.
- **Add a POI chunk**: `registry.add({id, kind:'poi', bounds, priority, blend, provider})` (or a manifest entry); no renderer change.
- **Hosted fallback**: `defaultManifest()` builds both continents with `proceduralProvider`; with WoW data the same entries receive the `adt` provider.

Status: registry + tests landed (pure data model); wiring `registry.sample` into the patch-tree vertex height/colour is the next M4 step.
