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
direction; returning instantly to the ground's ±20-degree target would make a
90-degree burn impossible.

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
