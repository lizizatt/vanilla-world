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
- Cost: O(NPCs in the snapshot) per tick, early-out below the speed threshold; allocation only on a kill. Expected to stay far below the 20 ms p99 handler budget (not measured in-browser here: `browser\pkg` wasm is not built in this worktree).

## Death animation data (anim id 1)
Measured from the M2 sequence tables of the 219 distinct creature models in the spawn pack:
- 208/219 models have Death (covering 51,380 of 51,561 spawns); all 18 character models and 190/201 creature models.
- Length (ms): min 834, p25 1866, median 2367, p75 3000, p95 4500, max 7334 (Murloc 3867, Raptor 4333, Wolf 1833, Boar 1366).
- No Death clip: SpiritHealer, Human/Orc kid models, WoodenDummy, ArcheryTarget, Cupid, RocketCars, FlyingMachine. These are skipped: the craft passes through and they are not killed.
- Corpse pose = the Death clip sampled at `duration - 1 ms`, posted once under phase `d:<id>`. The renderer keeps that buffer, so holding costs nothing per tick. Sequence: dying -> dead (25 s) -> gone (hidden) -> respawn after 120 s.

## Death sound (spatial)
Direction: no gibbing; play the creature's own death animation and its own death sound at its location.
- Resolution (`creature-sound.js`, worker, from the user's Data, nothing stored): the spawn's `displayId` (`scene-stream.js` `npcDisplays`) -> `CreatureDisplayInfo` field 2 (SoundID) -> `CreatureSoundData` field 6 (SoundDeathID) -> `SoundEntries` (files in fields 3-12 under the dir in field 23; one variant is picked at random). Paths must match `sound\...wav|mp3`. `CreatureDisplayInfo`/`CreatureSoundData` are read by header only (field indexes above are the 1.12 layout and could not be verified against real Data in this worktree); `SoundEntries` uses the same 29x116 layout as `music.js`.
- A creature with no sound data, no death entry, a missing/oversized (2 MiB cap) file or an undecodable sample is silent; the death animation still plays.
- On a kill `ActorService.deathSound` posts `creature-sound {displayId, path, bytes?, x, y, z}`; bytes are sent only the first time a path is read. The main thread converts the source position with `sourceToRender` and calls `WorldAudio.spatial`, which decodes once per path, and plays it through a `PannerNode` (equal-power, inverse distance) joined at the analyser like wind. The listener is the renderer view (eye, look, up).
- Positional model (`spatialGain`): full gain within 8 yd, inverse rolloff 1.4, dropped beyond 320 yd, at most 6 concurrent voices. It needs the Sound setting on (same gate as other effects) and is muted with it.
- WoW .wav files are often ADPCM; if the browser's `decodeAudioData` rejects one, that creature stays silent (not verified on real Data here).

## Proposed rules (as implemented, constants in `CREATURE_COLLISION`)
- Speed threshold 22 yd/s; every hit on a creature that has a Death clip kills it.
- Classes: critter, creature, civilian. Large creatures (radius > 3 or height > 6: dragons, giants, elementals) are ignored so they can later block instead.
- No craft impulse or slowdown for now; later options: light slowdown on hits, hard block for large creatures.
- Rate limits: 8 kills/s, 6 simultaneously dying.
- Dead wanderers freeze in place.

## Tests
`creature-collision.test.mjs`: swept overlap/tunnelling, speed threshold, priming/gap reset, class/size/disabled filters, no-Death-clip skip, Death state machine (dying/dead/gone/respawn), rate limits, pose hold-last-frame, no per-tick refilter, ActorService poses/`npc-fx`/removal/death-sound post, wander freeze. `creature-sound.test.mjs`: DBC chain with synthetic tables, malformed DBCs, read-once service and silent fallbacks, spatial gain.

## Open questions for you
1. Do creatures give anything back (score, combo, boost, nothing)?
2. Respawn: current 25 s corpse + 120 s respawn, or persistent until reload?
3. Friendlies/civilians: exempt them? (needs faction data, which the pack lacks.)
4. Big creatures: ignore, block, or bounce the craft?
5. Should the craft slow down on a hit?
