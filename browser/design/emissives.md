# Emissives: what WoW 1.12 data offers and what we render

## What the data offers

| Source | Field | Meaning | Reaches JS? |
|---|---|---|---|
| M2 material | render flag `0x01` (UNLIT) | lamp glass, glow cards, flame sprites drawn fullbright (`m2_batches.rs`) | yes: `batch.emissive` |
| M2 blend | additive / mod2x | glow halos, light cones | yes: `batch.blend` |
| WMO MOMT | flags `0x01` UNLIT | exterior batch fullbright (windows, lamp panes); interior drawer `0x6b5190` ignores it | yes: `batch.emissive` (exterior groups only) |
| WMO MOMT | flags `0x10` SIDN + `sidn_rgb` | night-ramp glow colour added inside the lit sum (`0x6b4090`) | no: stopped in `RenderSubmesh.sidn` (scene.rs sets `None`) |
| WMO MOMT | flags `0x20` WINDOW | interior pane gets the brighter midpoint light | no |
| WMO MOCV | vertex colour alpha | interior baked lighting | partially (vertex colours) |
| M2 particles | flag `0x1` | unlit flames/smoke (Orgrimmar bonfires, braziers) | particle fx path only |
| M2 lights / attachments | torch, lamp attach points | not parsed; WoW 1.12 has no dynamic point lights on models | no |

Window textures (e.g. `MM_ELWYNN_WND_EXT__01`) are ordinary BLPs; lit windows are authored as UNLIT/SIDN
materials, not as a separate emissive map. The inn's exterior panes are `0x11` (UNLIT + SIDN).

## What we render

- Scene shader (`renderer-shaders.js`) multiplies by `light = mix(.4+.6*ndotl, 1, material.y)`, so `emissive`
  batches were always fullbright against the directional term.
- But `grade()` applied the sim-clock night tint `(.2,.27,.5)` and the night fog to every batch, so emissive
  geometry went dark and blue after sunset. Now `glow = material.y * nightK()` bypasses the grade
  (`mix(grade(c), c*(1+.35*glow), glow)`) and fog is reduced 60% at night, so lit windows, lamp glass and
  brazier flames stay bright. Daytime is unchanged (`nightK()=0` => `glow=0`).
- This makes every authored UNLIT exterior material (Stormwind windows and lamps, inn panes, M2 lamps and
  flame cards) glow at night with no art committed and no wasm change.

## From orbit

`night-lights.js` keeps the hand table of named settlements (palettes for Dalaran/Karazhan) as the baseline.
The ground renderer now records each non-craft, non-NPC scene instance that has an emissive batch
(`noteLitInstance`, one per instance) into 160-yd cells, and a cell's spot grows at 4/16/64 lit models.
Spots join the globe bake incrementally (`createNightBake().add`, <=16 per frame, only touched rows
uploaded), so towns you have actually visited light up exactly where the ground is lit.
Hosted/no-data worlds have no emissive WMOs, so the demo fallback is unchanged.

## Not done (needs wasm change)

Exposing SIDN colour/WINDOW flags (a per-batch intensity and tint instead of a boolean), and parsing M2
attachments to add small bloom sprites at lamp/torch points.

## Update: SIDN colour

The wasm now exports atch.sidn (MOMT SIDN RGB). The renderer packs it (4 bits/channel) into material.y (>=2) and the scene shader adds 	ex*sidn*1.3*night on top of the night-graded lit sum, so lit window panes glow in their authored colour. WINDOW (0x20) needs no change (interior lit path). M2 attachment lamps remain not done.
