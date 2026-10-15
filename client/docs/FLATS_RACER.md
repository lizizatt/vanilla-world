# Shimmering Flats hover racer (custom fork)

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
& .\target-racer\play\benilla.exe
```

The server must also explicitly enable the custom mode; see
[`server/doc/FlatsRacer.md`](../../server/doc/FlatsRacer.md).
An unmodified or disabled server cannot grant it.
Log in normally and travel to the Shimmering Flats on Kalimdor, near WoW
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
| Space | One hop per press, then brief airborne steering; no flight |
| F9 | Server-authorized safe reset; motion waits for the reset acknowledgement/pose |
| F8 | Unmount and return to normal walking |
| F10 / HUD Tuning button | Open/close numeric tuning panel; brakes held while open |

The tuning panel has 17 text boxes: speed/boost caps, thrust/boost thrust, braking,
drag, turn rate/response, grip/drift grip/drift turn multiplier, hover height,
spring/damping, gravity, hop speed and airborne steering fraction. **Apply**
validates the entire set atomically; an invalid field leaves the current handling
unchanged and displays its reason. **Restore defaults** applies the original MVP
handling. Values last only until this client exits (not saved to the account).
Tab advances through fields, Enter applies, and Escape in a field closes.

Speed caps are limited to 1–50 yd/s (boost cap must be at least the normal cap),
thrust/boost thrust to 0–60, braking to 0–100, drag to 0.01–5, turn rate to
0.1–6 rad/s, turn response to 1–30, grip/drift grip to 0.1–30, drift turn to
0.1–3, hover height to 0.5–1.5 yd, spring to 10–150, damping to 1–35,
gravity to 10–40, hop speed to 2–8, and air steering to 0–0.5.
Collision, streaming holds and server authorization/region/speed guards are
unchanged. Tuning is bounded experimentation, not a promise that every extreme
combination will feel good.

### Controller

Controller support is enabled only with `WOW_FLATS_RACER=1`, using Bevy's existing
gamepad backend. Xbox / PlayStation names below refer to the same physical buttons:

| Control | Action |
| --- | --- |
| Left stick X | Steer (18% deadzone, remaining travel rescaled) |
| RT / R2 | Analog thrust (8% deadzone) |
| LT / L2 | Brake (on/off above 12%, not proportional braking) |
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
controller navigation for the stock client UI. Unfocused, typing and loading gates
apply to both driving devices.

Reset returns to the grounded position where the server granted this mount, not
to a client-selected coordinate. Mount on a clear, level part of the track.

The small HUD shows authorization/streaming status, speed and boost. Typing,
unfocused-window or loading input brakes rather than driving. Death, combat,
foreign mover/control loss, missing mount, disconnect and unexpected corrections
relinquish custom control. Normal movement retains its existing server checks.
Only explicitly unattended probe-generated keys can operate the racer without
focus; physical background keyboard input is excluded.

## Implementation boundary

The installed `CreatureDisplayInfo` row 10318 resolves model 1471 to
`Creature\GoblinRocketCar\GoblinRocketCar.m2`; this is the actual available Goblin
salt-flats racer. The ordinary renderer seats the rider at its real attachment 0,
not a fabricated seat offset. The offline fixture uses installed human male
display 49. Data is opened at runtime from the owner's read-only installation;
no MPQ/model/texture is extracted into the repository.

`flats-racer-physics` is the deliberately small custom numerical crate. The app
adapter owns authorization, actual terrain support and swept collision. It runs
at 120 Hz with four spring/damper support probes, bounded boost/hop/gravity and
three swept spheres with sliding and turn clearance. The collision body stays
upright; only the render mount banks. The damped chase camera uses the existing
world camera collision query.

Current and projected support footprints must have resident, scene-ready,
fully-collided terrain. Missing support/stream readiness holds the body instead
of running through unbuilt collision. At most 12 steps are caught up per frame;
time beyond a 100 ms hitch is intentionally discarded, not a claim of real-time
simulation through stalls.

Intentional protocol deviation: physical hops remain grounded wire poses while
the explicitly authorized custom server mode validates its own bounded movement.
This exception is not a global anticheat bypass or unrestricted flight mode.
Custom server authorization and speed handling are separate from normal walking.

The bounded track accepts installed AreaTable IDs 439 (The Shimmering Flats) and
2240 (Mirage Raceway), both on map 1 under zone 400. Area 479 is The Rustmaul
Dig Site and is deliberately rejected. The ordinary-account activation probe
identified the original wrong-area assumption: its authoritative area was 2240,
player z -58.7415, ground -58.7517, and delta 0.0102 yd. State and ground
prerequisites passed; the corrected shared area check is used for activation
and ongoing movement. Rejections now report the actual failing state or terrain
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

The tuning update passes 17 app racer tests (including real EditBox entry,
atomic Apply/defaults, controller mappings, device switching, disconnect and
normal-mode exclusion), 17 numerical physics tests and the schedule-order audit.
Cosmetic banking now runs in PostUpdate before animation and terrain conforming;
the camera is explicitly excluded from its mutable transform query.
The full Windows app run reports 4,846 passed, 12 ignored and three failures:
`cvars::deviations_doc::the_deviates_rows_read_back_as_the_generator_reads_them`
(CRLF string parsing), `ui_script::fire_scan::every_relay_has_its_origin_in_view`
(Windows path tracing), and
`ui_session::tests::every_npc_session_is_portrait_bound_or_explicitly_excluded`
(source-structure parsing). These unrelated source-audit failures remain
unresolved; the full suite is not claimed green.

The installed-data tuning-panel capture retains the 480-frame measurements
above, and all 17 fields plus Apply/defaults/Close were visually inspected.
Synthetic gamepad tests do not establish physical controller mapping or handling
feel. For the human pass, apply a lower speed cap and turn rate, close the panel
and compare handling; restore defaults, then alternate keyboard presses with pad
buttons/axes and check tutorial changes, deadzones, focus loss and disconnect.

### Current Windows isolated-instance handoff

The prepared workspace is
`C:\Users\liz\copilot-worktrees\vanilla-world\lizizatt-special-guacamole`.
Its separate executable is `target-racer\play\benilla.exe`. Nothing here updates
the original running client or server. The ignored
`target-racer\probe-runtime\identity.private.json` contains the dedicated non-GM
account credentials and `Racerprobe` character name; never commit or publish it.
The scripted client has exited and disconnected. This character is already at
Mirage Raceway, map 1, near `(-6235, -3945, -58.75)`, with full health. Use this
account rather than moving or logging in the original player.

From that workspace, explicitly start the manual, sound-disabled client with:

```powershell
powershell.exe -NoProfile -File .\target-racer\probe-runtime\Start-Racer.ps1
```

This local ignored launcher reads that identity, selects auth
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

The isolated auth/world driver is stopped after the recorded probes; the DB may
still be running. A newly started driver has a 40-minute lifetime. Inspect only
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
python .\target-racer\probe-runtime\Run-Isolated-Servers.py
```

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

## Human acceptance test still required

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

Neither the offline capture nor the isolated scripted drive establishes
interactive feel or competitive safety. Never use the currently playing user's
account for scripted validation. Scripted login requires a separate ignored
`.probe-identity`, `WOW_UNATTENDED=1` and `WOW_NOSOUND=1`.
