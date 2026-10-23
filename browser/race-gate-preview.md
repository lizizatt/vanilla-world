# Race gate preview (A start gantry, C checkpoint gate, overworld flag-beacon)

PREVIEW ONLY: nothing here is wired into gameplay. Renders are an alternate-adapter mock-up at the Steamwheedle start.

Run (on demand, ~2 min; needs the 4183-style server, `WOW_DATA`, `SWE1R_DATA`):

```
$env:WOW_DATA=...; $env:SWE1R_DATA=...; $env:PORT=4183; cd browser; node race-gate-preview-shots.mjs
```

Output (git-ignored, never commit): `runtime/gate-preview/p-*.png` (33 shots) and `runtime/gate-preview/preview-sheet.png`.
Each element has a **local** version (real SWE1R/WoW models) and a **hosted** version (procedural boxes/quads only, no Racer/WoW data).

Code: `race-gate-preview.js` (builders + `fadeGround`, unit-tested in `race-gate-preview.test.mjs`), `race-gate-lab.mjs` (Edge launcher),
`race-gate-explore.mjs` (model candidate viewer). Props are drawn through the new `renderer.setProps` (craft path; test hook `worldTest.props`).

## Assets used (local version)

| Role | Asset | Scale / anchor |
|---|---|---|
| Gantry posts | WoW `World\Generic\Human\Passive Doodads\FlagPole\Flagpole01.m2` (1.0x1.1x10 yd) | x1.7 (17 yd) at y=+-w/2 (w=30 yd), base z=0, ground fade |
| Hanging banners | WoW `World\Generic\PVP\BattlefieldBanners\BattlefieldBannerHorde.m2` (1.3x3.2x6.3 yd) | x1.4, top at crossbar z=15, y=+-0.55*h |
| Start-light lens | SWE1R model 309 (`Part_StartLineMachine` by community naming; actually a small translucent faceted lens/diamond, 40x57x97 units, 40 tris, 1 alpha batch) | 2.4 yd wide, tinted red/amber/green; an additive glow box sits in front because the dark lens texture is dim |
| Checkpoint pylon | Flagpole01 | x0.95 (9.5 yd), ground fade |
| Pylon cap | WoW `World\Generic\Orc\Passive Doodads\Braziers\TallBrazier01.m2` (2.9x2.9x3.4 yd) | x1.5 at z=9.3 |
| Label pole | Flagpole01 | x3 (30 yd) |
| Label banner | WoW `...\Orc\Passive Doodads\HordeBanners\HordeBanner01.m2` | x2.4, top at z=29 |

Procedural (both versions): crossbar 30x1.4x1.6 yd at z=15, 2-row chequered band (z 16.4-18.4), lamp housing, additive beam columns, curtain, hosted posts/pylons/pole/pennant.

SWE1R candidates looked at and rejected (no model reads as a gantry): 308, 310, 306, 307, 196 (single quad flag), 123/124/125/126 (podium parts), 49 (EnergyBinder quad), 71 (arrow). `Modl`-tagged models (197, 146) are not loadable by the pod loader. The honest finding: SWE1R's start machine is only usable as a lens/dressing; the gantry body is procedural.

## Numbers

- Ground fade: every triangle is clipped at z = 3.5 yd (`FADE_YD`); vertex alpha ramps 0.12 -> 1 below it; opaque batches become alpha-blended. Applied to posts/pylons/gantry mesh only. Beams carry their own vertical alpha gradient.
- Start lights: phase 1 red, 2 amber, 3 green (same order as the countdown); off lamps are 12-15% grey.
- Checkpoint: beams r=0.7 yd (next) / 0.4 yd (passed), z 10.5-140 yd, alpha 0.3 (pulsing) -> 0 at top, amber; passed = cyan-grey alpha 0.2. Curtain: 24x9 yd additive quad alpha 0.02-0.22.
- Label: beam r=1.6 yd core + r=5 yd halo, z 30-700 yd, alpha 0.6/0.12 -> 0 at the top (sky shows through).
- Vision-judge pass (one iteration): A/C/label read at near/mid, C and label at far; fade works. Applied: softer checkpoint beams, bigger lamp glow. Not applied: beam soft radial falloff and min pixel width (need a shader/billboard).

## Overworld label placement and map

Place one label at each `tracks/*.json` `start.pos` offset 12 yd to the side (use `flagPosition`), with a ground-snapped base (the pole is not faded; it is off the road):
Steamwheedle (-900.2, 5664.8), Track To Sea (-787.4, 5722.9), IF Airport Track (19486.0, 5702.9). Show only within the existing flag load range for the pole, but always keep the beam active to ~5000 yd (cheap: 1 batch). On the map, draw a pulsing amber dot with the track name at the same position (existing map POI layer).

## Cost to wire in

- Gantry/checkpoints: small. Reuse `setProps`-style static draw for the dressing (promote to a real prop list), keep gates on the existing race-flags path; ~1 day incl. lights driven by the countdown state. Checkpoint state (next/passed) comes from the existing gate index.
- Alpha pass: the fade is CPU-clipped at build time (no shader change). One extra blended draw per gate.
- Beacon: needs a shader flag for fog immunity (today additive beams brighten with fog distance) and distance-scaled width/billboard so the far beam does not become a hairline: ~0.5-1 day.
- Local models need the WoW (and optionally SWE1R) folder; hosted falls back to the procedural versions, which are always available. Never commit models, textures or renders.
