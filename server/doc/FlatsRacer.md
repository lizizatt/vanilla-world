# Local Flats racer (custom fork)

This is an explicitly opt-in local experiment, not a public-realm movement feature.
The shipped config defaults to `CustomFlatsRacer.Enable = false`. Enabling it in an
isolated server config allows an ordinary in-game player session from exactly
`127.0.0.1`, `::1`, or `::ffff:127.0.0.1`; no account elevation or console access is
required or granted. Never enable it behind a proxy that can report a forged loopback address.
The exact `.flatsracer` command remains usable when general player commands are
disabled, but only with local opt-in enabled (or an existing grant to turn off).
Other commands retain their existing permission and configuration checks.
There is no database state, custom opcode, or global anticheat exemption.
The racer uses fixed display **10318**, model **1471**,
`Creature\GoblinRocketCar\GoblinRocketCar.m2`, verified by the owner's read-only
CreatureCatalog/M2 probe at scale 1 with rider attachment 0. No seat fallback is
needed. Activation rejects missing server CreatureDisplayInfo data for this ID.

## Commands and wire contract

The explorer client requires the updated world-explorer server implementation.
An older Flats-bounded server is incompatible with explorer movement and may
reject it and return the racer to its start. Building these artifacts does not
update a running server: explicitly update the server before using the explorer
launcher. Do not launch the explorer against the old running server.

- `.flatsracer on`: while already standing on supported outdoor ground, save that grounded position,
  map ID,
  and orientation as the transient safe start, with terrain +0.25 yards clearance.
  Does not relocate the character.
  Requires no existing mount. Calls `Player::Mount(10318)` and, only after
  success, sends exactly `FLATS_RACER ON` as a server SYSTEM message.
- `.flatsracer off`: revoke the grant, clear movement/spline/fall state, and use the
  normal same-map near-teleport correction to return to the saved ground point. Unmounts
  the racer-owned display, without removing a different mount. Sends
  `FLATS_RACER OFF`. Requires an active grant, but remains available after disabling
  the config.
- `.flatsracer reset`: requires an active, currently eligible grant; correct to its
  original safe start while retaining authorization, then send `FLATS_RACER RESET`.
  Wait for the ordinary teleport ACK before sending racer movement again.
  The racer mount is retained on a successful reset.

Only SYSTEM messages from the server authorize the companion client. Player chat,
whispers, prefixes, suffixes, and other chat types must not authorize it.

## Independent limits

Outdoor continents **map 0 and map 1** only, using the server's `IsContinent`
classification and `MapManager::IsValidMapCoord`. There is no Flats rectangle,
area-ID restriction, fixed elevation band, or maximum height above ground.
Finite coordinates must still fit the engine map bounds (x/y approximately
±17066 yards, z ±400000), and orientation must remain 0..6.284.
Destination map/vmap tiles must be available according to `ExistMapAndVMap`;
the ordinary server VMAP configuration still controls which collision data is required.
`Map::GetHeight(..., MAX_FALL_DISTANCE)` queries terrain, VMAP and dynamic
collision ground with the engine's full fall-search range. Missing/invalid
ground, indoor destinations, and endpoints below **ground -0.75 yards** reject
movement with a specific reason. High ballistic hops and high hover settings
are accepted above genuine supported ground without an arbitrary six-yard cap.

Enabling still requires standing within 0.75 yards of ground. The original grant
anchor is saved at terrain +0.25 yards and is never replaced while driving through
zones. Reset/off revalidate that exact anchor's coordinates, map, available tiles,
outdoor status and grounded height before correction. Unsafe/unavailable anchors
disconnect rather than silently choosing another point or reporting success.
Driving between zones on the same continent is supported; cross-map travel,
instances and seamless overseas travel are not. External teleports revoke the
grant; enable a new grant after arriving and settling on supported ground.

Only ordinary movement packets with flags in **0x3f** (forward/back/strafe/turn)
are accepted. Use plain grounded flags even during the local gravity hop: no
hover, fly, swim, transport, walk-mode, jumping, or far-falling flags.
Positions/orientation and motion floats must be finite. Orientation is 0..6.284.
This authorized local mode is **client-authoritative** for handling and speed.
Any finite, geometrically valid supported-world endpoint is accepted, including movement
above 60 yd/s horizontally or 20 yd/s vertically. Finite speed caps and handling
values remain client-configurable; there is no server tuning handshake or velocity
budget, and neither elapsed time nor packet frequency constrains displacement.
Both current and destination positions are finite and bounded by ordinary engine
coordinates, not a racer-specific region. This validates endpoints, not the
intervening trajectory or client physics: server-side swept collision and ballistic
simulation are not added. Client terrain/collision handling remains responsible
for the path and landing. Entering unloaded terrain, indoor geometry, below-ground
positions, or engine-invalid coordinates revokes the grant.

Alive, noncombat, freely moving, self-controlled players only; activation requires
being unmounted, and active mode requires the racer-owned mount. External dismount,
taxi, transport, root/control changes, death, combat, external teleport, logout/world
removal, and config disable revoke the transient grant. Active server splines,
pending spline completion, and knockback also prevent activation. Combat revocation happens
on combat entry and again before packet validation; correction preserves combat
rather than evading it. Speed/flag/root/knockback/spline and inactive-mover ACKs
revoke and correct instead of gaining a second custom-movement path; expected
speed/flag/root/knockback ACK bookkeeping is still consumed without relocation. Ordinary
movement without a grant continues through the unmodified stock anticheat tests.
No grant survives reconnect. A failed correction reports an error and disconnects,
not a successful reset. Stock `UNIT_FIELD_MOUNTDISPLAYID` replication supplies the
mount model and rider attachment; the character's own model is unchanged. No
vehicle protocol or persistent avatar property is added. Stock mount/unmount pet
and aura behavior applies.

## Offline validation

Compile `tests/FlatsRacerTests.cpp` with a C++14 compiler, with assertions enabled
(no `NDEBUG`), and execute the resulting **test**, not a server process. For example,
from the server directory using a developer PowerShell:

```powershell
New-Item -ItemType Directory -Force build\flats-racer | Out-Null
g++ -std=c++14 -Wall -Wextra -Werror tests\FlatsRacerTests.cpp -o build\flats-racer\FlatsRacerTests.exe
if ($LASTEXITCODE -eq 0) { & .\build\flats-racer\FlatsRacerTests.exe }
& .\tests\FlatsRacerIntegration.Tests.ps1
```

The C++ assertions cover opt-in/loopback authorization, continent policy, finite
values/orientation, prohibited flags, invalid-ground sentinels, below-ground
rejection and world/high-altitude endpoint transitions without a time budget.
Terrain values in these standalone assertions are fixtures, not live map queries.
The PowerShell test checks source-level wiring, including invalid live-state rejection,
the absence of a racer time/displacement/maximum-altitude budget, engine map
validation, tile/outdoor/ground queries, original-map anchor revalidation,
unchanged normal-mode stock anticheat and lifecycle revocation; it is not a runtime
integration test. Neither replaces compiling the server or an
isolated client/server terrain and teleport-ACK integration test. Do not use live
services, live accounts, credentials, or deployed configuration for validation.
