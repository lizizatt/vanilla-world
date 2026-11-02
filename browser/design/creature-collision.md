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
- No Death clip: SpiritHealer, Human/Orc kid models, WoodenDummy, ArcheryTarget, Cupid, RocketCars, FlyingMachine. These are gibbed instead (or fall back to `fallbackDeathSeconds`).
- Corpse pose = the Death clip sampled at `duration - 1 ms`, posted once under phase `d:<id>`. The renderer keeps that buffer, so holding costs nothing per tick. Sequence: dying -> dead (25 s) -> gone (hidden) -> respawn after 120 s.

## Gibbing options
| Option | Feasible | Cost | Status |
|---|---|---|---|
| Hide creature + procedural chunk/dust burst (`emitGib`, new `chunk` particle kind with negative lift as gravity) | yes | ~14 particles per gib, trivial | implemented |
| Tint chunks from the creature's own texture | yes, needs per-particle colour in the pool | small | follow-up |
| Split M2 geometry by bone/submesh at runtime and fling pieces (precedent: `wreck.js`/`renderer-craft.js` split-by-part) | yes | moderate (extra draw state per gib) | future |
| Impact sound | worker cannot play audio; add a main-thread `creature-hit` event. Procedural thud (WebAudio noise+sine) or the user's own game sound | cheap | not implemented |

## Proposed rules (as implemented, constants in `CREATURE_COLLISION`)
- Speed threshold 22 yd/s; gib chance 12 %, doubled at >= 70 yd/s; models with no Death clip always gib.
- Classes: critter, creature, civilian. Large creatures (radius > 3 or height > 6: dragons, giants, elementals) are ignored so they can later block instead.
- No craft impulse or slowdown for now; later options: light slowdown on hits, hard block for large creatures.
- Rate limits: 8 kills/s, 6 simultaneously dying.
- Dead wanderers freeze in place.

## Tests
`creature-collision.test.mjs`: swept overlap/tunnelling, speed threshold, priming/gap reset, class/size/disabled filters, gib probability and speed doubling, Death state machine (dying/dead/gone/respawn), rate limits, pose hold-last-frame, no per-tick refilter, ActorService poses/`npc-fx`/removal, wander freeze, gib particles. Full browser suite: 1204 pass; the one failure (`pole-body-source.test.mjs`) is the missing wasm pkg in this worktree.

## Open questions for you
1. Tone and rating: gore (chunks) vs cartoon poof; should kills on civilians/critters differ?
2. Sounds: procedural thud, your own game sound, or silence?
3. Do creatures give anything back (score, combo, boost, nothing)?
4. Respawn: current 25 s corpse + 120 s respawn, or persistent until reload?
5. Friendlies/civilians: exempt them? (needs faction data, which the pack lacks.)
6. Big creatures: ignore, block, or bounce the craft?
7. Should the craft slow down on a hit?
