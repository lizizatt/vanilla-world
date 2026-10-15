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

- `.flatsracer on`: while already standing on the track, save that grounded position
  and orientation as the transient safe start, with terrain +0.25 yards clearance.
  Does not relocate the character.
  Requires no existing mount. Calls `Player::Mount(10318)` and, only after
  success, sends exactly `FLATS_RACER ON` as a server SYSTEM message.
- `.flatsracer off`: revoke the grant, clear movement/spline/fall state, and use the
  normal near-teleport correction to return to the saved ground point. Unmounts
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

Map **1** only; inclusive rectangle **x [-6500,-5700], y [-4500,-3300]** and
absolute **z [-65,-45]**. The terrain query must also identify Shimmering Flats
(area **439**) or Mirage Raceway (area **2240**) and valid ground in that same
height range. Positions must remain between **ground -0.75 and ground +6 yards**.
The installed build-5875 AreaTable.dbc identifies both areas as children of
Thousand Needles (400); area 479 is The Rustmaul Dig Site and is not authorized.
Enabling requires being within 0.75 yards of ground. The owner's read-only ADT
preflight measured terrain -58.7500 at x=-6235, y=-3945 and all four supports
(+/-3 x, +/-1.7 y). At that point reset uses **(-6235,-3945,-58.50)**; the client
may settle upward to its 1.2-yard hover height. These coordinates are not
hard-coded: actual loaded server terrain must validate activation and the saved
clearance point must remain bounded. Missing map/height data rejects activation.

Only ordinary movement packets with flags in **0x3f** (forward/back/strafe/turn)
are accepted. Use plain grounded flags even during the local gravity hop: no
hover, fly, swim, transport, walk-mode, jumping, or far-falling flags.
Positions/orientation and motion floats must be finite. Orientation is 0..6.284.
Horizontal distance uses a **60 yd/s** server-clock token budget; absolute vertical
distance uses **20 yd/s**. Initial slack is 100 ms and total saved slack is capped
at **250 ms** (15 horizontal/5 vertical yards), regardless of idle time or client
timestamps. Packet spam cannot regenerate a per-packet tolerance. Long network
gaps can therefore revoke the experiment rather than accepting a large catch-up.
These limits constrain distance, not a full physical trajectory simulation.

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

The C++ assertions cover opt-in/loopback authorization, range/area/height, finite
values, prohibited flags, speed/diagonal/vertical budgets, packet spam, idle
teleports, and clock wraparound. The PowerShell test checks source-level wiring, including
unchanged normal-mode stock anticheat and lifecycle revocation; it is not a runtime
integration test. Neither replaces compiling the server or an
isolated client/server terrain and teleport-ACK integration test. Do not use live
services, live accounts, credentials, or deployed configuration for validation.
