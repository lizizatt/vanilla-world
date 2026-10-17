# Vanilla World

A source monorepo containing two independent projects:

| Directory | Component | Upstream | Branch | Imported commit |
| --- | --- | --- | --- | --- |
| `client/` | Benilla, a Rust/Bevy World of Warcraft 1.12.1 client | [samwhosung/benilla](https://github.com/samwhosung/benilla) | `main` | `b220d6a41c9a79389d2c7a7bd6f560052489019f` |
| `server/` | VMaNGOS, a vanilla World of Warcraft server emulator | [vmangos/core](https://github.com/vmangos/core) | `development` | `53d24d5c748bef5e0cde7b1155bcb3d979af614c` |

These are unchanged upstream source snapshots, imported with squashed Git
subtrees. **This is not yet a single binary.** There is no combined launcher
or one-click bundled client/server packaging. The root scripts provide a
Windows-only, source-build local server bootstrap; the client remains separate.

## Building and running

For the isolated local **browser racer experiment**, see
[browser/README.md](browser/README.md). It reuses Rust racer physics and terrain
formats in Wasm with an alternate WebGPU renderer; it is **not** a Bevy/VMaNGOS
port or a completed singleplayer RPG.

Run component commands from their own directories, not the monorepo root.
See the [Benilla README](client/README.md),
[Benilla contribution/build guide](client/docs/CONTRIBUTING.md),
[VMaNGOS README](server/README.md), and [VMaNGOS wiki](https://github.com/vmangos/wiki)
for their authoritative instructions.

- **Client:** the imported `rust-toolchain.toml` pins Rust **1.98.1**.
  Building also needs a C compiler (MSVC build tools and Windows SDK on Windows)
  for Lua and the platform dependencies described upstream. Rust dependencies
  must be available locally or downloaded by Cargo. Use `cd client` before
  Cargo commands so its toolchain and `.cargo` configuration apply.
- **Server:** CMake and a C++14-capable toolchain (for example Visual Studio 2022
  C++ tools on Windows). Windows dependency libraries are provided upstream in
  `server/dep/windows`; Unix builds need MySQL client, OpenSSL, and zlib
  development libraries. Enabling the mail sender also requires libcurl.
  Use the ignored source copy described below: upstream's Windows CMake writes
  generated files into its source directory even with an out-of-source build.
  Follow upstream database initialization and runtime setup;
  a running server also needs MySQL, the appropriate world database, and
  locally extracted client data.

### Local Windows server

Run these commands in Windows PowerShell from this repository. Install Git,
Visual Studio **2022 C++ x64 Build Tools**, a Windows SDK, and
[7-Zip](https://www.7-zip.org/) first. Nothing is installed as a Windows service;
the scripts do not change global PATH, firewall rules, or existing databases.

```powershell
.\scripts\Setup-LocalServer.ps1 -Step Tools
.\scripts\Setup-LocalServer.ps1 -Step Build
.\scripts\Setup-LocalServer.ps1 -Step Database
.\scripts\Setup-LocalServer.ps1 -Step Extract -GameDirectory 'C:\path\to\your\1.12.1'
.\scripts\Start-LocalServer.ps1 -CreateProbeAccount
```

The game directory is the **parent of `Data`**. Extraction reads the original
MPQs without copying or modifying them and writes derived maps, DBCs, vmaps,
and mmaps only under ignored `runtime\data`. All game data, including generated
data, remains private and must never be committed or redistributed. The older
extractor has 128-byte path buffers: keep game and checkout paths short.
Allow several GB of free disk space and potentially hours for full movement
map generation. Normal startup requires completion. For an earlier **login-only
test**, after maps/DBCs and VMap assembly finish, use a second PowerShell:

```powershell
.\scripts\Start-LocalServer.ps1 -DisablePathfinding -CreateProbeAccount
```

This explicitly sets upstream's supported `mmap.enabled = 0` in a private active
config, prints a warning, and leaves full movement-map generation running.
It neither fabricates extraction-completion markers nor skips the server's
required map/VMap/DBC checks. Creature navigation is degraded: **do not use this
mode for normal gameplay**. Once extraction completes, stop and restart without
`-DisablePathfinding` (and without `-CreateProbeAccount` if already created).
See upstream's [map/pathfinding configuration](https://github.com/vmangos/wiki/blob/master/docs/Maps-and-Pathfinding.md).
Custom game patches are not guaranteed to match build 5875.

`Tools` downloads checksum-pinned portable [CMake 3.31.12](https://github.com/Kitware/CMake/releases/tag/v3.31.12)
(46,666,397 bytes) and [MariaDB 10.11.15](https://archive.mariadb.org/mariadb-10.11.15/winx64-packages/)
(93,255,302 bytes). `Database` downloads the upstream CI's
[14 June 2021 base world dump](https://github.com/brotalnia/database)
(16,898,241 compressed bytes), then imports the committed core schemas and
all sorted migrations. It does **not** use the moving `db_latest` release.
URLs and SHA-256 values are recorded in the setup script. MariaDB is a
compatibility choice, not upstream's documented MySQL 5.6 CI configuration.
Windows MySQL/OpenSSL/zlib build libraries come from the pinned source tree;
mail sending is disabled, avoiding a separate libcurl download.

`Build` exports **committed** `server/` into `runtime\source`, records its Git
tree ID in `runtime\source-tree.txt`, and installs Release executables and
matching extractors into `runtime\server`. It never builds in either imported
tree. To rebuild after a subtree update, stop the server, back up the database,
and move `runtime\source`, `runtime\build`, and `runtime\source-tree.txt` aside.
Database/extraction setup refuses to overwrite completed state; schema upgrades
and re-extraction after upstream changes require deliberate backup/migration,
not a rerun of the fresh-install database step.

The foreground start script supervises dedicated processes and waits for
world startup plus owned loopback listeners: auth **127.0.0.1:3724**, world
**127.0.0.1:8085**, MariaDB **127.0.0.1:3307**. Keep it running; Ctrl+C requests
world shutdown and stops its owned processes. Inspect `runtime\logs` for
errors. From a second PowerShell in this checkout, request the same graceful
stop with `New-Item runtime\stop-request.txt -ItemType File -Force`.
Warden remains off; remote administration and SOAP remain disabled.
Random DB credentials/configs are private under `runtime` (Windows ACL limited
to the current user). The server has data read/write privileges on its four
schemas and table-scoped `DROP` on `characters.game_event_status`, required by
upstream's restart-time `TRUNCATE`. Other schema-changing GM tools are not
enabled by these grants. `-CreateProbeAccount` creates the non-admin `LOCALPROBE`
account once and saves its credentials to private `runtime\probe.json`; omit
that switch on later starts. Never paste that file into a commit, issue, or log.
No characters, privileged account, or automated gameplay are created.

Point a separately built Benilla at your existing `Data` directory using
`WOW_DATA`, and at `127.0.0.1:3724` using `WOW_HOST`. Read upstream's account
guard and unattended-run guidance before scripted login. This bootstrap is
not a packaged launcher and does not promise end-to-end client compatibility.

The initial Windows bootstrap was verified with a VS 2022 Release source build,
MariaDB 10.11.15, all 1,165 SQL migrations, and loopback auth/world startup.
A separately built Benilla (`b7bc7a7e`, not a build of the imported client
revision) authenticated and reached an empty character roster. This was a
limited-pathfinding login test, not gameplay or full movement-map validation.
The binaries target this host CPU by default; portable redistribution needs a
separate build/configuration and dependency-license review.

## Game data and local state

**User game data is not included and must never be committed.** Supply your own
legally obtained English 1.12.1 installation (build 5875); keep it and extracted
data outside the source trees (or in the ignored local `runtime` directory).
Point Benilla's `WOW_DATA` environment variable at
that external `Data` directory. Do not copy MPQs, DBCs, maps, vmaps, mmaps, or
other proprietary assets into either source tree.

Keep credentials, account/character databases, database dumps, logs, and runtime
installations outside the checkout or under ignored `runtime`. The root `.gitignore` provides common
guardrails, not a complete data-loss prevention mechanism: always review staged
files, and never force-add game data or secrets.

## Tracking and updating upstream sources

Each squashed import records its exact upstream SHA in the commit's
`git-subtree-dir` and `git-subtree-split` trailers. The table above is the
human-readable revision record. No upstream remote configuration is required.

From a clean monorepo checkout, update one component at a time:

```powershell
git subtree pull --prefix=client https://github.com/samwhosung/benilla.git main --squash
git subtree pull --prefix=server https://github.com/vmangos/core.git development --squash
```

After each update, read its new `git-subtree-split` trailer with
`git log --all --format=full`, update the corresponding SHA in this README,
and commit the documentation. Do not edit files inside the imported trees;
changes belong upstream and should arrive here through a new import.

To verify an import against its recorded upstream commit, fetch that commit
without adding a remote and compare the printed tree IDs (each pair must match):

```powershell
git fetch --no-tags --depth=1 https://github.com/samwhosung/benilla.git <client-sha>
git rev-parse HEAD:client 'FETCH_HEAD^{tree}'
git fetch --no-tags --depth=1 https://github.com/vmangos/core.git <server-sha>
git rev-parse HEAD:server 'FETCH_HEAD^{tree}'
```

The nested upstream `.github` workflows are preserved as source; they are not
installed as root-level GitHub Actions workflows for this monorepo.

## Licenses and notices

The components retain their separate licenses; this repository does not
relicense them. Benilla's own code is dual-licensed under
[MIT](client/LICENSE-MIT) or [Apache-2.0](client/LICENSE-APACHE).
VMaNGOS is [GPL-2.0-or-later](server/LICENSE).
Vendored dependencies keep their own licenses and notices in their original
locations, including `client/third_party` and `server/dep`. Preserve those
notices when redistributing.
