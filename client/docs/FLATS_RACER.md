# Hover racer and world explorer (custom fork)

This is an opt-in, single-player client-authoritative vehicle mode, not a change to
normal walking or a competitive multiplayer authority model. It uses the existing
world, renderer, mount/rider attachment pipeline and Avian 0.6 collision queries.
There are no laps, checkpoints, new maps or asset files in this change.

## Launch and controls

Build a separate executable from this worktree (one build job):

```powershell
$env:CARGO_TARGET_DIR = "$PWD\target-racer"
cargo build --manifest-path client\Cargo.toml -p benilla --profile play -j 1
$env:WOW_DATA = 'C:\Users\liz\Downloads\Stonetavern-Classic-1.12.1-v1.8\Data'
$env:WOW_FLATS_RACER = '1'
$env:BENILLA_HOME = "$PWD\target-racer\player-state"
& .\target-racer\play\benilla.exe
```

Run the focused client and world racer tests together from the repository root:

```powershell
$env:CARGO_TARGET_DIR = "$PWD\target-racer"
cargo test --manifest-path .\client\Cargo.toml -p benilla-app -p benilla-world --lib racer --profile play -j 1
```

Including both packages keeps dependency features aligned with the app graph and
reuses the same target/profile cache. Testing `benilla-world` alone can select a
different dependency feature graph and trigger a cold rebuild.

The server must also explicitly enable the custom mode; see
[`server/doc/FlatsRacer.md`](../../server/doc/FlatsRacer.md).
An unmodified or disabled server cannot grant it.
Log in normally on outdoor map 0 (Eastern Kingdoms) or 1 (Kalimdor), on clear,
level ground. The original test location is the Shimmering Flats near WoW
`(-6235, -3945, -58.75)`. Do not launch a second client on an account already
playing. F8 requests mount/unmount; the server's SYSTEM acknowledgement and
display 10318 must arrive before the local controller takes ownership.

| Control | Action |
| --- | --- |
| W | Thrust |
| S | Brake |
| A / D | Steer |
| Shift | Boost (limited reserve, regenerates off boost) |
| Ctrl | Drift (reduced lateral grip) |
| Space | One hop per press; airborne steering remains available, no flight |
| F9 | Server-authorized safe reset; motion waits for the reset acknowledgement/pose |
| F8 | Unmount and return to normal walking |
| F10 / HUD Tuning button | Open/close numeric tuning panel; brakes held while open |

The tuning panel has 18 text boxes: speed/boost limits, thrust/boost thrust, braking,
drag, turn rate/response, grip/drift grip/drift turn multiplier, hover height,
spring/damping, gravity, hop speed, airborne horizontal-control multiplier and camera-position
filter seconds. **Apply**
validates the entire set atomically; an invalid field leaves the current handling
unchanged and displays its reason. **Restore defaults** applies the original MVP
handling. Successful Apply and Restore defaults atomically save all 18 values to
`racer-tuning.txt` in the existing local-state folder (`BENILLA_HOME` when set).
The next racer-enabled launch loads that exact set; nothing is saved to the account.
A write failure leaves active values unchanged and reports the error. An invalid
saved file reports an error and boots with defaults without overwriting the file.
Capture runs neither read nor write this state. The launcher pins `BENILLA_HOME`
inside this worktree, independently of executable location and working directory.
Tab advances through fields, Enter applies, and Escape in a field closes.

Earlier session-only builds did not record Apply values, so their closed sessions
cannot be reconstructed. The later saved user tune was captured successfully:

| Saved handling | Values |
| --- | --- |
| Cruise / boost maximum; thrust / extra boost thrust / braking | 250 / 500 yd/s; 30 / 50 / 30 yd/s² |
| Drag; turn rate / response; grip / drift grip / drift turn multiplier | 0.25; 2.2 / 10; 4 / 0.5 / 1.3 |
| Hover height; spring / damping; gravity / hop / air control | 1.1 yd; 90 / 18; 15 / 7 / 0.8 |
| Camera position time constant | 0.5 s |

This tune stays in the launcher's existing local-state file, not a forced new
default. Suspension updates do not overwrite it.

There are no gameplay tuning upper ceilings. Values must be finite, representable
32-bit floats and satisfy the physical sign/domain checks reported by Apply;
boost maximum must remain at least cruise maximum. Scientific notation is accepted.
The adjustable cruise/boost values still govern requested top speeds: uncapping the
editor does not remove those controls or create infinite velocity. Air steering is
an uncapped nonnegative multiplier, not a percentage capped at one. The default
air control multiplier is `0.9`. Saved tuning still takes precedence; Restore
defaults uses this value.

**Camera position (s)** is a separate saved exponential low-pass time
constant, default `0.5` seconds (`0` turns it off). After one time constant it covers about
63.2% of a target-position change; larger values soften motion more. Zero disables
position filtering, independently of yaw damping. Mount, reset, teleport/control
handoff and remount initialize/snap the position rather than interpolating across
the world. Camera collision is resolved both before and after filtering, with the
final clipped position retained as filter history. Non-racer cameras are unchanged.

Finite inputs are not a promise that every combination can be numerically simulated
or feel good. Derived nonfinite/unrepresentable physics or collision arithmetic is
rejected explicitly rather than silently clamping the tuning. Collision sweeps,
the furnished-terrain window, boost reserve, hop timing, 120 Hz simulation, server
authorization and state/ground constraints remain. There is no Flats rectangle,
area restriction or distance leash from the mount point. Actual map extents remain;
this is world exploration within the two outdoor continent maps, not an infinite
coordinate space or unrestricted flight. Very high speeds can hit the streaming
frontier and pause until terrain/collision catches up. Ground probes are relative
to the body and configured hover height, not a fixed Flats altitude.
Racer suspension also supports loaded water/ocean surfaces, using each wet cell's
height rather than a lake's bounding box. Shore gaps remain dry and solid bridges
above water still take precedence. Hops and airborne thrust work over water;
fast downward crossings land on its surface instead of tunneling through it.
Lava/slime do not provide support. Normal walking/swimming is unchanged; this is
not underwater flight, and a rider already below the surface is not lifted out.
The updated server is required to remove the previous area/leash/altitude guards
(and includes the earlier uncapped packet changes); do not restart a running
server without coordinating its owner.

### Controller

Controller support is enabled only with `WOW_FLATS_RACER=1`, using Bevy's existing
gamepad backend. Xbox / PlayStation names below refer to the same physical buttons:

| Control | Action |
| --- | --- |
| Left stick X | Steer (18% deadzone, remaining travel rescaled) |
| Right stick X / Y | Orbit camera yaw / pitch (18% deadzone per axis, remaining travel rescaled) |
| Right stick click / R3 | Toggle locked cockpit view |
| D-pad up / down | Zoom chase camera in / out, one step per press |
| RT / R2 | Analog forward thrust (8% deadzone) |
| LT / L2 | Analog reverse thrust (8% deadzone), including from standstill |
| RB / R1 | Boost |
| LB / L1 | Drift |
| A / Cross | Hop |
| Start / Menu | Mount/unmount |
| Y / Triangle | Safe reset |
| Back / View / Share | Toggle tuning panel |

HUD tutorial text follows the latest keyboard or controller press; significant
stick/trigger movement also selects the controller. Held buttons and stick noise
do not keep stealing the tutorial back from the keyboard. In a same-frame tie the
controller wins. Keyboard/mouse still edit the tuning boxes; this is not general
controller navigation for the stock client UI. Unfocused, typing, loading,
inspection and tuning-panel gates block stick look and brake instead of thrusting.
Disconnect clears controller thrust/look and returns to keyboard input.

Trigger pressures subtract after the deadzone: equal pressures give zero thrust,
and the stronger trigger determines direction and strength. Reverse thrust first
slows forward motion, then accelerates backward through zero; it is not a brake.
Keyboard S remains a brake, W remains forward thrust, and boost remains forward-only.
Movement packets report the actual forward/backward motion, not the requested thrust.

The right stick uses the existing camera yaw/pitch speeds, mouse sensitivity and
pitch inversion setting, as angular rates per second rather than per frame.
Right turns the view right; up looks up unless pitch is inverted. Pitch keeps the
ordinary ±89° limit. Stick deflection suspends racer auto-follow; release eases yaw
behind the racer and pitch back to the original raised chase angle. Mount/reset
snaps both angles to the chase pose. Camera position filtering and both collision
casts remain active while orbiting. Ordinary walking/free-fly cameras are unchanged.

### Racer zoom and cockpit

The mouse wheel and rebound `CameraZoomIn` / `CameraZoomOut` actions now adjust
the racer chase distance through the existing zoom glide and limits:
`cameraDistanceMax` times `cameraDistanceMaxFactor`, capped at 50 yd (15 yd by
default), down to zero. Speed no longer overwrites the selected chase distance.
The existing character camera-pose file continues to save the chosen zoom;
no new settings file or tuning field is introduced.

**Ctrl+Alt+V** or **R3** toggles cockpit view. Plain V retains its nameplate
binding. If Ctrl+Alt+V is already bound, the racer leaves that binding alone and
reports the conflict; R3 remains available. The chord, R3 and D-pad zoom obey
focus, typing, inspection, loading and tuning-panel input gates.

Cockpit view uses the existing mounted rider's attachment-0 seat frame and
model-derived camera head height, not a new model or invented cockpit mesh.
Its orientation follows the actual vehicle frame, including pitch/bank; mouse
and right-stick orbit do not steer this locked view. The camera is seated again
after animation/transform propagation, without chase lag, and its path from the
body is clipped against the existing camera collision query. If the rider seat
is not loaded, the toggle is refused with a status message rather than placing
the camera at an arbitrary point.

The ordinary first-person fade hides the rider, attached equipment and mount to
prevent near-plane/body clipping. Returning to chase restores their normal fade.
Cockpit mode ignores zoom gestures and leaves the chase distance intact; exiting
recenters and snaps to that distance. Reset keeps the selected mode, while
dismount/control handoff clears cockpit mode. The toggle itself is session-only.

Reset returns to the grounded position where the server granted this mount, not
to a client-selected coordinate. Mount on clear, level ground. The anchor is a
reset destination, not a driving leash. Normal cross-map travel relinquishes
custom control; remount after arrival. Seamless continent crossing, instances,
ocean traversal and every world obstacle are not promised.

The small HUD shows authorization/streaming status, speed and boost. Typing,
unfocused-window or loading input brakes rather than driving. Ordinary mob aggro
and combat do not automatically dismount the racer. Death, root, stun,
foreign mover/control loss, missing mount, disconnect and unexpected corrections
relinquish custom control. Normal movement retains its existing server checks.
Only explicitly unattended probe-generated keys can operate the racer without
focus; physical background keyboard input is excluded.

### Racer sound

The authorized racer has an original, synthesized cockpit sound: a stereo pair of
slightly detuned pulsing engines, a quieter speed/thrust whine, and a higher boost
layer that follows actual reserve consumption, not merely the boost button.
Reverse trigger pressure loads the engines too; braking and collision-streaming
holds unload them. Speed pitch rises smoothly through 120 yd/s and then saturates
(this is an audio range, not a vehicle speed limit). There are no downloaded or
franchise recordings, new dependencies, or replacement normal mount/game sounds.

The three persistent loops use the existing Kira mixer, Effects (`SoundVolume`)
and Master sliders, master enable/mute, limiter, focus/background-sound setting,
and audio-probe taps. Their maximum combined pre-slider amplitude is below 0.19;
they are deliberately quieter than full-scale game effects. Input changes have
smooth envelopes (220 ms engine response, 90 ms boost attack / 250 ms release)
and de-clicked pitch/volume updates. Loops fade out over 180 ms on dismount,
authorization loss, disable, logout, or loading; remount waits for old voices to
finish rather than duplicating them. Missing devices, `WOW_NOSOUND`, and
`WOW_CAPTURE` remain silent. Muting or losing focus does not restart the engines.
The loops count against the existing voice budget; if it is full, they retry
after two seconds without displacing normal effects.

### Racer instruments

The racer-only instrument cluster uses original amber/teal graphics and the
existing FrameXML API; no franchise artwork or interface code is bundled. It sits
above the action bars without replacing the stock HUD. Speed and forward/reverse
direction come from actual motion, the amber segments show speed against the
configured boost cap, and the teal segments show remaining boost reserve.
Airborne, standby, and collision-streaming holds are identified in text rather
than by color alone. Tuning and input-guide buttons remain mouse-accessible;
the rest of the cluster does not capture mouse or keyboard input.

## Implementation boundary

The installed `CreatureDisplayInfo` row 10318 resolves model 1471 to
`Creature\GoblinRocketCar\GoblinRocketCar.m2`; this is the actual available Goblin
salt-flats racer. The ordinary renderer seats the rider at its real attachment 0,
not a fabricated seat offset. The offline fixture uses installed human male
display 49. Data is opened at runtime from the owner's read-only installation;
no MPQ/model/texture is extracted into the repository.

`flats-racer-physics` is the deliberately small custom numerical crate. The app
adapter owns authorization, actual terrain support and swept collision. It runs
at 120 Hz with four spring/damper support probes, bounded boost reserve/hop timing and
three swept spheres with sliding and turn clearance. The collision body stays
upright; only the render mount banks. The damped chase camera uses the existing
world camera collision query.

Suspension damping and grounded control use vertical velocity relative to the
terrain rise rate, derived from the actual accepted collision-hit normals and
horizontal body velocity. Uphill travel no longer loses thrust merely because
world vertical velocity exceeds 2 yd/s, nor does damping fight the climb.
The spring/damper is integrated implicitly: small ground bumps compress the
suspension instead of snapping the body to terrain, and stiff finite tuning
does not make the explicit spring integrator explode. Lift remains unilateral:
the suspension cannot pull downward faster than gravity. Crests and missing
support therefore launch into a ballistic arc, not terrain suction or flight.
Hops inherit the terrain-relative rise rate and retain the existing brief
support lockout. Air control multiplies horizontal thrust, braking, grip,
drag and steering throughout airtime, including natural crests and long
falls; zero disables airborne horizontal control, including air drag, so an
airborne body with zero air control coasts at a constant horizontal velocity
instead of bleeding it off. Turning also
works at a standstill so losing speed against an obstacle does not remove input.
There is no airborne thrust timer. Boost still requires ground support.
Thrust remains horizontal: gravity and unsupported ballistic motion are unchanged,
so sustained throttle does not grant vertical flight.
The F10 field is named **Air control multiplier**; the saved preset's existing
seventeenth value remains compatible (0.8 means 80% horizontal authority).
Collision clearance can still reject a turn that would rotate the body into a
wall; back away or reset rather than expecting steering to penetrate geometry.

Drag now scales with air control exactly like grip: previously drag always
ran at full ground strength while airborne, so a scaled-down airborne thrust
could never outrun it once cruising speed approached roughly
`acceleration / drag` (about 18 yd/s with the default tuning) — the throttle
visibly "did nothing" in midair even though the physics per tick was correct.
Holding thrust while airborne now always gains speed, just more slowly than
on the ground in proportion to the air control multiplier.

The airborne-control update passes 30 physics and 29 focused app racer tests.
At 30/60/144 Hz, unsupported thrust of 30 yd/s2 with air control 0.8 reaches
48 yd/s after two seconds, then brakes to 24 yd/s after one second. Vertical
motion exactly matches a no-input falling body and airborne boost consumes no
reserve. Separate tests cover long-fall steering, zero authority, sustained
post-hop thrust and actual Avian stationary turn clearance near a head-on wall,
both supported and airborne. Human wall/air handling remains unverified.

The latest separately prepared executable is `target-racer\air-control\benilla.exe`,
SHA256 `BFF982C4F9402C21700ED65CAF2CE1017CD4E3AC1DEBD58A523BB78AD42F39E3`.
The ignored `target-racer\probe-runtime\Start-Uncapped-Racer.ps1` selects it.
Quit the older client and relaunch that script; this client-only update does not
restart services or overwrite the running suspension executable.

The probes still average available footprint clearances; on slopes the upright
body may ride higher than its flat-ground hover setting. Faces whose upward
normal component is at most 0.6 cannot supply suspension. This is neither wall
climbing nor a promise to stick to steep descents at arbitrary speed.

Current terrain and the entire projected body envelope must have resident,
scene-ready, fully-collided terrain. The displacement is checked after this tick's
acceleration, so a high tuning value cannot jump over an unloaded tile. Missing
stream readiness holds the body instead of running through unbuilt collision;
missing ground support alone permits gravity/airborne motion. At most 12 steps are caught up per frame;
time beyond a 100 ms hitch is intentionally discarded, not a claim of real-time
simulation through stalls.

Intentional protocol deviation: physical hops remain grounded wire poses while
the explicitly authorized custom server mode validates finite outdoor-map endpoints.
This exception is not a global anticheat bypass or unrestricted flight mode.
Custom server authorization and movement handling are separate from normal walking.

The original bounded MVP accepted installed AreaTable IDs 439 (The Shimmering Flats) and
2240 (Mirage Raceway), both on map 1 under zone 400. Area 479 is The Rustmaul
Dig Site, not the raceway. The ordinary-account activation probe
identified the original wrong-area assumption: its authoritative area was 2240,
player z -58.7415, ground -58.7517, and delta 0.0102 yd. State and ground
prerequisites passed. The world-explorer update removes these area and Flats
altitude restrictions, while retaining actionable state and terrain
prerequisite rather than only a generic command failure.

Coordinates follow the existing client conversion, not a separate racer
convention: WoW `(x, y, z)` becomes Bevy `(-y, z, -x)`, one unit per yard.
Thus the measured WoW starting point `(-6235, -3945, -58.75)` is Bevy
`(3945, -58.75, 6235)` before hover clearance.

## Reproducible offline integration capture

The offline probe needs no account, server, DB, login identity or combat:

```powershell
$env:WOW_DATA = 'C:\Users\liz\Downloads\Stonetavern-Classic-1.12.1-v1.8\Data'
$env:WOW_UNATTENDED = '1'
$env:WOW_NOSOUND = '1'
$env:WOW_CAPTURE = 'flats-racer'
$env:WOW_CAPTURE_OUT = "$env:TEMP\flats-racer.png"
$env:WOW_RACER_PROBE_OUT = "$env:TEMP\flats-racer.json"
& .\target-racer\play\benilla.exe
```

To include the actual tuning dialog in this same offline terrain/model capture,
also set `WOW_CAPTURE_UI=1`, `WOW_FLATS_RACER=1` and
`WOW_RACER_TUNING_CAPTURE=1`. This instrumentation neither logs in nor authorizes
a live vehicle. Clear those capture variables before interactive play.

The scenario waits for the installed rider, mounted attachment hierarchy and
streamed world collision before releasing its deterministic clock. It exercises
the same resolver and camera as live play: settle, thrust/boost, drift turn,
brake, hop/landing, reset and settle. It reports speed, height, landing/reset,
stream holds and final body/camera coordinates, asserts numeric bounds, writes
the requested JSON/PNG and exits. A failed preflight has a finite capture deadline
and must not be reported as a successful run.

Remove `WOW_CAPTURE`, `WOW_CAPTURE_OUT`, `WOW_RACER_PROBE_OUT` and
`WOW_UNATTENDED` from the environment before an ordinary interactive launch.

### Recorded integration results

The actual installed-data capture completed 480 frames / 8.00005 seconds:
maximum speed 19.395153 yd/s, support-relative body height 1.0995674 to
2.091236 yd, with hop, landing and reset observed and no streaming holds.
Mount-rig and seated-rider preflights passed. The resulting PNG was inspected:
it shows the Goblin rocket car and seated human on the existing Flats terrain
from the rear chase camera. The final body was
`[3945, -57.65, 6235]` and camera `[3945.0002, -50.095543, 6250.179]`
in client Y-up coordinates. Captures remain ignored local artifacts, not
redistributed game assets.

Numerical checks measured 15.910 yd/s after one second of thrust and zero
speed after a subsequent one-second brake; 0.5-second lateral velocity was
4.055 yd/s with grip versus 12.513 yd/s in drift. Initial heights 0.4 and
1.65 yd recovered to 1.100000 / 1.100001 yd within three seconds. A hop peaked
at 2.092 yd; holding jump produced only one hop over ten seconds. The
30/60/144 Hz adapters each produced the same 720 fixed steps. Integrated
checks also exercise real Avian thin-wall sweeps, sliding, support heights,
missing-tile holds, authorization and walking handoff.

An isolated ordinary-account regression run (level 1, security level 0,
anticheat enabled, client racer opt-in absent) completed normal two-second
walking over approximately 13.96 yd and a normal jump/landing. The racer HUD
was absent, no grant was issued, and the server saved the resulting position
with full health. This used separate DB/auth/world ports 3308/3725/8086 and a
dedicated ignored probe identity, never the player's account or live services.

After correcting the installed-area mapping, the same isolated level-1,
security-level-0 character completed an authorized live drive with anticheat
still enabled: ON, mount, thrust/boost, drift/turn, brake to zero, hop/landing,
RESET, OFF, then ordinary walking and jumping. The HUD peaked at 22.4 yd/s,
heading reached 1.0183 radians, and the body traveled up to 27.679 yd from
the start. The hop reached WoW z -56.66 and landed at hover z -57.65.
All 54 changed custom wire poses retained only the allowed plain flags.
Both requested reset/release corrections acknowledged the captured safe point
`(-6235, -3945, -58.5)`; there were no other teleports or activation rejections.
After unmounting, ordinary movement ended at
`(-6224.46, -3945, -58.74)` with a normal Jump/FallLand sequence and full health.
This establishes isolated grant/movement/reset interoperability, not human feel.
The 36 yd/s cruise and 50 yd/s boost caps, high-speed wall sweeps and
streaming-frontier holds have automated coverage, but were not exercised at
their limits in this live drive. Live obstacle impact and frontier recovery
still require the human acceptance pass below.

### Tuning/controller validation

The previous tuning update passed 17 app racer tests (including real EditBox entry,
atomic Apply/defaults, controller mappings, device switching, disconnect and
normal-mode exclusion), 17 numerical physics tests and the schedule-order audit.
Cosmetic banking now runs in PostUpdate before animation and terrain conforming;
the camera is explicitly excluded from its mutable transform query.
Its full Windows app run reported 4,846 passed, 12 ignored and three failures:
`cvars::deviations_doc::the_deviates_rows_read_back_as_the_generator_reads_them`
(CRLF string parsing), `ui_script::fire_scan::every_relay_has_its_origin_in_view`
(Windows path tracing), and
`ui_session::tests::every_npc_session_is_portrait_bound_or_explicitly_excluded`
(source-structure parsing). These unrelated source-audit failures remain
unresolved; all three were reproduced individually using the prior committed
test executable before this uncapping change. The full suite is not claimed green,
and was not repeated for the camera/uncapping update.

That prior installed-data tuning-panel capture retained the 480-frame measurements
above, and its 17 fields plus Apply/defaults/Close were visually inspected.
Synthetic gamepad tests do not establish physical controller mapping or handling
feel. For the human pass, apply a lower speed cap and turn rate, close the panel
and compare handling; restore defaults, then alternate keyboard presses with pad
buttons/axes and check tutorial changes, deadzones, focus loss and disconnect.

The positional-filter checks use an exact one-second step response with a
0.25-second time constant at 30/60/144 Hz and irregular steps
`[0.001, 0.199, 0.3, 0.5]` seconds; each must reach `9.816844` yd for a
10-yard target within `0.0001` yd. A separate alternating +/-0.1-yard target
at 60 Hz measures synthetic jitter attenuation, not observed gameplay jitter.
An actual Avian wall fixture verifies that filtering cannot retain a camera
seat on the far side of a wall, and a reset snaps heading and position.
No visible runtime jitter reproduction or human handling assessment is claimed.

### Uncapping and positional-filter validation

The prior uncapping update passed 23 app racer tests and 20 numerical physics tests.
They cover uncapped finite input (including round-tripping `f32::MAX`), atomic
invalid Apply, actual high-value acceleration/speed/turn/brake response, numeric
overflow rejection, a 5,000 yd/s Avian wall sweep, full-turn body clearance and
post-acceleration streaming holds. The positional step-response error stays below
0.0001 yd across the frame schedules above. Injected alternating target jitter
at 60 Hz with a 0.15-second filter drops from 0.100000 to 0.005573 yd RMS;
this measures a synthetic signal, not a reproduced runtime symptom.

The separate installed-data capture completed 480 frames / 8.00005 seconds:
peak 19.408924 yd/s, support-relative height 1.0995865 to 2.0912552 yd,
hop/landing/reset true, zero stream holds, and rider/mount preflight passed.
Final body/camera were `[3945, -57.65, 6235]` /
`[3945, -50.09554, 6250.1816]`. It uses default handling, not live high-speed
server validation. The actual 18-field tuning panel was captured and inspected.

### Windows isolated-instance handoff

The prepared workspace is
`C:\Users\liz\copilot-worktrees\vanilla-world\lizizatt-special-guacamole`.
The world-explorer executable is `target-racer\world-explorer\benilla.exe`; the prior
uncapping executable is `target-racer\uncapped\benilla.exe`. The
original client at `C:\Users\liz\copilot-worktrees\benilla\lizizatt-upgraded-funicular\target\play\benilla.exe`
remains untouched. Nothing here updates the running client or server. The ignored
`target-racer\probe-runtime\identity.private.json` contains the dedicated non-GM
account credentials and `Racerprobe` character name; never commit or publish it.
The scripted client has exited and disconnected. This character is already at
Mirage Raceway, map 1, near `(-6235, -3945, -58.75)`, with full health. Use this
account rather than moving or logging in the original player.

After coordinating the server update and confirming its isolated auth/world
services are available, start the new manual, sound-disabled client from the
workspace root with the ignored launcher:

```powershell
& .\target-racer\probe-runtime\Start-Uncapped-Racer.ps1
```

`Start-Uncapped-Racer.ps1` selects the new executable, reads that identity, selects auth
`127.0.0.1:3725`, clears inherited capture/synthetic-input/unattended/exit
variables, sets `WOW_FLATS_RACER=1`, and selects the existing character. It
does not inject any input. Focus the window before using the controls above;
close it normally to disconnect. Do not run `Run-Probe.ps1` for manual testing:
that separate automation has synthetic keys and a finite exit time.

The isolated DB/auth/world use loopback-only ports **3308/3725/8086**. The
prepared world config is `target-racer\probe-runtime\mangosd.conf` with
`CustomFlatsRacer.Enable = true`, `Anticheat.Enable = 1`,
`MapUpdate.Instanced.UpdateThreads = 1`, `MapUpdate.ObjectsUpdate.MaxThreads = 1`,
`MapUpdate.VisibilityUpdate.MaxThreads = 1`, and
`MapUpdate.Continents.MTCells.Threads = 0`. For the noncombat fixture only,
creature aggro, Warden, RA and SOAP are disabled.
**`mmap.enabled = 0`**: this instance does not wait for or compete with ongoing
full pathfinding generation. VMap LOS, height and indoor checks are enabled.
Client terrain/Avian collision is used by the racer, not server MMaps.
The test therefore does not validate NPC navigation or the full-pathfinding
configuration of the original runtime.

Check whether the isolated driver has expired before starting another.
Do not restart or replace its binaries without coordinating the runtime owner.
A newly started driver has a
40-minute lifetime. Inspect only
these ports and use the ownership-aware DB status helper:

```powershell
Get-NetTCPConnection -State Listen -LocalPort 3308,3725,8086 -ErrorAction SilentlyContinue
& .\target-racer\probe-runtime\Isolated-Database.ps1 -Action Status
```

To restart the isolated fixture after it has stopped, first verify auth/world
ports 3725/8086 are free; the driver refuses occupied ports. Start the DB only
if its status helper says it is stopped, then run the server driver in a
separate terminal (leave it open):

```powershell
& .\target-racer\probe-runtime\Isolated-Database.ps1 -Action Start
Remove-Item .\target-racer\probe-runtime\stop-owned -ErrorAction SilentlyContinue
python .\target-racer\probe-runtime\Run-Isolated-Servers.py .\server\build\flats-racer\world-validation\server
```

The separate Release server directory above contains `mangosd.exe`, `realmd.exe`,
`libmySQL.dll` and `libeay32.dll`. It includes the explorer source changes on
parent commit `3b0556c` (the embedded revision identifies the parent, not a clean
release). Both executable version smoke tests passed. The previous uncapping
server in `uncapped-validation` does not authorize world exploration.
Startup/login is not a high-speed or camera-feel acceptance test.

To stop safely, first disconnect the isolated client, then request auth/world
shutdown. Wait until their ports are free before stopping the owned DB:

```powershell
New-Item .\target-racer\probe-runtime\stop-owned -ItemType File -Force
# Wait for the server terminal to exit and ports 3725/8086 to disappear.
& .\target-racer\probe-runtime\Isolated-Database.ps1 -Action Stop
```

Do not kill processes by name or touch ports 3307/3724/8085. These ignored
fixture helpers/configs/data are machine-local, not included in the PR, and
refer to this workspace and the existing read-only server data/tool installation.
Other machines must build and configure their own server using
[`server/doc/FlatsRacer.md`](../../server/doc/FlatsRacer.md); these paths and
credentials are not portable.

### World-explorer update validation

The explorer client builds separately at `target-racer\world-explorer\benilla.exe`.
All 26 focused app racer tests pass, including atomic save/reload and failed-write
preservation, both-continent eligibility/instance rejection, and real Avian support
probes at terrain altitudes -500 and 1500 yd. Ground beyond configured probe reach
supplies no lift. Existing camera, collision, streaming, input and walking-handoff
tests remain in that focused set.

Its installed-data offline capture completed 480 frames / 8.00005 s with peak
19.408924 yd/s, height 1.0995865 to 2.0912552 yd, hop/landing/reset and seated
rider/mount preflight true, zero stream holds. The 18-field panel was visually
inspected. This default-tuning capture is a regression check, not a claim that
the earlier unsaved tune was recovered or that all outdoor terrain was driven.
The updated server passed C++ policy assertions, structural normal-path checks,
affected object compilation and a serial Release full link. It allows outdoor
maps 0/1 with finite engine coordinates, available terrain/collision and
endpoint altitude at least ground minus 0.75 yd; there is no upper altitude
ceiling. Activation/reset anchors must be grounded. Same-map travel preserves
the original reset map/anchor; external teleports revoke authorization.
Server checks are endpoint-only; swept collision remains the local client's job.
Runtime whole-world terrain/teleport-ACK acceptance remains a human check.

### Slope-relative suspension update validation

The updated client is prepared separately at
`target-racer\suspension\benilla.exe`; the ignored manual launcher now selects
it while retaining the same `BENILLA_HOME` and saved user tune:

```powershell
& .\target-racer\probe-runtime\Start-Uncapped-Racer.ps1
```

Auth/world must already be running as described above. This update does not
change server policy, restart services or overwrite either prior client.
The new executable SHA-256 is
`DBCA85FCB772BB2747FAE3B4F4B9700E9174C527CE2C3AEE400AA16418092266`.

All 28 numerical physics tests and all 28 focused app racer tests pass. New
coverage includes partial/missing support, stiff/zero damping, invalid terrain
motion and overflow atomicity, slope hops/lockout, reverse braking, bump
compression/recovery, ballistic crests, steep-face rejection and real Avian
20-degree uphill/downhill travel. At 30/60/144 Hz, each three-second ramp run
ends at the same position (within 0.01 yd), reaches 74.0004 yd/s horizontally,
and retains grounded control throughout the measured final two seconds.
A 0.25-yd bump lasting 0.25 s produces 0.1788 yd of body rise, less than
0.02 yd displacement per fixed tick, and recovery within 0.001 yd after 4 s.

The new installed-data offline capture completes 480 frames / 8.00005 s:
peak 19.342102 yd/s, height 1.099556 to 2.0912628 yd, seated rider/rendered
mount, hop/landing/reset true, zero stream holds. Its camera/body preflight
and 18-field tuning screenshot were inspected. This uses defaults without
loading or changing the saved user tune. It is not a human hill/crest test.
The build succeeds; no C++ changed in this suspension update. The three
previous Windows source-audit failures remain baseline and the broad suite
was not repeated.

## Collision-safe racer streaming

The original high-speed Avian integration regression reproduced a full reset:
an airborne state with velocity `[0, 7, 250]` became `[0, 0, 0]` on a streaming
hold. This is a demonstrated hold-path defect, not proof that every stop reported
during human play had the same cause. The old global queue gate could also hold
locally safe motion because of unrelated distant work. Tile-owned welded
doodad hulls additionally require ownership handoff when their original tile
unloads, even with render merging disabled.

Streaming holds retain the entire last valid simulation state, including airborne
horizontal/vertical velocity and yaw rate. The fixed-step clock drops held wall time;
resume advances normally rather than teleporting to catch up. The wire reports a
stationary pose while held. A server correction or loss of authorization still
yields control; it is not treated as a harmless streaming pause.

Traversal requires a per-tile collision completion proof for every tile crossed by
the swept body envelope (5.6 yd in either horizontal direction). Loaded terrain
alone is insufficient: model/prop spawning, welded hulls and pending descendant
colliders must also finish. Every attached collider must resolve to its own entity
in Avian's query tree. The proof checks actual registration rather than inferring
it from shape presence or an elapsed physics tick. Avian registers static colliders
through insertion observers, including frames with no fixed tick; that case is
covered by a translated-collider raycast regression. Unrelated distant
render-merge/collider backlog does not stop a proven local corridor. Missing
collision still holds the racer, never disables collision. Ordinary walking
retains its original streaming path.

While authorized, the existing ADT streamer requests a 3x3 body ring and a
velocity-directed corridor of overlapping rings. Lookahead is two seconds,
capped at two ADT widths (about 1,067 yd); the desired union is at most 21 ADTs,
with new admissions limited to 40 resident/in-flight tiles and two new requests
per paced frame. Tiles inherited from walking can temporarily exceed that
admission limit while the existing paced unloader retires them.
The racer retains already-loaded neighbours within two tiles plus the desired
lookahead, under the existing 40-tile admission cap, reducing turn-induced
unload/rebuild churn without changing the collision safety hold.
The existing furnishing, placement, collider and unload budgets still apply.
These are safety/resource bounds, not a guarantee of stall-free 500 yd/s travel:
cold loads that outlast the available corridor still hold safely. Higher tuning
does not remove the residency bound. Distant art is not collision.

The authorized racer also opts into an extended ring in the existing WDL
renderer, not a second terrain engine. It builds at most four coarse patches per
frame and retains at most 625 (a 25x25 window). The shader textures each patch
with its own covering ADT tile's minimap art (the same per-tile overhead art the
HUD minimap already streams, resolved through `md5translate.trs`), fogs from
3,500 to 5,500 yd and fades out by 6,000 yd; missing WDL remains missing,
not invented geometry. This is a visual horizon only, not detailed terrain,
objects or playable collision. Its raw mesh payload ceiling is 18,580,000 bytes
per CPU or GPU copy, excluding asset/driver overhead and the source heightmap.

Each patch also carries its own distant water, built from the same ADT tile's
authored MCLQ liquid blocks (lakes, rivers, sea and lava), requested as its own
async Bevy asset (`AdtLiquidTile`, `benilla-assets`) through the same `mpq://`
pipeline the terrain tile's own `AdtTile` already uses — the MPQ read and
decompress run on Bevy's asset task pool, off the frame that requests it, not
inline in the streaming system (an earlier synchronous version of this that read
the file directly was corrected before shipping). The liquid-only parse is still
a CPU saving over a full ADT parse (it skips building the tile's far larger
height/normal/alpha/shadow structures), not an I/O one — the file is read in
full either way.

A streamed-in tile first only *queues* its want for water (`WaterState::Queued`)
unless the map's WDT (`MapTiles::has_tile`) already says the tile has no ADT at
all, in which case it never queues anything — an unauthored map-edge tile costs
nothing. A separate admission pass turns queued tiles into actual loads,
nearest-the-view first, bounded by two independent limits: at most
`RacerWdl::WATER_REQUESTS_PER_FRAME` (4) new loads started per frame, and
`RacerWdl::MAX_IN_FLIGHT_WATER_REQUESTS` (16) retained outstanding handles,
regardless of how many tiles are queued. This is not a hard ceiling on physical
decompressions across eviction: dropping a handle does not cancel IO. That ceiling
exists because Bevy's asset IO is shared infrastructure — the terrain tile's own
`AdtTile` load, the collision streamer's loads, and this water request all draw
on the same task pool — so flying into a wet region never queues the whole
625-tile residency window as one burst of ADT decompress requests; the rest
wait, and are admitted as earlier loads resolve or fail. A third, independent
budget (`RacerWdl::WATER_RESOLVES_PER_FRAME`, 4) bounds how many *resolved*
loads are turned into a spawned mesh in one frame, since that CPU work (merging
liquids, building the Bevy `Mesh`, spawning the entity) is still main-thread,
even though the read itself ran off-thread.

A request that still fails after the WDT pre-filter (a corrupt archive, a real
I/O fault) is a genuine fault and `warn!`s once per tile, not silently and not
repeatedly. Evicting a tile (residency, a map switch, or a racer toggle) drops
its `WaterState` — including an in-flight handle — with the rest of the tile's
state, which **frees its in-flight slot** for another tile the very next frame,
but is **not a cancellation guarantee**: Bevy has no explicit load-cancel API,
so an already-in-flight load may still finish in the background: nothing looks
up its result afterward, since the tile is no longer resident to look it up
with. Same-kind surfaces on a tile merge into one draw, so a wet patch adds at
most three extra entities (Still, Ocean, Magma — the only kinds an ADT MCLQ ever
carries), under the same 625-patch residency ceiling as the terrain patches.
The water keeps its authored coverage, shore gaps and absolute height; a dry
tile adds nothing. It renders through the racer WDL shader beyond the detailed
farclip wall with real geometry depth, not the near-field animated liquid
system. This boundary still needs live GPU seam verification.
It stays flat-coloured per kind rather than animated — a coarse distant
read, not a near-field surface.
Leaving racer mode restores the stock ring, material and frustum behavior;
map changes and world exit release patch entities and mesh assets.

The same asynchronous ADT result supplies distant doodad and WMO placements.
Selection keeps at most 48 per tile, preferring nearby, larger-scale and
forward-facing features, with a priority bonus for structural WMOs. Shared
models are requested nearest-placement-first. ADT unique IDs deduplicate
features spanning tiles; eviction allows another retained tile to take ownership.

M2 proxies retain complete authored render geometry, not collision hulls.
The ceiling is **4,000 triangles per model**, deliberately higher than the
earlier 500-triangle proposal: clustering disconnected leaf cards damages
their geometry and UV seams. An oversized model fails explicitly. Alpha-test
batches retain their UVs and sample their actual texture's alpha, downsampled
to 64x64 masks in one 256x256 atlas per model (15 masks plus opaque white).
There are no opaque rectangular substitutes for leaf cutouts. Cutoff is
224/255, matching the near renderer. Decodes are capped at 2048x2048; missing
textures, unsupported repeating cutout UVs and corrupt models report failures.
This remains static bind-pose, flat-coloured LOD, not animated foliage.

WMO proxies read **render batches from every group**, including non-collidable
structures. Walking collision is not a visual substitute. Grid vertex
clustering remaps triangles to averaged representatives, removes degenerate
and duplicate triangles, and compacts unused vertices; it never samples every
Nth triangle. Output is capped at 4,000 triangles. Clustering can collapse
small disconnected ornaments; it does not guarantee topology preservation.
Input budgets are 128 groups, 64 MiB of source bytes and 200,000 triangles.
Missing groups and invalid render indices fail explicitly rather than silently
reporting a partial building as successful.

The shared proxy caches retain at most 96 M2 and 32 WMO models. Each kind admits
four requests per frame and retains at most 16 outstanding handles; eviction
does not guarantee cancellation of physical IO. Four combined proxy resolutions
or instance spawns occur per frame. Across all tiles, feature instances are
capped at **2,048 and 2,000,000 triangles**. When a cap is full, pending features
wait rather than exceeding it. Map changes, racer exit and world exit clear
tile references and proxy caches, so stale asset results cannot spawn features.

Distant ships and zeppelins use the server's actual transport entities.
`Map::SendInitTransports` broadcasts the map's transport set; the existing
client timetable writes their poses and hides off-map legs. Only armed taxi
transports receive the `RacerTransport` marker. Their far-draw copies share
already-loaded render meshes and existing cutout textures, following the
real post-propagation transforms. No model/network requests, invented paths,
new collision objects or generic GameObject culling exemption are added.
Admission is bounded to 16 transports, 256 render parts and 128,000 triangles,
with four new parts per frame. Oversized vessels are skipped as a whole with
a warning. Off-map/hidden, despawned, out-of-range and non-racer copies are
removed. The normal model shader still clips at the view-distance wall;
these copies use the racer shader beyond it, bounded by the 6,000 yd horizon.

Racer terrain, water, features and transport copies write **their real
per-fragment reverse-Z depth**, not the stock backdrop clamp, and begin at
the detailed farclip wall. Hills therefore depth-test against models at their
actual distance. Stock non-racer WDL retains its original 33 yd overlap and
depth push. The WDL height samples are still roughly 33 yd apart: small
terrain relief absent from the authored coarse mesh cannot occlude distant
objects accurately. Numerical depth/geometry checks do not replace a live GPU
check of hill occlusion, the near/far seam and leaf silhouettes; that visual
acceptance remains pending until the coordinated client launch.

Installed-data fixtures verify the complete 68-triangle Elwynn pine render
mesh versus its 6-triangle collision hull, including transparent and opaque
texels in the foliage atlas. Goldshire Inn uses 24,274 authored render
triangles, clustered to 2,794; its three extents remain above 98% of the
render mesh. These are geometry/alpha assertions, not screenshot acceptance.

For another renderer, the reusable format boundary is
`WdlFile::tile_mesh` (`positions`, `uvs`, `indices`),
`adt_bytes_to_racer_features` (liquids, doodads, WMOs),
`parse_m2_render_submeshes`, and `parse_wmo_root` with
`wmo_group_submeshes_strict`. WDL positions and ADT placement translations
are raw WoW world coordinates; model vertices are model-local. Native baking
maps `(X,Y,Z)` to `(-Y,Z,-X)`, then applies `placement_rotation` and the
authored doodad scale (WMO scale is one).

The proxy loader/cache and alpha-atlas image handles are Bevy-specific;
the browser must provide its own async jobs, images and instancing.
`wdl.wgsl` also imports Bevy mesh/view transforms and material-group bindings:
90 global light/fog, 91 horizon parameters, 92/93 texture/sampler,
94 liquid flags, 95 feature flags. Replace those bindings/imports rather
than copying them unchanged. Keep actual projected reverse-Z depth for racer
geometry, alpha discard at 224/255, and radial fog/fade/cutoff at
3,500/5,500/6,000 yards. Stock backdrop depth pushing is not the racer path.

The optimized regression run passes 33 app racer tests, 11 world racer/WDL tests
and all 50 terrain-stream tests (including five racer-specific cases),
plus 12 ordinary world-focus and
19 movement-wire tests. The standalone numeric physics suite passes all 30.
The new Avian cases cover ground and air at 250/500 yd/s and 30/60/144 Hz,
unrelated queue backlog, an intermediate missing tile, newly accelerated
frontier crossings, momentum-preserving holds/resume, and a 400 ms frame without
catch-up displacement. These are deterministic integration checks, not human
handling feedback or a reproduction of the player's exact live location.

Rebuild and run the affected suites in the VS2022 developer environment, using
this worktree's absolute target directory and one compiler job:

```powershell
$env:CARGO_TARGET_DIR = Join-Path (Get-Location) 'target-racer'
Push-Location client
cargo test --profile play -j 1 -p benilla-app -p benilla-world `
    -p flats-racer-physics --lib --no-fail-fast racer
cargo test --profile play -j 1 -p benilla-app -p benilla-world `
    -p flats-racer-physics --lib --no-fail-fast terrain_stream
cargo build --profile play -j 1 -p benilla
Pop-Location
New-Item -ItemType Directory -Force target-racer\streaming | Out-Null
Copy-Item target-racer\play\benilla.exe target-racer\streaming\benilla.exe
```

`WOW_MOVE_TRACE=<path> WOW_MOVE_TRACE_TAGS=racer` records actual motion,
stream holds with proposed/actual velocity and queue state, swept collision
normals, discarded long-frame time, authority changes and received server
corrections/control. Add `racer-support` only for detailed support-ray traces;
it is high-volume. Correlate the last motion/hold/collision/correction records
before attributing a stop to streaming.

The manual streaming launcher is isolated from previous racer worktrees:

```powershell
& .\client\scripts\Start-Racer-Streaming.ps1 `
    -DataPath 'C:\Users\liz\Downloads\Stonetavern-Classic-1.12.1-v1.8\Data' `
    -AuthAddress '127.0.0.1:3725' -Trace
```

It requires this worktree's `target-racer\streaming\benilla.exe`, sets
`BENILLA_HOME=target-racer\streaming-state`, clears inherited `WOW_*` switches
(including credentials, synthetic input and timed exits), disables sound and
requires manual login. It restores the calling process environment on exit.
Optionally supply `-TuningFrom <existing-racer-tuning.txt>` once; it refuses to
overwrite the destination. It never starts or updates a server. Confirm the
isolated server is available and compatible before logging in; the previously
documented fixture may have expired.

### Offline installed-data streaming instrument

From a clean PowerShell process (no inherited `WOW_*` switches), after the build
and copy above:

```powershell
$env:WOW_DATA = 'C:\Users\liz\Downloads\Stonetavern-Classic-1.12.1-v1.8\Data'
$env:BENILLA_HOME = Join-Path (Get-Location) 'target-racer\streaming-state'
$env:WOW_UNATTENDED = '1'
$env:WOW_NOSOUND = '1'
$env:WOW_CAPTURE = 'flats-racer'
$env:WOW_RACER_STREAM_PROBE = '1'
$env:WOW_RACER_PROBE_OUT = Join-Path (Get-Location) 'target-racer\streaming\probe.json'
$env:WOW_CAPTURE_OUT = Join-Path (Get-Location) 'target-racer\streaming\probe.png'
& .\target-racer\streaming\benilla.exe
```

This never logs in or starts a server. It requires actual terrain collision,
four support hits, a mount rig and a seated rider before advancing. Preflight
has a finite 135-second deadline and reports missing prerequisites every ten
seconds; a timeout is failure, not a successful screenshot.
Four reset segments impose 250/500 yd/s on ground and in air, using real frame
delta and the production fixed-step resolver, with acceleration/drag disabled
to isolate velocity preservation. Each attempts five seconds, capped at thirty
seconds wall time. JSON reports collision continuity, tile crossings, holds
and before/after velocities, support, body/camera positions and WDL residency.
`max_frame_ms` measures only probe-system work; `max_frame_delta_ms` includes
the whole frame interval. The WDL byte count is raw mesh payload per CPU or
GPU copy, not measured total RAM or VRAM. Neither this offline instrument nor
the unit suite exercises live server corrections or establishes human feel.

### Installed-data measurements

The final `probe-survey` run on RTX 3060/Vulkan completed all four segments and
exited with code 0. It used `Instant` wall-clock intervals, not the capture
system's synthetic Bevy clock. Initial readiness took 656.865 ms; the measured
probe window was 21.093 seconds.

| Imposed segment | Tile changes | Holds | Total held ms | Longest hold ms | Largest whole-frame interval ms |
|---|---:|---:|---:|---:|---:|
| 250 yd/s ground | 1 | 0 | 0 | 0 | 17.814 |
| 500 yd/s ground | 1 | 0 | 0 | 0 | 37.091 |
| 250 yd/s air | 2 | 1 | 248.757 | 248.757 | 45.448 |
| 500 yd/s air | 4 | 2 | 488.167 | 250.771 | 28.775 |

Every measured hold preserved velocity exactly (maximum delta 0.000000).
Fifteen frames in the last segment lacked current body-tile completion proof:
each immediately asserted a hold with identical position and velocity.
All resets and segment starts/ends had collision proof. No long-frame time
was discarded in this run; deterministic tests separately cover backlog and
no-catch-up behavior. Missing proof never authorizes movement.

Peak residency was 15 ADTs, 17 requested tiles and 451 WDL patches
(13,407,328 raw mesh bytes per CPU/GPU copy). A preceding passing traversal
sampled approximately 1.27 GB working set and 2.06 GB private process memory;
these are total process measurements, not incremental horizon cost or VRAM.
The final screenshot switches only the offline probe to a downward survey
camera after traversal assertions, visibly showing coarse distant relief.
It does not validate the normal driving camera's appearance or handling.

Ground runs encounter real terrain and launch/redirect; they do not establish
sustained flat-ground cruise at the imposed speeds. The 250 yd/s airborne run
retained its horizontal speed, while the 500 yd/s run hit geometry and changed
direction legitimately. Cold loads can still pause motion for about 0.25 s on
this machine. The roughly 1,067 yd collision lookahead is bounded independently
of the 6,000 yd visual horizon; neither makes unloaded land driveable.
The exact live player's stop and any server contribution remain unverified.
Local JSON, screenshots and logs stay ignored under `target-racer\streaming`;
reproduce them with the command above rather than treating a screenshot alone
as a collision-safety result.

## Human acceptance and world-exploration checks

For the suspension refinement, drive the same moderate hill in both directions
without hopping: thrust, steering and boost should remain available while
supported. Cross small bumps at a steady speed and look for compression/recovery,
not a rigid height snap. Crest a hill quickly: gravity must take over when the
probes lose reach, followed by a settled landing. Hop once uphill and downhill,
hold the hop button, then release/repress after landing; holding must not create
repeated flight. Compare the saved spring/damping 90/18 with a softer pair such
as 50/12, then restore the saved values explicitly if preferred. Repeat F9 and
unmount to check reset, camera snapping and normal walking. These feel/terrain
checks require human play; numerical assertions alone do not establish them.

The user reported that the uncapped racer feels wonderful after manual play.
That is real handling feedback, not validation of this later range/persistence update.
On a separately scheduled server/client update, with the player's permission and
without another session using that account: enable the server option, enter the
Flats, press F8, verify the Goblin car and properly seated rider, then W for two
seconds, Shift briefly, A/D with and without Ctrl, S to a stop, and Space once.
Verify acceleration responsiveness, drift recovery, a short hop and landing,
camera damping/occlusion and render banking. Approach an existing solid track
obstacle at low speed, then boosted speed; verify stopping/sliding rather than
tunneling. Approach a streaming frontier and verify a safe hold. F9 must return
to the documented safe point without a correction loop. F8 must restore ordinary
walk/run, jump and camera behavior; repeat with the client/server opt-ins absent
and verify normal walking and movement validation are unchanged.

In F10, re-enter the preferred high tuning once and Apply. Close and relaunch
with the same `BENILLA_HOME`; every field must match exactly. Apply cruise/boost
values above the old 50 yd/s ceiling (start with 80/120), plus increased thrust,
and confirm the HUD exceeds 50 on clear resident terrain. Drive beyond the old
Flats rectangle into adjoining outdoor terrain; there must be no area/leash rejection.
Check hills and substantially different altitudes, streaming-frontier hold/recovery,
F9 returning to the original mount anchor, and ordinary map-change/remount on both
continents. Do not treat unstreamed terrain or oceans as a track. Try camera
position seconds `0`, `0.15` and `0.4` at the same speed, then F9 and
unmount/remount: reset must snap immediately and camera collision must still
prevent wall penetration. Reject `NaN`, `inf`, negative camera seconds and
boost below cruise without partially applying any other field.

Neither the offline capture nor the isolated scripted drive establishes
world-wide obstacle coverage or competitive safety. Never use the currently playing user's
account for scripted validation. Scripted login requires a separate ignored
`.probe-identity`, `WOW_UNATTENDED=1` and `WOW_NOSOUND=1`.
