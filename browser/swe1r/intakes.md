# Pod assemblies and intake audit

The 25 selectable SWE1R skins now always use the local **Podd/MAlt** assemblies
in the garage, races and free flight. There is no `fullPods` switch, Lod1
rendering path, or lower-detail pod fallback. Historical skin IDs stay stable.
The name table's `Part_Racer_Lod1_*` labels are used only to resolve those IDs;
their model entries are not read by the skin loader.

Missing/corrupt pairs or missing calibration throw a descriptive error. The
garage's existing error handler displays the reason and uses the ordinary
default craft, not a second version of the racer. The scenery lens is loaded
separately as a Part model; it is not a pod fallback.

No game geometry, textures or screenshots are shipped in this repository.
`poses.js` contains presentation calibration and attachment coordinates only.

## Assembly and pose

Early names use their exact table indices (Anakin 2/0, Sebulba 6/5,
Ben 40/39, Neva 30/29); the one-item drift applies only to late names.
Podd AltN entries address **child-pointer slots**; paired MAlt entries supply
replacement nodes. They are not additional scene roots. Each engine instance
and cockpit takes the finest drawable LOD branch, skipping the initial empty
pilot skeleton when necessary. Lower alternatives are not summed. Path-local
cycle detection preserves shared instances; flagged pivot transforms rotate
about their authored centers.

Podd's engine-instance translations are zero on disk. Static registration
uses a common 250-unit conversion for every complete instance, with translations
measured against the installed reference presentation. Matching native radial
fan centers is preferred over material envelopes. Fixed fronts/cockpits use
matching surface bounds, rejecting incompatible extents and avoiding engine/
cockpit atlas contamination. The resulting registration is stored explicitly,
not recomputed from a lower-detail racer at runtime.

The previous preview fitted material bounds after cutting vertices at the
side/height planes, and combined those fitted housings with borrowed fan cards.
That inflated Ben's housings and hid the fans. Complete native fans and housings
now receive **one transform together**. Ben has four separate engine instances.
The positive-X instances are roots 1/3 and negative-X instances 2/4: reversing
them puts Mawhonic's auxiliary turbines on the inside and misplaces Neva's
integrated engine/body surfaces.

Podd tether templates are stretched between the closest physical surfaces of
each engine and cockpit. Binder quads use the local binder image and the existing
beam shader; Ark and Neva do not get an added binder. Native exhaust plume cards
(116) are omitted because the existing particle renderer owns exhaust effects.
Native rear glow cards (117) stay part of their engine instances.

Camera origin, scale, vertical datum, attachment height, exhaust positions and
the 32 audited fan rotation anchors retain the prior presentation. A mismatched
fan count or a registration error above 10 model units rejects the payload
instead of silently substituting geometry. The fan geometry itself comes only
from Podd/MAlt. Physics hit boxes, tuning and collision code are unchanged.

**Scope:** these are calibrated static presentation poses, not recovered
original-game dynamic poses. Tether/binder placement is a presentation
reconstruction, not a claim that the original game's attachment animation was
recovered.

## Fans and samplers

Texture-child addressing selects mirror-repeat, clamp or repeat independently
on each axis; the UV divisor remains 4096. Ratts, Mawhonic and Elan's quarter
intakes use mirrored sampling rather than four repeated quadrants. Addressing
participates in material batching.

The audited radial-image list in `intakes.js` separates connected components
into individual batches with their own centers. A nonplanar hub sharing a fan
texture stays static. Each fan rotates about craft +X (original model +Y),
composed with the craft matrix in the existing uniform slab. No new per-frame
arrays, vertex uploads, buffers or bind groups are introduced. Idle is 2.5
rad/s, rising to 27.5 rad/s with throttle or absolute speed: presentation rates,
**not recovered original-game RPM**. Wreck pieces do not keep spinning.

Rectangular grilles, ducts, glow cards and housings do not rotate. Jinn's 578
multi-duct plate and Fud's rear-facing 381 cards remain fixed. The native paired
assemblies retain the same 13 animated skins / 32 independent fans.

| Pod | Skin suffix | Native radial fans |
|---|---:|---:|
| Sebulba | 254 | 0 |
| Anakin Skywalker | 255 | 2 |
| Teemto Pagalies | 256 | 2 |
| Ratts Tyerell | 257 | 2 |
| Aldar Beedo | 258 | 0 |
| Mawhonic | 259 | 4 |
| Ark Roose | 260 | 4 |
| Wan Sandage | 261 | 2 |
| Mars Guo | 262 | 2 |
| Ebe E Endocott | 263 | 0 |
| Dud Bolt | 264 | 0 |
| Gasgano | 265 | 0 |
| Clegg Holdfast | 266 | 2 |
| Elan Mak | 267 | 2 |
| Neva Kee | 268 | 0 |
| Bozzie Baranta | 269 | 0 |
| Boles Roor | 270 | 2 |
| Ody Mandrell | 271 | 2 |
| Fud Sang | 272 | 0 |
| Ben Quadinaros | 273 | 4 |
| Slide Paramita | 274 | 0 |
| Toy Dampner | 275 | 2 |
| Navior | 276 | 0 |
| Jinn Reeso | 301 | 0 |
| Cy Yunga | 302 | 0 |

## Verification and reproduction

All commands below run from `browser`, with `SWE1R_DATA` and `WOW_DATA` pointing
at the user's read-only local Data folders. Use a free server port (4197 for
this run), muted Edge, and the shared heavy lock.

- Full suite: `node heavy-lock.mjs --label pods-tests -- node --test --test-concurrency=1 .`
- All-pod front/side shots: set `PORT` and `LAB_PROFILE` to a private ignored
  profile directory, then run `node heavy-lock.mjs --label pods-shots -- node paired-pod-shots.mjs`.
  The harness checks actual renderer triangle counts and paired payload identity,
  freezes presentation, and writes 50 images plus a report to ignored
  `runtime/paired-pods/default`. Compare with the prior private reference shots.
- Animated worker check: set `WORLD_URL=http://127.0.0.1:4197/?test`,
  `POD_SKIN=swe1r-273`, `DRIVE_SECONDS=40`, `DRIVE_MODE=drive`, and a fresh
  `RUN_LABEL`, then run `node heavy-lock.mjs --label pods-drive -- node driving-smoke.mjs`.
  Every `POD_SKIN` run requires a paired craft, an advancing intake animation,
  worker-handler p99 below 20 ms, and zero errors. No opt-in quality flag is used.

The real-data regression zeros all legacy racer bodies and still loads every
paired skin. It also checks native source provenance, exact camera/exhaust/fan
anchors, binder presence, finite geometry, all 25 rotor counts and sampler
modes, corrupt-pair rejection and the separate scenery Part path.

Local 2026-10-29 worker gate: Ben rendered **1,052 triangles / four fans** for
**40.16 seconds**, travelled **654.5 yards**, handler p99 **1.90 ms**, errors
**0**. Scheduling/frame intervals and maximum stalls are separate metrics, not
the user's p99/error acceptance gate.

The final full Node suite passed **1,031/1,031 tests**, with no skips or failures.
All **25 front/side pairs (50 final images)** were reviewed against the prior
private reference captures. Ben's four fans are exposed, and Mawhonic's
auxiliary turbines sit outside the main pair. No unresolved missing instances
or housing/fan occlusion were identified in this static-view audit; original
live articulation remains outside the reconstruction described above.

The format interpretation is corroborated by the MIT
[swe1r-assets metadata](https://github.com/akopetsch/swe1r-assets/tree/main/src/SWE1R.Assets.Blocks/ModelBlock):
Podd/MAlt types and child-slot references, pivot transforms, and material
texture-child mirror flags. No implementation or art from those models is
copied into this repository.
