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
momentum: releasing thrust coasts. Ordinary orbital engines cannot add energy above their configured airspeed cap;
the pickup bypasses that engine limit.
Powered acceleration is **172 yd/s² total**, scaled by the analog trigger,
**replacing** both ordinary throttle and boost thrust during powered use.
This keeps the previous default powered launch acceleration (72 + 100) without
stacking engines; custom ordinary thrust no longer increases the powered total.
No gravity, ordinary thrust, ordinary boost duration or speed default was retuned.
Heat always rises normally (cold to full in 7.5 s), and overheat damage is
unchanged during powered use. Current damage is 0.15/s at full heat split 60/40:
a cold 15 s burn is survivable, so no additional damage headroom is necessary.
With default durability enabled, a cold 15 s burn leaves **29.0875% / 52.7232%**
engine health; normal cooldown leaves **24.55% / 49.6982%** (including one extra
ordinary-boost tick). No thermal immunity or damage scaling is applied.
The existing durability-off setting disables health damage, not the heat gauge;
its legacy overheat-wreck toggle still applies and can wreck at full heat.
Engine state survives world handoff. Holds spend neither charge nor engine time.
At exactly 15 consumed boost-seconds the active thrust downgrades even if the
button remains held. The orbital ordinary-engine governor checks total relative
airspeed, not just its horizontal component; above its regular speed limit it
cannot add energy along the velocity. Gravity can still accelerate the pod and
the governor never deletes launch momentum. Reverse/decelerating thrust remains
available. A final partial tick blends replacement and ordinary thrust by time.

Terrain is queried even at high altitude; no guessed terrain-height cutoff.
Unloaded samples hold, known empty air does not. Destination scenery is checked
before the first accepted step there. Inertial state and engine health transfer
unchanged, then the old worker releases its journey.

The worker also carries an orthonormal forward/up frame. Confirmed telemetry
includes its full quaternion, so SOI handoff no longer drops roll or reconstructs
attitude against the destination's radial up. After charge exhaustion attitude
eases within the retained launch control frame; changing renderer parent does not
change that reference frame. Camera offsets are metric vectors in this frame,
recharted without resetting their orbit. Both chase and cockpit keep their
physical eye and orientation across a swap.

### Manual attitude control in space

For a drive-mode podracer, **space** means an unsupported `orbit` journey with
radial altitude strictly above the current body's atmosphere edge: **1711 yd on
Azeroth, 0 yd on airless Elune**. Ground/hover, ramp guides, ordinary local jumps,
other vehicles and free-flight retain their existing controls.

Hold **right mouse and drag** to move the camera-centred aim (0.004 rad/pixel);
the pod nose smoothly slews to that aim, not relative to its own current axes.
Drag right looks right; drag up looks up. Controller:
hold **LB/L1 (standard button 4)** and use the **right stick**, with the existing
0.18 look deadzone and a maximum aim rate of **90 degrees/s** per axis. Without
the hold, the right stick and left-mouse drag still orbit the camera. The pod
slews along the shortest full-quaternion arc at at most **180 degrees/s**, with
**8/s exponential settling** and exact alignment below 1e-7 rad; it cannot
overshoot. Thrust follows the nose during the turn and the camera centre once
settled. Mouse uses the existing non-inverted camera convention; the inverted
ground pod-pitch binding does not apply.

On hold, seed the aim from the displayed camera, including existing look offset
and roll. Yaw is about that fixed hold-start up; pitch is about the yawed right.
Angles are accumulated from the hold-start frame, not extracted from a changing
Euler pose. Up travels continuously through vertical (including upside down);
there is no horizon flip, added roll input or incremental roll drift from repeated
mouse loops. The craft follows the complete aim quaternion, including this up.

The first manual hold takes over launch stabilization. Release preserves the
current inertial attitude immediately, including after charge exhaustion and across SOI changes;
it does not resume the old +/-20-degree automatic target. Landing/reset/manual
teleport ends this attitude mode with the journey. Accelerate, reverse and boost
all use the new nose direction; rotating alone does not rotate velocity. Heat,
damage, boost-use budget and gravity are unchanged. The ordinary full-airspeed
governor still forbids positive engine work above its cap, so at interplanetary
speed use remaining powered charge or aim thrust against motion to brake.

Mouse deltas belong to the held aim at the pointer event, never to a later
ordinary camera-orbit frame. The main thread integrates the visual aim and sends
an absolute inertial quaternion; client coalescing keeps the latest target/hold.
Zero-tick frames and collision holds cannot replay mouse increments. The worker
alone integrates the pod's rate-limited slew at 120 Hz. Only confirmed quaternion
telemetry drives the existing rigid f64-relative craft path; visual aiming does
not predict physics.

While held, the camera uses this same inertial aim, independent of the turning
pod and of the current SOI chart. On release it captures the exact displayed
frame relative to the current pod before easing back to normal follow (180
degrees/s maximum, 7/s settling). There is no release-edge eye/orientation snap.
Releasing before alignment stops the pod at its current attitude; the camera
returns smoothly to that attitude, not to the abandoned target.

The interaction uses pointer capture rather than introducing pointer lock.
The cursor becomes a grabbing hand during RMB control and returns on release,
cancel or focus loss; the context menu remains suppressed. No cursor trapping
or new Escape behavior is introduced.

Craft geometry is rigid: f64 CPU subtraction/rotation produces one camera-relative
matrix before f32 upload, bypassing per-vertex equirectangular bending. Camera
offsets use the same physical frame instead of treating chart increments as yards
at altitude. Terrain sampling and polar caps are deliberately unchanged.
Cockpit eye translation stays f64 rather than reading the GPU matrix's f32
translation. Globe regressions compare the physical seat and basis across
altitude/latitude/rebases; unbounded planar-coordinate fixtures explicitly disable
planet projection, since an arbitrary billion-yard Z is not a valid globe latitude.

### Placement and lifecycle

Open the track editor (T). The launch panel places, lists, rotates and deletes
objects independently of the track draft. Heading is in degrees. Changes save
immediately to IndexedDB, scoped by installation and body; track Undo does not
undo launch objects. Quarter-pipes have 48 yd radius and 16 yd entrance width.
Their directional guide is entered from the front, not the side/back.
Pickups fill, not stack, and remain consumed until reset/restore/reopen. Reset
clears charge and the journey, not saved placements. In-progress orbital journeys
and charge are not persisted across browser reloads.
Manual map teleports cancel charge/journey in both resident workers and refresh
their cached snapshots before switching bodies. A completed automatic handoff
also clears the old world's snapshot, so returning there cannot resurrect the
old destination and immediately swap back.

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
Azeroth after about **38.53 s** wall time. That original run used the former heat
exemption; the normal-heat follow-up is recorded below. Charge was zero and the
journey cleared. Moving p99 **7.1 ms**, zero page/world errors.
Run `node browser\pod-launch-smoke.mjs` with read-only `WOW_DATA` and `SWE1R_DATA`;
it owns its ephemeral port and the heavy-job lock. Screenshots/traces are ignored
under `browser\test-results\pod-launch`, not shipped as game assets.

### Normal-heat and presentation follow-up

The rebuilt-Wasm follow-up holds boost for **16 s after departure**, deliberately
one second past charge exhaustion. With a 104.35 yd/s departure it exhausts the
15 s budget while the button remains down, crosses the SOI at about **16.09 s**
and reaches Azeroth's surface at about **38.3 s**, approaching at **2769 yd/s**.
Heat reaches 1 during powered use; landing health is **15.55% / 43.70%** after
the extra ordinary burn and cooldown. Charge is zero and normal ground physics
resumes. Chase and cockpit runs both complete with zero page/world errors.
Returning to Elune through the actual map adds exactly one swap and stays there
in drive mode with no journey or charge.

Renderer CPU p99 is **7.8 ms chase / 7.9 ms cockpit**. RAF p99 is **48.7 / 34.7 ms**
(an earlier chase run was 76.4 ms), so the strict 20 ms RAF assertion did **not**
pass. The coordinator explicitly accepted functional/render-CPU evidence with
this scheduling caveat because the machine is shared with the user's games;
these measurements alone do not prove the spikes are external contention.
No performance retry or weakened assertion conceals that result.

`pod-presentation-smoke.mjs` captures the supplied 37,466.55 yd-high pose against
immutable `645d4891` and the candidate. Before/after PNGs are under ignored
`test-results/pod-presentation`; the candidate preserves rigid dimensions and
aligned engine effects with zero page/world errors. This is a frozen renderer
diagnostic, not trajectory evidence. Planet terrain/polar-ripple work remains
outside this patch.

### Original relative-attitude follow-up (superseded by camera-centred aim)

Run the attitude-specific production smoke with `ORIENT=1` and
`node browser\pod-launch-smoke.mjs` (same read-only asset variables). It launches
from the real ramp/pickup, performs an actual RMB drag, releases and verifies the
retained direction, burns sideways, then restores the launch heading and
continues to Azeroth. The measured velocity increment is compared to a matched
unthrusted production-solver continuation to separate engine impulse from
gravity. Its **20 ms p99 gate is worker handler time**, measured at the real
protocol handler entry/reply boundary by the diagnostic server, not RAF time;
RAF and renderer CPU values are still reported. Outputs are ignored under
`browser\test-results\pod-camera-aim` for the current camera-centred revision.

The final real-data run turned **90.069 degrees** with a 393-pixel RMB drag.
After release, **0.516667 boost-seconds** produced **88.8522 yd/s** along the new
nose and only **0.00011145 yd/s** off-axis versus the matched coast. Measured
acceleration was **171.972 yd/s²**, matching the unchanged 172 yd/s² powered
thrust. Turning back and completing the 15 boost-use seconds reached Azeroth
and returned to ground physics with zero charge and **33.81% / 55.87%** engine
health. Heat reached 1 normally; release restored the cursor without pointer lock.

Worker handler p99 was **1.5 ms over 5906 samples**; renderer CPU p99 was
**4.8 ms**, RAF p99 **7.1 ms**. There were zero page/world errors or unexpected
HTTP failures. Four optional NPC-pack probes returned 404 (private
`/local/npc-spawns.json` and public `/npc-pack.json`, once per world); population
loading explicitly permits absent companion packs, and the report retains those
misses separately rather than hiding them. The browser suite passed **985 tests,
0 failures, 8 skips**. Controller mapping/rates are covered by deterministic
tests; this smoke uses real pointer events, not physical controller hardware.

### Camera-centred aim revision

The revised real-data smoke holds RMB through aim convergence and the sideways
burn, measuring against the **actual renderer view's camera-centre direction**
converted from the eye chart to inertial space. A 393-pixel drag gave
**90.06863 degrees**. Consuming **0.516667 boost-seconds** added **88.85390 yd/s**
along that direction and **0.00020162 yd/s** off-axis versus the matched coast
(**171.9753 yd/s²** against 172 expected). Settled camera/nose vector error was
**5.55e-17**. Restoring the launch aim and releasing retained the pod attitude,
then completed the full charge, crossed the SOI at about **19.79 s** and reached
Azeroth near ground at **43.27 s** after departure. Ground physics resumed,
charge was zero, heat had reached 1 and engine health was **50.80% / 67.20%**.

Handler p99 was **2.0 ms over 5905 samples**, renderer CPU **5.9 ms**; zero
page/world/unexpected HTTP errors. The same four optional NPC-pack 404s were
retained separately. RAF p99 was **20.8 ms**, above 20 ms: the existing
worker-handler gate passed, not a strict RAF gate. No retry or metric substitution
hides that shared-machine scheduling caveat. Full browser regression suite:
**987 passed, 0 failed, 8 skipped**. Deterministic tests also cover exact
camera eye/look continuity on release in chase/cockpit, physical held-camera
continuity at SOI, shortest-arc/no-overshoot convergence, rate bounds, pole
crossing and no accumulated roll. No physical controller hardware was used.

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
