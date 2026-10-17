# Vanilla World in your browser

A local, single-player **world explorer**, using this repository's Rust racer
physics and ADT/WDT/WDL/M2/WMO/BLP parsers through WebAssembly. This is an alternate
WebGPU rendering adapter, **not a Bevy/VMaNGOS port or a completed singleplayer RPG**.
It does not connect to or modify the native server, database or account system.

## Run locally

Use a current hardware-accelerated Edge or Chrome. From the repository root:

```powershell
.\browser\Build.ps1
node .\browser\server.mjs
```

Open **http://127.0.0.1:4173** and select the **Data** directory in your own Classic
1.12 installation. The browser reads the local MPQ patch chain directly. No
exported terrain pack, login, upload or whole-archive copy into Wasm is needed.
The native directory picker remembers a handle; a later session may require
**Reconnect Data folder** to grant read permission again. **Choose folder as files**
is the fallback and must be reselected after reload.

If the build reports a missing target or binding generator, install those exact
prerequisites, then rerun it:

```powershell
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli --version 0.2.122 --locked --root .\target-web\tools -j 2
```

Build output stays in this worktree's `target-web`; it does not touch the native
racer cache. The server binds loopback only and serves an explicit file allowlist,
not your Data directory.

## Explore

You start on actual raceway terrain in `Kalimdor_39_43.adt`, in Thousand Needles.
The spawn height comes from the ADT, not a guessed sea-level floor.

| Mode | Controls |
|---|---|
| Drive, native keys | W thrust, S brake, A/D steer, Space hop, Shift boost, Ctrl drift; C/J aliases, V look behind, F9 reset |
| Standard controller | Left stick steer, RT thrust minus LT reverse, RB boost, LB drift, A hop, right stick orbit, D-pad zoom, Y reset, Start drive/fly |
| Chase camera | Right-drag or arrow-key orbit, wheel zoom; 0.5-second position filter by default |
| Free flight | W/S forward/back, A/D strafe, Q/E altitude, arrows look, Shift fast |
| World overview | Frames both complete coarse continents |
| Return to vehicle | Returns to the parked hovercraft; does not teleport it to the flight camera |

Click the view to capture keyboard input. Flight is deliberately collision-free.
**Save locally** stores the parked vehicle, flight camera, mode and display
settings. **Load save** restores them; **Start at raceway** recovers without
overwriting a saved pose until you explicitly save.
Display switches do not disable collision.
The **Controls, camera & sound** panel retains the original browser key profile
(S reverse / Space brake). Existing saves without a profile keep those bindings;
new sessions default to native keys. Gamepad inputs use standard browser mappings,
deadzone rescaling and press edges; disconnect, lost focus and editing controls
clear thrust instead of leaving a stuck accelerator. Flight retains keyboard
movement, with right-drag look.

The amber/teal instruments show actual signed motion, airborne/hold state and
boost reserve. **Procedural engine sound** enables the native original three
stereo synthesis beds and speed/thrust/boost envelopes through Web Audio, without
game audio files or Kira. It starts only after interaction, fades outside driving,
and suspends when muted/hidden. Browser permission policy may require another click
after restoring a sound-enabled save.

**Handling & camera** edits the 17 existing Rust physics parameters plus camera
smoothing seconds. Rust validates the complete set; successful writes persist in
a separate per-install tuning record without overwriting the saved vehicle pose.
Failed storage leaves active handling unchanged. There are no gameplay upper
ceilings, but values must fit finite f32 physical domains, and extreme combinations
can fail simulation explicitly. Brakes are held while the editor is open.
Camera zoom is separately limited to 0-50 yards. Desired and filtered chase paths
are clipped against loaded ground and the shared collision BVH; filtered lag cannot
escape that 50-yard camera query window. This is not a world draw-distance limit.

Save keys include layout version 3 and an SHA-256 fingerprint of ordered archive
metadata. This is not a full-content archive hash. Different installations/layouts
do not silently relocate one another's saves. Legacy racer/voyage IndexedDB
databases are left untouched; old demo entrypoints are no longer the app.
The service worker caches the app shell and, when present, the private NPC
companion for offline use. Local Data access is still required offline.

## World and streaming boundaries

Both complete authored WDL continents stay resident, at original scale and
orientation. On the tested installation they contain **1705 patches, 929225
vertices and 1745920 triangles**, about 26.3 MB of GPU payload. Kalimdor and
Eastern Kingdoms are separated by **8192 yards** between authored bounds.
Eastern Kingdoms is shifted **11200 yards south**, half its WDL north/south extent.
This is provisional map layout, not canonical ocean geography.

Detailed ADTs stream around the driver or flight camera. At most
**four** are resident: all support/swept-query tiles are pinned before eviction,
including four-way corners. Prefetch is lower priority. An expected but missing,
corrupt or still-loading ADT blocks driving; it never becomes substitute ocean.
Only successfully parsed WDT absence connected to the map exterior can add
exterior ocean, and contradictory WDL land remains unavailable for driving.
WDL supplies no collision. Below-sea land, including the raceway, is retained.
Authored MCLQ supplies detailed inland water.

Loaded ADTs replace their WDL patches atomically. Edge strips bridge coarse/detailed
height differences visually, not physically. Both use real projected depth;
coarse terrain can still produce visibly angular cliffs and shorelines.

Nearby models use authored geometry, transforms, BLP textures, UVs, alpha cutoff,
material blending and depth. The scene budget is **96 geometry/root resources,
192 dependent textures, 96 MiB decoded payload and 1024 instances**. These are not
total browser/process memory limits: parser temporaries, JavaScript bookkeeping,
main-thread/GPU copies and driver memory are additional. Capacity/pending counters
mean some farther content is incomplete, not that it loaded successfully.

Detailed ground uses native ordered layer blending, authored normals, texture
coordinates, alpha masks, shadow masks and holes. Bounded texture arrays and
mipchains reuse the local BLP data. Far terrain progressively receives translated
native minimap colors in two 2048-square atlas pages (32 MiB); missing mappings
stay explicit. Static sunlight/fog remain an approximation, not DBC time-of-day
lighting or full native water sheen.

The bounded distant-model port reuses the native strict geometry/material
boundary and complete authored M2 leaf batches rather than copying Bevy's
clustering/atlas implementation. Up to **12 separate visual metadata tiles**
retain placements, not terrain meshes, sharing the same 96 MiB asset cache.
Models can be visible out to **6000 yards**, with authored alpha cutoff, real
depth, and dither/fog fading from 3500 yards. The nearest metadata tiles and
active continent are selected; this is not exhaustive residency of every prop
inside that radius. Near requests win, and dense near content can defer far
content. Distant metadata supplies neither NPCs nor collision.

Only one distant ADT read is outstanding, started at most twice a second after
current collision requirements are ready; late results for an evicted selection
are discarded. Existing near placements are reused without another archive read.
Combined model drawing retains a nearest-first prefix capped at **two million
triangles and 4096 draw calls**; any omitted instances are reported in the HUD.

Collision uses **BVH-indexed authored collision triangles**, with continuous
swept hovercraft-hull tests and four support probes, not foliage cards or a WDL
floor. Mesh height preserves openings and bridges that whole-building bounds
previously blocked. The near collision cache has a separate 200,000-triangle
safety limit and is not hidden by the visual instance budget. Collision does not
wait for alpha textures. Unavailable nearby geometry is held explicitly; unresolved M2
extents use a conservative 32-yard proximity guard, not a proof of empty space.
Terrain, near-object and solid-contact hold counters are exposed in
`window.worldEvidence.state.holds`. **Retry terrain** also retries failed scene
assets. No baking or silent collision disablement is implemented.

## Static NPCs and private data

Client Data contains appearances, **not spawn coordinates**. This installation
can serve a private companion at `runtime\browser\npc-spawns.json` through the
single `/local/npc-spawns.json` loopback URL. That ignored artifact was generated
from the user's offline 2021 world SQL snapshot and includes provenance.
It contains 53,453 static overworld spawns and 5,537 resolved display definitions.
Do not commit, upload or redistribute it. See [SCENE.md](SCENE.md) for the optional
private export commands and schema.

Without that companion the app explicitly reports no NPC population. NPCs are
static bind-pose appearances, not live server entities. Equipment, complete
humanoid customization, animation, event/pool scheduling, quests and combat are
not implemented. Baked humanoid bodies omit unresolved hair/cape batches rather
than drawing fake opaque cards.

## Checks and evidence

```powershell
$env:CARGO_TARGET_DIR = Join-Path (Get-Location) 'target-web'
$env:WOW_DATA = 'C:\path\to\your\install\Data'
$env:BENILLA_REQUIRE_DATA = '1'
cargo test --manifest-path .\client\Cargo.toml --release -j 2 -p flats-racer-web
node --test .\browser\asset-source.test.mjs .\browser\scene-stream.test.mjs .\browser\world.test.mjs
# With the local preview running and Playwright installed:
node .\browser\overworld-smoke.mjs
node .\browser\distant-smoke.mjs
node .\browser\feel-smoke.mjs
```

If Playwright is missing, run `npm ci --prefix .\browser`; tests use installed
Edge (`channel: msedge`), not a downloaded browser. The real-browser check uses
actual directory-backed File objects, drives using keyboard input, visits both
maps and reloads saves offline. It does **not** automate the trusted OS directory
picker dialog. Evidence/screenshots stay ignored in `browser\test-results`.
The distant check compares actual screenshots with models enabled/disabled at
1400-yard camera altitude on both continents; it asserts visible changed pixels,
real cutout batches, unchanged terrain residency and no distant collision holds.
It freezes presentation time and settles asset events before comparison so moving
water and progressive texture uploads cannot masquerade as model pixels.
The feel check exercises native/legacy inputs, the actual Web Audio output graph,
synthetic standard-gamepad values through the browser frame path, tuning validation,
write-failure preservation and offline reload. It does not claim a physical gamepad
or subjective listening test.

[ASSETS.md](ASSETS.md) documents the bounded MPQ reader, corruption semantics,
77-file native/Node/Edge parity and the whole-install codec census. All 2,389,542
compressed sectors in this installation used supported zlib; other installations
may require codecs that currently fail explicitly.

Native Bevy render phases, moving-transport timetables, animation and a server
simulation are not ported. Coarse/detailed seams remain visible. Exact native
cockpit seating requires a selected rider's head height and animated attachment
frame; a mount attachment is not a substitute for that missing rider data.
