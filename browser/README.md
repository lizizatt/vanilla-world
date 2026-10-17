# Local browser racer MVP

An **alternate WebGPU rendering adapter**, not a port of Bevy or VMaNGOS.
`flats-racer-web` compiles the repository's existing `flats-racer-physics` and
`benilla-formats` (including the ADT parser, triangle mesher and terrain height
queries) to Wasm. JavaScript owns browser input, rendering and IndexedDB only;
it does not reimplement racer dynamics. The native client/server are unchanged.

The default single-tile lab is explicitly **synthetic flat ground**. Importing
a private vanilla ADT replaces it with that tile's actual height geometry.
**Route mode** streams a real four-tile coastal corridor with an explicit ocean
connection. The cyan hovercraft is an original geometric marker, not an imported mount.

## Continuous coastal route

The first crossing is **Durotar east coast to Westfall west coast**, not complete
Kalimdor and Eastern Kingdoms. Its four actual source tiles are
`Kalimdor_41_33`, `Kalimdor_42_33`, `Azeroth_27_51`, and `Azeroth_28_51`.
Terrain and liquid meshes remain authored game geometry; there are no invented
coastlines. The two source oceans share height 0.

The **512-yard connecting ocean is new, provisional test geography**, not
canonical continent spacing. The 533.33-yard-wide corridor deliberately keeps a
crossing short enough to test. Kalimdor covers global east X 0..1066.67; the
connecting ocean covers X 1066.67..1578.67; Eastern Kingdoms covers
X 1578.67..2645.33. The departure/arrival path is at global south Z 160, from
approximately X 288 to X 2208. Final continent spacing is undecided.

Export the private pack once from the existing read-only MPQ patch chain.
From the repository root:

```powershell
$env:CARGO_TARGET_DIR = Join-Path (Get-Location) 'target-web'
Push-Location .\client
cargo run --release -j 2 -p flats-racer-web --example export_route -- 'C:\path\to\your\install\Data' '..\runtime\browser\coast-route'
Pop-Location
```

The exporter refuses to overwrite an existing `route.json`. Choose a new
output directory for another export. It reads source archives through the
existing `Chain` implementation, including patch precedence, and never writes
to the install. `coast_scan` is a read-only companion for measuring source
ground/liquid along a candidate tile row before changing the route.

Use **Import route pack** and select `route.json` **and all four ADTs together**.
Every file's name, length, source bounds and SHA-256 are checked. The bounded
first import is a user-selected region pack, **not browser MPQ archive import
or whole-continent indexing**. Only one pack (up to 16 tiles/128 MiB, each tile
up to 16 MiB) is stored at a time. Import validates all hashes and source geometry
sequentially before an atomic IndexedDB replacement; malformed selections keep the old pack.
Files stay local and are never uploaded.

W drives east across the real shore, offshore tile, connecting ocean and arrival
shore; S travels back west. No ADT switching is needed while moving. The UI
reports region, ground/water support, global position, residency and rebases.
Going outside the imported corridor, into holes without support or into declared
impassable ground holds the craft; those places never become generic ocean.

### Coordinate and streaming contract

Source WoW coordinates remain north/west/up. A region's source tile origin and
translation-only global east/south placement are in `route.json`. Geometry is
meshed in tile-local coordinates; changing a placement does not bake or rescale
the continent. Global horizontal positions and saved poses are 64-bit numbers.
Rust physics remains local `f32`, rebased when either horizontal component
exceeds 256 yards. Rendering subtracts that same origin before GPU upload and
adjusts the camera on each rebase.

One dedicated worker owns the Rust route simulation, parsing and async
IndexedDB reads. It admits at most three resident tiles, prioritizes the body
and a 550-yard neighborhood, and evicts old Rust/GPU meshes. Reads and hashes
are sequential. Pack import uses one temporary validation worker, one tile at
a time, then terminates it; at most two workers exist during import. Whole MPQ
archives never enter Wasm memory. Rendering stays
on the main thread. Long loads discard excessive elapsed time rather than
teleporting the craft through an unloaded tile.

`Surface` is the vehicle-neutral seam: separate ground height, water height,
solid/impassable flag, availability and source region. Imported MCLQ wet triangles
provide water; only the explicit gap provides designed ocean water. The current
hovercraft chooses the highest supported surface. Solids currently mean authored
MCNK impassability, **not WMO/M2 building collision**. Missing/error tiles are
visible and block travel. **Retry tiles** retries the local read; reimport the
pack if a stored tile is absent or damaged.

### Versioned route saves and recovery

Route **Save locally** stores version 2, pack digest, vehicle type `hovercraft`,
and global X/Y/Z/yaw. Offline reload resumes at either coast, across a region
boundary, or mid-ocean. Saves are parked poses: momentum/timers/boost reset.
An atomic new pack import does not overwrite the old save. A save from a
different pack requires reimporting that exact original pack, or explicit
**Reset racer** followed by **Save locally** to replace it. Unknown versions,
invalid poses and unavailable saved surfaces report errors rather than
silently loading a different location.

The previous version-1 single-tile save lives in its original database and is
never rewritten or deleted by route mode. **Single-tile lab** restores access
to it. The last selected mode is remembered for reload. There is no automatic
conversion from a tile-local v1 pose into an arbitrary global region placement.

## Build and launch on Windows

Prerequisites: the client's pinned Rust 1.98.1 toolchain, native MSVC build
tools (for the binding generator/native tests), Node.js, and current Edge or
Chrome with WebGPU/hardware acceleration. No login, database, account secrets,
server bootstrap, or public hosting is needed.

From the repository root, install these only if missing:

```powershell
rustup target add wasm32-unknown-unknown --toolchain 1.98.1
cargo +1.98.1 install wasm-bindgen-cli --version 0.2.122 --locked --jobs 2 --root .\target-web\tools --target-dir .\target-web\tools-build
```

Build, then run the loopback-only static server:

```powershell
.\browser\Build.ps1
node .\browser\server.mjs
```

Open **http://127.0.0.1:4173**. Click the view to give it keyboard focus.
W/S or up/down accelerate/reverse; A/D or left/right steer; Space brakes;
Shift boosts; C drifts; J hops. Focus loss clears held keys; background time
does not accumulate physics catch-up. Dynamics advance at 120 Hz, independently
of drawing; stalls discard time beyond 100 ms per frame.

All Cargo output goes into this worktree's ignored `target-web`, never the
native client's `target-racer`. The generated web package is ignored too.
Do not run multiple Cargo builds concurrently on a shared development host.

## Single-tile lab: import actual terrain privately

Use the existing read-only patch-chain extractor. This example reads the
Shimmering Flats tile `Kalimdor_39_43.adt` from your own install, writing only
to this checkout's ignored runtime directory:

```powershell
New-Item -ItemType Directory -Force .\runtime\browser | Out-Null
$env:CARGO_TARGET_DIR = Join-Path (Get-Location) 'target-web'
Push-Location .\client
cargo run --release -j 2 -p benilla-formats --bin mpqx -- 'C:\path\to\your\install\Data' 'World\Maps\Kalimdor\Kalimdor_39_43.adt' '..\runtime\browser\Kalimdor_39_43.adt'
Pop-Location
```

Choose that file with **Import local .adt**. A complete tile (256 terrain
chunks), finite geometry, and a safe spawn are required; input is capped at
16 MiB. The shared mesher preserves the original four-triangle cell fans and
terrain holes. Rendering adds procedural shading/grid lines, not original
textures. Geometry is rebased to local Y-up coordinates.

**Never commit, upload or redistribute the tile, game assets, or imported-world
screenshots.** The static server deliberately serves only the application shell,
not runtime data, source files, node_modules or arbitrary paths. Import reads the
selected file in the browser; it does not POST it anywhere.

## Single-tile saves and shared offline shell

In the single-tile lab, **Save locally** stores terrain bytes and pose together in one
IndexedDB transaction. Reload or **Load save** restores both. A save is a parked
pose: momentum, jump timers and boost depletion reset, rather than resuming a
moving vehicle. Reset does not overwrite the saved record.

The service worker caches the application shell after the first successful
online visit. Wait for **Offline shell ready**; subsequent reloads at the same
origin can run offline, including the imported terrain if saved. No CDN is
used. Offline means a previously installed local web app, not opening the HTML
directly with `file:`. Saves/cache belong to this browser profile and origin;
clearing site data removes them and browser eviction is possible. They are not
encrypted backups. After changing a build, clear this origin's site cache to
refresh the offline shell (export/reimport your original tile as needed).

## Reproducible checks

From the repository root:

```powershell
$env:CARGO_TARGET_DIR = Join-Path (Get-Location) 'target-web'
Push-Location .\client
cargo fmt -p flats-racer-web -- --check
cargo test --release -j 2 -p flats-racer-web -p flats-racer-physics
cargo clippy --release -j 2 -p flats-racer-web --target wasm32-unknown-unknown -- -D warnings
Pop-Location
Push-Location .\browser
npm ci --no-audit --no-fund
$env:ADT_FILE = '..\runtime\browser\Kalimdor_39_43.adt'
npm test
$env:ROUTE_PACK = '..\runtime\browser\coast-route'
npm run test:route
Pop-Location
```

Leave the local server running for `npm test`. Playwright uses the installed
Microsoft Edge (`channel: msedge`), not a separately downloaded browser.
Set `HEADED=1` if this host disallows WebGPU in headless mode. Missing GPU
support is an explicit failure, not a fallback to a fake renderer.

The smoke test starts in a fresh browser context, proves both terrain and racer
pixels in the middle of the canvas, drives using real keyboard events, checks
displacement/steering/boost/braking/hopping, reloads parked saves offline, and verifies
invalid ADT import leaves the current simulation usable. With `ADT_FILE` it
repeats those checks for the imported terrain. Without it, the report explicitly
marks imported terrain untested. Evidence and private screenshots stay in ignored
`browser\test-results\<tile-name>` (or `synthetic`). Unit tests cover boundary
holds and atomic validation.

The route test drives both directions with actual Edge keyboard input, checks
land/water rendering, offline saves on both coasts and either side of both
region boundaries, sea-level continuity, tile eviction, a missing-tile hold,
and a billion-yard translated placement with real worker/GPU origin rebasing.
It also checks unsupported-save recovery and preservation of the old v1 save.
Its private evidence/screenshots are under `browser\test-results\route`.

## Deliberate boundary

The lab is one tile; route mode streams only the explicitly listed corridor,
not whole continents. Collision is conservative terrain/liquid support:
outside-pack edges, unsupported holes, impassable chunks and abrupt rises hold
the hovercraft. It is not the native swept Avian collider. No WMO/M2 buildings,
props, textured materials, sky system, mount model, audio, Lua or native HUD
are ported. The water shader is simple opaque procedural shading over the
support plane, not a wave simulation. A camera can intersect steep terrain.

**Embedded simulation achieved:** existing Rust hover-racer dynamics running
locally in Wasm. **Not achieved:** C++ VMaNGOS in Wasm, packet-queue transport,
account/login replacement, world-database packaging, characters, NPC AI, combat,
quests or singleplayer RPG saves. Those require a separate server/runtime port;
this client-side racer does not demonstrate them. No native platform behavior
or server configuration is changed.
