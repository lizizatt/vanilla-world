# Space physics: one continuous envelope

Status: design only. Requirement: any physics object (a rocket, a craft, a debris piece) moves smoothly from the flat, locally rendered world, up through the atmosphere, across the space boundary, into orbit, and back down, with position, velocity, orientation and forces continuous across every handoff. Azeroth is static (non-rotating) and a hoop or landing pad on it is a fixed target.

## Today
- Flat Rust physics (racer, wasm worker) owns the craft at (x,y,z) in yards, flat gravity, ground collision, 60 Hz fixed step.
- Fly mode is camera/render only: the pose [x,y,z,yaw,pitch,qx..qw] moves by a speed law, sub-point = (x,z) = lon/lat on a sphere of R = 42,785 yd (space.js), orientation is a quaternion (orient.js).

## Architecture
- **Bodies:** Azeroth (static, at origin), two moons on analytic rails (circular, tilted, fixed periods, already animated in space.js), the sun as a distant direction/light only. Rails first; n-body-lite later only if a craft needs to perturb nothing (test particles never affect bodies).
- **Test particles:** craft/projectiles integrate under gravity from Azeroth plus moons (sum of point masses with softening inside the body radius). No body-body dynamics, so the system is deterministic and cheap.
- **Frame:** one Azeroth-centred inertial frame, f64 in JS (and f64 in the Rust integrator). The flat world is a local chart: flat (x,z) <-> lon/lat <-> unit radial; flat y = altitude above sea level. Origin rebase to the eye each frame for the GPU (already done).
- **Integrator:** velocity-Verlet at a fixed 60 Hz with adaptive sub-stepping (dt/n so the per-step angle swept about the dominant body is <= ~0.5 deg; fine for hyperbolic/low orbits). RK4 only for the prediction line. Time-warp: on rails above the atmosphere (analytic Kepler propagation) with a physics-warp cap of 4x; no warp below the atmosphere edge.
- **Determinism:** fixed dt, no wall-clock in the step, seeded noise only, f64 throughout, inputs recorded per tick so a run can be replayed (test fixture).

## Gravity and handoff (the continuity rule)
There is one force model, not two modes. Gravity = -mu*r/|r|^3 with mu chosen so g(surface) equals the flat gravity (g0). Near the ground the flat chart is a first-order approximation of this field, so the handoff is a smooth blend of the *integration chart*, not of the physics:
- Below `H_flat` (~500 yd, where bend starts) the flat Rust solver is authoritative for contact, wheels/hover, collisions, and its gravity is the local g0 along +Y.
- Between `H_flat` and `H_edge` (~6 km, atmosphere edge ~12% of R) both agree to O(h/R) (<1% at 500 yd); the orbital integrator is authoritative for translation, the flat solver supplies only drag/lift/thrust forces and contact when the terrain probe says ground is within a few yards.
- Above `H_edge` only the orbital integrator and the thrust model apply. Gravity direction is the radial toward the centre, never the camera look direction.
- Continuity: on each handoff, transfer state in the inertial frame (position, velocity, angular velocity, quaternion); the chart change is a rotation of the local frame (radial up) applied to velocity and attitude simultaneously, so no step in v or q. A test asserts |dv| and |dq| per step stay within the normal step change across the boundary, forward and reverse.
- Flat (x,z) of the craft is always derived from the sub-point; saves keep the existing flat pose plus an inertial velocity (new fields optional; old saves load as grounded).

## Atmosphere
Exponential density below a hard H_edge (~6 kyd), zero above. Drag = -0.5*rho*Cd*A*|v|*v (static air). Aero authority fades to reaction wheels as rho falls.

## Controls (6DOF)
Thrust W/S fore-aft, A/D lateral, R/F vertical; Shift/Ctrl throttle; Q/E roll; pitch/yaw via the existing quaternion (no gimbal lock). SAS holds: attitude, prograde, retrograde, radial, target. Precision mode 0.25x. Cameras: chase, orbit, map.

## Prediction and map
RK4 unthrusted trajectory from the same force model, 2-10 min, drawn in map and world; apo/periapsis and period on the HUD. Same code as the integrator, so it matches flight except thrust and drag.

## Landing and targets
Azeroth is static, so a hoop is a fixed radial + chart position, judged in the flat chart below H_flat with the Rust contact test. Moons: tidally locked, static moon-local frame.

## Existing fly mode
Becomes the kinematic variant (photo/explore); thrust replaces the speed law when physics mode is on.

## Ownership
Rust: force model, integrator, contact below H_flat (one crate, same code for prediction). JS: UI, camera, rails, map, rendering, handoff glue.

## Tests
- Energy and angular momentum conservation of a circular and an elliptical orbit over N periods (relative drift < 1e-6 without drag).
- Determinism: replay recorded inputs, bit-identical state hash.
- Handoff continuity: ascent from the ground through H_flat and H_edge and back, per-step |dv| and |dq| bounded; sub-point round trip flat -> inertial -> flat < 1e-6 yd; matches existing sub-point tests.
- Flat limit: low altitude trajectory agrees with the flat solver within tolerance.
- Drag: terminal velocity and monotone decay in the atmosphere.
- Prediction line vs actual unthrusted flight: error bounded.

## Phased plan (days)
1. Shared Rust force model + integrator + conservation/determinism tests (3).
2. Handoff band and continuity tests wired to the flat solver (3-4).
3. Free-flight controls, thrust/attitude, SAS holds (3).
4. Prediction line + map view (2-3).
5. Atmosphere drag and re-entry limits (2).
6. Moon surface + landing frame (3-4).
7. Target/hoop assessment and polish (2).

About 18-22 days. No build before the go.

## KSP/Starfield reference and the recommended pivot

Source: `space-architecture-refs.md` (KSP wiki; PQS/ScaledSpace not re-fetched).

| KSP technique | Verdict |
|---|---|
| Floating origin + Krakensbane (velocity rebasing) | **Adopt**: f64 CPU state, eye-relative f32 render. Krakensbane **adapt** only if jitter appears above ~1 kyd/s; rebase render and physics in the same frame, re-expressing cached velocities, emitters and particles. |
| Physics bubble vs rails | **Adopt**: only the active craft (and nearby props) is integrated; moons and everything else is analytic. It matches our flat tile residency. |
| Patched conics / SOI (rSOI = a(m/M)^2/5) | **Adapt**: use SOI only to choose the dominant body for rails/prediction; the active craft uses the summed point-mass field, so no one-body switch skip (KSP pitfall 5). Moon-in-Azeroth SOI is a hierarchy, not a coupled system. |
| Rails warp (to 100,000x) vs physics warp (to 4x) | **Adopt**: no rails warp in atmosphere, under thrust or near a body; analytic Kepler propagation for warp; reconcile angular velocity on exit (pitfall 6). |
| Hard atmosphere cutoff (Kerbin 70 km) | **Adopt** a hard `H_edge`: zero drag above it, a clean regime switch. Replaces the exponential-to-infinity above. |
| Scaled space + PQS | **Adapt** (see GLOBE-REFACTOR.md): one patch tree for Azeroth, scaled proxies for moons. |
| Reversed-Z / log depth | **Adopt** (renderer day-one). |
| Starfield loading-screen scenes | **Skip**. |

**Pivot recommendation.** Treat the current flat fly mode as the *local chart* of one planet-centred f64 simulation rather than a separate world with a crossfade to a picture of a globe. Rip out: the altitude speed-law as the movement model (keep as the kinematic/photo mode), the bend + crossfade presentation, and the flat-only assumption in the camera. Keep: Rust flat solver as the authoritative contact/vehicle model below `H_flat`, quaternion orientation, sub-point maths, HUD. Build the shared Rust force model first (phase 1), because everything else (handoff, prediction, rails) depends on it.
