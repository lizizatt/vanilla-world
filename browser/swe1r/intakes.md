# Pod intake audit

The 25 selectable SWE1R skins use the user's `Part_Racer_Lod1_*` models, not the
full animated `Podd` assemblies. Front shots and per-mesh positions, UVs,
materials and texture-child records were inspected on the local install.
No game geometry, textures or screenshots are shipped in this repository.

## Findings and implementation

The loader previously forced `repeat` on both sampler axes. In particular,
Ratts, Mawhonic and Elan use quarter-intake art with UVs spanning approximately
two texture widths/heights: repetition produced four unrelated quadrants.
The original texture-child addressing nibbles now select mirror-repeat,
clamp or repeat independently per axis. The 4096 UV divisor stays unchanged.
Material addressing participates in batching, rather than grouping solely by
image index. Existing texture-alpha classification is unchanged; the confirmed
quarter-fan defect was addressing, not missing alpha.

Radial fan cards were also static and merged with other meshes sharing their
texture. The audited radial-image list in `intakes.js` separates connected
components into individual batches with their own centers. A nonplanar hub
sharing a fan texture stays static. Each fan rotates around craft +X (original
model +Y, the intake axis), composed with the craft matrix in the existing
uniform slab. Positions/normals rotate together. No new per-frame arrays,
vertex uploads, uniform buffers or bind groups are introduced. Idle is 2.5
rad/s, rising to 27.5 rad/s with throttle or absolute speed; these are chosen
presentation rates, **not recovered original-game RPM**. Wreck pieces do not
keep spinning.

Rectangular grilles, ducts, glow cards and housings are **not** indiscriminately
rotated. Twelve skins have no separately identifiable radial fan card in the
loaded Lod1 geometry; these retain stationary fronts. This does not establish
whether their full-detail original-game assemblies have additional moving
parts. Jinn's texture 578 is a multi-duct plate, not a radial fan. Fud's texture
381 is at the engine rear, not its visible front, and stays stationary.

The format interpretation is corroborated by the MIT
[swe1r-assets material metadata](https://github.com/akopetsch/swe1r-assets/tree/main/src/SWE1R.Assets.Blocks/ModelBlock/Materials):
`MaterialTextureChild` byte 3 and `DimensionsBitmask` describe mirrored width
and height; `MaterialTextureExporter` expands those images by mirroring.
`PartModel` identifies the two-root RacerLod1 structure. No implementation or
art from those models is copied into the game.

## Per-pod result

“Addressing” includes original mirror/clamp flags on the model's other
materials, even when the intake itself did not require mirrored quadrants.
Numbers are runtime skin IDs; the model-block index is one greater.

| Pod | Skin suffix | Front issue and correction | Spinning parts |
|---|---:|---|---:|
| Sebulba | 254 | Addressing restored; angular fixed grilles preserved | 0 |
| Anakin Skywalker | 255 | Static fan cards separated; addressing restored | 2 |
| Teemto Pagalies | 256 | Static turbine cards separated; addressing restored | 2 |
| Ratts Tyerell | 257 | Four repeated quarters become a complete mirrored intake; sculpted hubs stay fixed | 2 |
| Aldar Beedo | 258 | Addressing restored; rectangular ducts preserved | 0 |
| Mawhonic | 259 | Repeated quarter fans reconstructed; main and auxiliary discs separated | 4 |
| Ark Roose | 260 | Two disconnected cards per engine no longer share a rotation center | 4 |
| Wan Sandage | 261 | Static radial cards separated; addressing restored | 2 |
| Mars Guo | 262 | Static radial cards separated; surrounding ring stays fixed | 2 |
| Ebe E Endocott | 263 | Addressing restored; sculpted front assembly preserved | 0 |
| Dud Bolt | 264 | Addressing restored; rectangular grille bank preserved | 0 |
| Gasgano | 265 | Addressing restored; tall nonradial front assembly preserved | 0 |
| Clegg Holdfast | 266 | Static turbine cards separated; addressing restored | 2 |
| Elan Mak | 267 | Repeated quarters become mirrored circular intakes | 2 |
| Neva Kee | 268 | Addressing restored; front art belongs to combined body meshes, not isolated fan cards | 0 |
| Bozzie Baranta | 269 | Addressing restored; front duct/body surfaces preserved | 0 |
| Boles Roor | 270 | Static radial cards separated; addressing restored | 2 |
| Ody Mandrell | 271 | Static radial cards separated; addressing restored | 2 |
| Fud Sang | 272 | Front body panels preserved; rear cards are not mistaken for front fans | 0 |
| Ben Quadinaros | 273 | Four fan cards now rotate independently, not around the pod center | 4 |
| Slide Paramita | 274 | Addressing restored; nonradial front panels preserved | 0 |
| Toy Dampner | 275 | Static radial cards separated; addressing restored | 2 |
| Navior | 276 | Addressing restored; front body panels preserved | 0 |
| Jinn Reeso | 301 | Addressing restored; multi-duct front plates deliberately stay fixed | 0 |
| Cy Yunga | 302 | Addressing restored; stacked duct/body surfaces preserved | 0 |

## Reproduction

With `WOW_DATA`, `SWE1R_DATA` and `PORT` pointing at a local server, run from
`browser`: `node heavy-lock.mjs --label intake-shots -- node intake-shots.mjs`.
`INTAKE_LABEL=before` or `after` chooses the private output directory:
`runtime/intakes/<label>/swe1r-<suffix>-front.png`. The after run also writes
`-spin.png` at a fixed 0.37-radian phase for every rotating model. `report.json`
records the per-pod pivots, textures and mirrored batch count. The harness
asserts that the actual craft is drawn, rather than accepting a nonblank
landscape as evidence; it uses muted Edge, the real loader and renderer, and
freezes physics while taking matched front views.

Pure tests cover addressing, disconnected parts, fixed hubs, pivot/axis
preservation, idle spin and frame-rate independence. With `SWE1R_DATA` set,
they also assert every pod's audited rotor count and retained beam geometry.
For the driving gate, `POD_SKIN=swe1r-273` on `driving-smoke.mjs` attaches the
user's Racer data and requires a loaded animated craft (four fans), rather
than measuring a fallback or cockpit-hidden model. `POD_BASELINE=1` skips the
new-animation assertion when comparing an older server without this feature.
All browser testing is muted and serialized through `heavy-lock.mjs`.

Verification on the local install: 25 before/after front pairs, visible phase
changes for all 13 animated skins (32 fan parts), 906 full-suite passes and 30
final targeted passes. The four-fan 40-second driving run covered 2,010 yards,
with handler p99 12.4 ms and zero errors. Concurrent gameplay on the same
machine produced seven handlers at or above 20 ms (maximum 119.8 ms); this is
not a zero-tail result. The user explicitly accepted p99 <20 ms and zero
errors as the gate while the machine was loaded.
