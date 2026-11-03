# Creature collision spike

Status: prototype behind `creatureCollision` (default ON for the spike). No Rust changes, no craft-physics effect, no art or audio committed.

## Switching it off
Settings checkbox "Creatures react to the craft" (`#creature-collision`), localStorage `racer.creatureCollision`, or `client.creatureCollision(false)`. Off resets all state: everything is revived and visible next tick.

## How creatures work today
- Spawned in `scene-stream.js` (~523-530) from `npc-pack.js`; instance id `${map}:npc:${id}`, matrix from `npcMatrix`.
- `actors.js` `ActorService` (40 ms tick, started in `world-engine.js`) re-poses shared Stand loops per (model, phase), runs `wander.js`, and posts `pose` / `npc-moves` to the renderer (`renderer-actors.js`). `npcClass(path)` gives critter / civilian / creature.
- Before this spike nothing had a collision volume or any craft hit test. The pack has no faction data, so friendly vs hostile cannot be told apart.

## Where the overlap test lives
Worker side, in the existing actor tick (`creature-collision.js`, called from `ActorService.collide`):
- Craft source-space position is sampled in `updateScene`; speed = displacement per tick.
- Broadphase: cached NPC list (rebuilt only when the snapshot array changes), axis box around the swept segment ± `reach` (60 yd), then class and size gates, then an exact swept XY segment vs cylinder + z-range test (no tunnelling at 500+ yd/s).
- Creature cylinder comes from the resident asset's model-space `bounds` times instance scale. Models not resident are skipped.
- Cost: O(NPCs in the snapshot) per tick, early-out below the speed threshold; allocation only on a kill. Measured on real Data (`node creature-death-smoke.mjs`): handler p50 0.3 ms, p95 0.9 ms, p99 1.7 ms (gate 20 ms), 0 errors over ~19k frames.

## Death animation data (anim id 1)
Measured from the M2 sequence tables of the 219 distinct creature models in the spawn pack:
- 208/219 models have Death (covering 51,380 of 51,561 spawns); all 18 character models and 190/201 creature models.
- Length (ms): min 834, p25 1866, median 2367, p75 3000, p95 4500, max 7334 (Murloc 3867, Raptor 4333, Wolf 1833, Boar 1366).
- No Death clip: SpiritHealer, Human/Orc kid models, WoodenDummy, ArcheryTarget, Cupid, RocketCars, FlyingMachine. These are skipped: the craft passes through and they are not killed.
- Corpse pose = the Death clip sampled at `duration - 1 ms`, posted once under phase `d:<id>`. The renderer keeps that buffer, so holding costs nothing per tick. Sequence: dying -> dead (25 s) -> gone (hidden) -> respawn after 120 s.

## Death sound (spatial)
Direction: no gibbing; play the creature's own death animation and its own death sound at its location.
- Resolution (`creature-sound.js`, worker, from the user's Data, nothing stored): the spawn's `displayId` (`scene-stream.js` `npcDisplays`) -> `CreatureDisplayInfo` field 2 (SoundID, an override set on only ~3% of displays) else field 1 (ModelID) -> `CreatureModelData` field 13 (SoundID) -> `CreatureSoundData` field 6 (SoundDeathID) -> `SoundEntries` (files in fields 3-12 under the dir in field 23; one variant is picked at random). Paths must match `sound\...wav|mp3`. `CreatureDisplayInfo`/`CreatureSoundData` are read by header only (indexes verified on real 1.12.1 Data: 10273 of 10534 displays resolve a death sound, 183 unique files); `SoundEntries` uses the same 29x116 layout as `music.js`.
- A creature with no sound data, no death entry, a missing/oversized (2 MiB cap) file or an undecodable sample is silent; the death animation still plays.
- On a kill `ActorService.deathSound` posts `creature-sound {displayId, path, bytes?, x, y, z}`; bytes are sent only the first time a path is read. The main thread converts the source position with `sourceToRender` and calls `WorldAudio.spatial`, which decodes once per path, and plays it through a `PannerNode` (equal-power, inverse distance) joined at the analyser like wind. The listener is the renderer view (eye, look, up).
- Positional model (`spatialGain`): full gain within 8 yd, inverse rolloff 1.4, dropped beyond 320 yd, at most 6 concurrent voices. It needs the Sound setting on (same gate as other effects) and is muted with it.
- WoW .wav files are often ADPCM; if the browser's `decodeAudioData` rejects one, that creature stays silent (none occur in the real Data: all 183 death files are 16-bit mono PCM, 22.05 kHz except 2 kodo files at 44.1 kHz, none silent; the browser decoded a real one to 2.7 s, RMS 0.14).

## Proposed rules (as implemented, constants in `CREATURE_COLLISION`)
- Speed threshold 22 yd/s (hit volume grows with speed, see above); every hit on a creature that has a Death clip kills it.
- Classes: critter, creature, civilian. Large creatures (radius > 3 or height > 6: dragons, giants, elementals) are ignored so they can later block instead.
- No craft impulse or slowdown for now; later options: light slowdown on hits, hard block for large creatures.
- Rate limits: 8 kills/s, 6 simultaneously dying.
- Dead wanderers freeze in place.

## Speed- and boost-scaled hit volume
The craft's creature hit volume (`craftRadius` 2.5 yd, `craftHalfHeight` 1.5 yd) is multiplied by a scale `s` (`CreatureCollision.scale`, constants in `CREATURE_COLLISION`):
- 1x at rest / low speed (<= `scaleFrom` 22 yd/s, which is also the kill threshold), smoothstep up to 2x (`speedScale`) at `cruiseSpeed` 150 yd/s (the pod's default Cruise speed, `world-tuning.js`), 2x beyond that.
- 3x (`boostScale`) while boosting. Boosting = boost key held with throttle > 0 (`message.flags & 2`), sampled into `actorCraft[4]` in `world-engine.js` and passed through `ActorService.collide` to `update(..., boosting)`.
- Never pops: `s` chases `scaleTarget(speed, boosting)` with an exponential ease (`scaleTau` 0.25 s, frame-rate independent), so boost onset takes ~1 s to reach ~3x and release eases back. Speed is the measured horizontal displacement per actor tick. `s` resets to 1 on disable, first sample or a teleport gap.
- Scales the swept craft box radius and half-height, and the broadphase `reach` (60 yd + scaled radius). Nothing else: no terrain/physics/camera/pod code reads it; it only changes which creatures are hit. Creature-size gates are unchanged.
## Tests
`creature-collision.test.mjs`: swept overlap/tunnelling, speed threshold, priming/gap reset, class/size/disabled filters, no-Death-clip skip, Death state machine (dying/dead/gone/respawn), rate limits, pose hold-last-frame, no per-tick refilter, ActorService poses/`npc-fx`/removal/death-sound post, wander freeze. `creature-sound.test.mjs`: DBC chain with synthetic tables, malformed DBCs, read-once service and silent fallbacks, spatial gain.

## Open questions for you
1. Do creatures give anything back (score, combo, boost, nothing)?
2. Respawn: current 25 s corpse + 120 s respawn, or persistent until reload?
3. Friendlies/civilians: exempt them? (needs faction data, which the pack lacks.)
4. Big creatures: ignore, block, or bounce the craft?
5. Should the craft slow down on a hit?

## Real-data smoke
`browser\creature-death-smoke.mjs` (on-demand; needs `WOW_DATA` and `browser\pkg`; takes the heavy lock, free port, ~4 min because corpse/respawn are real time) flies the craft through a real Stormwind NPC and checks the Death hold, spatial sound (instrumented, muted), respawn (gone ~27 s, back ~148 s) and handler p99. Found: the pre-built wasm only loaded clips 0 and 4 (`SceneActor` `M2Rig::new(.., &[0, 4])`), so no creature had a Death clip and nothing could die; the one-line fix (`&[0, 1, 4]`) is in `client/crates/flats-racer-web/src/scene.rs` but the wasm was not rebuilt, so the smoke runs the stand clip as a stand-in for Death. Real Death clip pose, and the podracer skin (no `SWE1R_DATA`), remain unverified.

## Why some creatures did not react (basilisks) and the fix

Cause: the hit volume was a centred cylinder with radius max(bboxX,bboxY)/2, and creatures with radius > 3 were treated as "big" and ignored. M2 bounds include tails and are off-centre, so basilisks (x -6.41..2.71, y +-1.59, height 2.2 -> radius 4.56) were classed as big even though they have a 1.5 s Death clip. The z test also ignored the bounds' z-min (hovering models).

Fix (JS only, no Rust change; scene.rs already loads clips `[0,1,4]`): the hit volume is an oriented, offset box in the creature's local frame, `sizeOf -> [halfX, halfY, zLo, zHi, offX, offY]`. The "big" gate is footprint `sqrt(halfX*halfY) > 3` or height > 6.

Survey (`node creature-death-survey.mjs`, real Data; 5,434 displays / 51,561 spawns / 219 models):

| | before | after |
|---|---|---|
| reacts | 5,075 displays / 43,699 spawns | 5,232 / 48,158 |
| too-big | 328 / 7,397 | 172 / 3,052 |
| no-death (11 models: kids, dummies, targets) | 23 / 181 | 23 / 181 |
| size-varies | 8 / 284 | 7 / 170 |

208 of 219 models have a Death clip. Remaining too-big are genuinely large (dragons, giants, kodo, wyvern, ...), which block rather than die by design.

Real browser run: `SMOKE_PATH=basilisk SMOKE_TRACK=steamwheedle SMOKE_QUICK=1 node creature-death-smoke.mjs` (also `SMOKE_DISPLAYS=id,id`). Basilisk killed, real Death clip held, spatial sound played, handler p99 1.8 ms, 0 page errors.
