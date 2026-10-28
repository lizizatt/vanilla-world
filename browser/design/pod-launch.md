# Placeable ramps and powered ballistic pod travel

## Scope and delivery order

1. Invert pod pitch at the input boundary only. Interpretation of the user's
   abbreviated request: ArrowDown / stick down now raises the nose. One shared
   sign; no physics, camera or free-flight convention changes.
2. Body-aware, locally saved launch objects: curved ramps ending at 15, 25, 45
   or 90 degrees, and a collectible charge for 15 seconds of powered boost use.
   Reuse the track editor's top-down placement/probe workflow and IndexedDB.
   Original procedural geometry only; no new game-derived assets.
3. Authoritative ballistic continuation of pod drive, inverse-square gravity,
   existing body charts and renderer/world-engine handoff. Tune only powered
   boost acceleration; prove a full 15-second burn after a 90-degree launch just
   outside the Elune base coasts to Azeroth. Then real-data and p99 gates.

## Object and charge contract

Objects have stable id, body, kind, position and heading; ramps also have the
selected angle. Save one versioned object list per source/body. Reject damaged
records visibly without overwriting them. Placement snaps the entrance/pickup
to ready ground; editing does not move the vehicle. List/select, rotate, delete
and save remain available. Instances are filtered by active body.

A ramp is a smooth curved guide, not a vertical wall with a fake launch impulse.
Its tangent starts horizontal and ends at the selected angle. Contact redirects
velocity along the tangent; gravity costs kinetic energy on the climb. Entrance
crossing is swept, directional and width/height bounded. Side/back approaches
must not trigger it. The 90-degree variant is a quarter-pipe. Its render mesh and
contact path share the same dimensions. Scene/terrain readiness and obstacle
collision remain authoritative; an unloaded exit cannot be treated as clear.

A pickup fills (does not stack beyond) 15 boost-seconds. Time is deducted only
when positive engine thrust actually uses powered boost. Pause, idle, coast,
reverse and streaming holds spend none. A final partial tick gets only its
remaining powered fraction. The powered charge is separate from ordinary heat:
it must be usable for the promised 15 seconds, not wreck the pod after 13.8.
Consumed pickups must not refill every frame. Object persistence is distinct
from transient pickup/charge state; reset behavior must be explicit in help.

## Ballistic motion and transitions

Keep the existing Rust ground/hover/collision path. A ramp departure carries its
actual position, velocity, attitude and remaining charge into one authoritative
fixed-step inertial solver, not a fly-camera speed law. It is still pod drive:
the craft and cockpit render, controls remain pod controls, and releasing boost
coasts rather than stopping. Do not mix a main-thread predictor with a worker
authority. Attitude during ballistic travel must retain the ramp's launch
direction while charge remains. When exhausted, attitude eases back toward the
normal +/-20-degree target at 8/s, rather than allowing ordinary thrust to remain
vertical forever. Steering resumes then. There is no automatic aiming.

Use the body's configured pod surface gravity (Azeroth 48, Elune 24 by default)
with inverse-square falloff; convert position and velocity through existing
chart/inertial helpers, including the moon's moving frame. Gravity comes from
both bodies, not an instantaneous acceleration jump at the visual SOI boundary.
Use existing SOI hysteresis to choose the near-world renderer/streamer. Preserve
inertial position/velocity through the swap; block explicitly if the target
engine/data is unavailable rather than silently teleporting or reloading away
the flight. On approach, stream collision ahead and atomically transfer momentum
back to ground physics only when ready.

No automatic aiming at Azeroth, arbitrary altitude ceiling, base-gravity change,
or free-flight changes. A benchmark launch location and heading outside the base
must be recorded: a launch on the far side of the moon cannot be promised the
same destination. Ordinary Azeroth thrust remains below gravity; this prevents
sustained powered ascent, not arbitrary pre-existing ramp momentum. The earlier
extreme-ramp counterexample still forbids a universal altitude-bound claim.

### Approved local/interplanetary distinction

Ordinary ramp departures retain the existing constant-gravity local law and
horizontal drag/cap. Only a departure with pickup charge enters inverse-square,
two-body flight. It stays ballistic after charge exhaustion and returns to normal
Rust ground/hover physics on collision/landing in the destination well. This
explicitly authorized distinction changes neither ordinary tuning nor any
altitude ceiling. Keeping inverse-square gravity for an unpowered 300 yd/s
quarter-pipe launch was demonstrably unsafe: even at 20 degrees, ordinary boost
could eventually outrun declining gravity. Attitude smoothing alone was not a fix.

Interplanetary flight has no ambient hover drag or speed clamp that deletes launch
momentum: releasing thrust coasts. Ordinary engines still cannot add horizontal
speed beyond their configured cap; the pickup bypasses that engine limit.
Powered acceleration is **100 yd/s² extra**, scaled by the analog trigger,
on top of the ordinary configured engine (72 yd/s² airborne at full default boost).
No gravity, ordinary thrust, ordinary boost duration or speed default was retuned.
Its charge also protects against heat damage during the powered fraction of a
tick. Ordinary heat/durability still advance outside that fraction and survive
world handoff. Holds spend neither charge nor engine time.

Terrain is queried even at high altitude; no guessed terrain-height cutoff.
Unloaded samples hold, known empty air does not. Destination scenery is checked
before the first accepted step there. Inertial state and engine health transfer
unchanged, then the old worker releases its journey.

### Placement and lifecycle

Open the track editor (T). The launch panel places, lists, rotates and deletes
objects independently of the track draft. Heading is in degrees. Changes save
immediately to IndexedDB, scoped by installation and body; track Undo does not
undo launch objects. Quarter-pipes have 48 yd radius and 16 yd entrance width.
Their directional guide is entered from the front, not the side/back.
Pickups fill, not stack, and remain consumed until reset/restore/reopen. Reset
clears charge and the journey, not saved placements. In-progress orbital journeys
and charge are not persisted across browser reloads.

Load Azeroth from local Data first so both world workers are warm before going
to Elune. Standalone Elune without an available Azeroth worker cannot complete a
handoff: it stops with an explicit error instead of reloading or teleporting.
Custom tuning and arbitrary launch headings are not promised to reach Azeroth.

## Measured results

Deterministic production solver: chart `[-300,10,0]` on Elune, heading 0,
150 yd/s entrance speed, time 720, coast up the guide, then full 15 boost-seconds.

| Ramp | Outcome after charge exhaustion |
|---|---|
| 15 degrees | Escapes Elune but misses Azeroth; no artificial angle cutoff |
| 25 degrees | Escapes Elune but misses Azeroth |
| 45 degrees | Escapes Elune but misses Azeroth |
| 90 degrees | Reaches Azeroth below 500 yd in 38.1 s, about 2803.5 yd/s; approximately 23 s coasting |

With **no pickup**, default Azeroth 90-degree ramps at 150 / 300 yd/s and held
ordinary boost return to ground: peaks **770.55 / 2268.87 yd**. These assume
10 yd entrance elevation, full 20-degree nose-up after stabilization and even
unlimited survival of overheating. The second peak can cross the visual
atmosphere/cloud band, but neither escapes or crosses the full-space band
(5193 yd). These are explicit launch cases, not bounds on arbitrary initial energy.

Real Data + SWE1R production input/worker/Wasm smoke also exercises editor
placement/rotation/deletion and cockpit view. Ramp entrance `[-300,16.25,0]`,
pickup `[-300,14.4813,60]`, heading 0, approach from z=220:
entry about **113.9 yd/s**, departure **103.4 yd/s**, 15 boost-seconds,
SOI crossing about **16.15 s** after departure, then ordinary-physics landing in
Azeroth after about **38.53 s** wall time. Both engines remain healthy; charge
is zero and the journey is cleared. Moving p99 **7.1 ms**, zero page/world errors.
Run `node browser\pod-launch-smoke.mjs` with read-only `WOW_DATA` and `SWE1R_DATA`;
it owns its ephemeral port and the heavy-job lock. Screenshots/traces are ignored
under `browser\test-results\pod-launch`, not shipped as game assets.

## Evidence required before claiming completion

- Both pitch signs, devices and unrelated mode mappings.
- Object validation, body isolation, persistence and directional swept contact
  for all four ramp angles, including low-speed rollback and blocked exits.
- Charge consumption in split ticks, holds, pause, release/resume and pickup
  re-entry; ordinary boost remains unchanged.
- Deterministic production-solver launch/burn/coast trajectory: launch speed,
  powered acceleration, burn time, peak/apex, SOI crossing, arrival time/speed,
  no thrust after exhaustion, frame-rate agreement and finite state.
- Real-data editor placement, pickup, ramp departure, cockpit and handoff, using
  an isolated port and the heavy-job lock. Moving-frame p99 about 20 ms, zero
  page/world errors. Never substitute a hand-crafted source-snippet trajectory
  for an actual input/worker path.
