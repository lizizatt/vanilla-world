# Vanilla World

A source monorepo containing two independent projects:

| Directory | Component | Upstream | Branch | Imported commit |
| --- | --- | --- | --- | --- |
| `client/` | Benilla, a Rust/Bevy World of Warcraft 1.12.1 client | [samwhosung/benilla](https://github.com/samwhosung/benilla) | `main` | `b220d6a41c9a79389d2c7a7bd6f560052489019f` |
| `server/` | VMaNGOS, a vanilla World of Warcraft server emulator | [vmangos/core](https://github.com/vmangos/core) | `development` | `53d24d5c748bef5e0cde7b1155bcb3d979af614c` |

These are unchanged upstream source snapshots, imported with squashed Git
subtrees. **This is not yet a single binary.** There is no combined launcher,
one-click local-server packaging, or automatic database/server setup.
The components must currently be built and configured separately; importing
them together does not verify their runtime compatibility.

## Building and running

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
  Use an out-of-source build with an explicit installation directory **outside
  this checkout**. Follow upstream database initialization and runtime setup;
  a running server also needs MySQL, the appropriate world database, and
  locally extracted client data.

## Game data and local state

**User game data is not included and must never be committed.** Supply your own
legally obtained English 1.12.1 installation (build 5875); keep it and extracted
data outside this repository. Point Benilla's `WOW_DATA` environment variable at
that external `Data` directory. Do not copy MPQs, DBCs, maps, vmaps, mmaps, or
other proprietary assets into either source tree.

Keep credentials, account/character databases, database dumps, logs, and runtime
installations outside the checkout too. The root `.gitignore` provides common
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
