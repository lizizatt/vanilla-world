# Race gate / start-finish concepts (concepts only, nothing wired into gameplay)

Mock-ups: `node race-gate-concept-shots.mjs` (WOW_DATA, server on 4183, muted Edge) renders `race-gate-concepts.js`
at the Steamwheedle start into the git-ignored `runtime/gate-concepts/{A..D}-{near,far}.png`.
Every mock-up here is **procedural own art** (boxes, existing gate materials 5-8). No WoW or Racer art was rendered or committed.
Real-asset variants below are proposals, not yet mocked.

## Current state
Two pylons + crossbar + beam boxes (`race-flags.js`), opaque, no collision (gates are only trigger planes). Beam is the only far cue.

## What the local data offers
- **SWE1R** (user folder, `out_modelblock`): `Part_StartLineMachine` (309, 6.8 KB), `Part_Track_Flag` / `Modl_Track_Flag` (196/197),
  podium flags blue/red/white (123/125/126), `EnergyBinder` bars (146/49). Names are community labels, so confirm visually. Loadable through the
  existing `swe1r/pod.js` Part path (textures, batches); not yet mounted as scenery.
- **WoW** (M2, from the MPQ listfile): `Orc\HordeBanners\HordeBanner01-04`, `Orc\Banners\ClanBanner*`, `Orc\Flags\OrcFlappingFlag01`,
  `Human\Banners\Stormwind*`, `Human\FlagPole\Flagpole01`, `PVP\BattlefieldBanners\BattlefieldBannerAlliance/Horde*` (+ `*FlagOnly`),
  `Human\Arches\GardenArch*`, `NightElf\Gates\KalidarMoonGate`, `Orc\Braziers\TallBrazier01`, `Orc\LampPosts\*`, `Orc\TaxiFlags\OrcTaxiFlag`.
  The NPC actor path already loads M2 + animation; static scenery M2 placement would reuse that loader.

## Shared requirements (all concepts)
- Ground fade: the bottom 3.5 yd is a thin ghost post (mock-ups) or an alpha ramp 0 -> 1 over 0-3.5 yd (needs a new alpha-blended gate pipeline
  with a per-vertex height term; today gates are opaque). Gates stay non-colliding either way.
- Far visibility: emissive/additive top plus a tall beam (200-380 yd), as now.
- Rocket and pods: gate width follows `gate.width`; clearance 14+ yd, above both.
- Hosted: procedural only, same vertex layout, no data needed.

## Concepts
| # | Idea | Mock-up | Assets (local-data version) | Cost | Pros | Cons |
|---|------|---------|-----------------------------|------|------|------|
| **A** | **Lights gantry**: two stub-footed pylons, overhead span with a row of start lights and a chequered band, beams on both posts. Local-data variant: swap the span for SWE1R `Part_StartLineMachine` (309) and hang WoW faction banners on the posts. | `A-near/far.png` | none (hosted); SWE1R 309 + a banner M2 (local) | S hosted / M with 309 (mount a Part as scenery, orient, scale) | Reads as "start/finish" instantly; lights can animate to the countdown (red/amber/green) | Wide solid span: needs the ground fade and clearance care; 309 scale/orientation unknown |
| **B** | **Arch with banners**: stepped arch, hanging red/white banner panels, emissive keystone and beam. Local-data variant: WoW `HordeBanner0x` / `BattlefieldBanner*` panels and `GardenArch` or `KalidarMoonGate` as the span. | `B-near/far.png` | WoW M2 banners/arch (local) | M (static M2 scenery placement plus alpha ramp) | Most "in-world" look, themed per faction/zone | Depends on WoW data, per-model scale/pivot checks, banner cloth uses animation |
| **C** | **Pylon pair + beam column**: no crossbar, twin thin pylons topped with emissive caps and tall beams; next gate amber. Variant: translucent additive beam curtain between the beams. | `C-near/far.png` | none | S | Cheapest, fully clear for racers, visible from afar, checkpoints and finish can share it | Least special at the start line; needs an additive curtain for the "gate" feel |
| **D** | **Pennant line**: two masts, a cable and a row of red/white flags, beams on mast tops. Variant: WoW `OrcFlappingFlag01` / `Flagpole01` as masts, flags animated. | `D-near/far.png` | none (hosted); WoW flag M2 (local) | S hosted / M with M2 | Lightweight, festive, thin so it never occludes; flags can wave in the vertex shader | Cable invisible at distance; small silhouette without the beams |

Suggested default: **C** for checkpoints (cheap, many per lap) and **A** for start/finish (the only one needing real art), both with the ground fade.

## Licence / redistribution
- Hosted/procedural geometry (this repo): own code, safe to ship.
- SWE1R and WoW models stay in the user's local folders, read at runtime like the current pods and terrain, never copied into the repo or a pack that is published.
- Community model names are labels only; do not copy GPL tooling (louriccia/blender-swe1r, OpenSWE1R). MIT `akopetsch/swe1r-assets` may be ported with attribution.

## Not built / not decided
No gate has been replaced. Real-asset renders (309, WoW banners) are not mocked yet; they need the scenery-M2 mount from the cost column.
