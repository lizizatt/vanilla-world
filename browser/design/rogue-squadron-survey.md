# Star Wars: Rogue Squadron 3D (1998 PC) data and flight-dynamics survey

Research spike, text only. No game art, audio or data is committed; local copies live in the git-ignored
`browser/rogue-data/` (`/browser/rogue-data/` in `.gitignore`, verified with `git check-ignore`).
Source install (read-only): `C:\Program Files (x86)\Steam\steamapps\common\RogueSquadron`.

## Local layout (untracked)

| Path | What |
|---|---|
| `browser/rogue-data/ROGUE/` | copy of the install's `ROGUE` folder: `Rogue Squadron.EXE` (2.9 MB, v1.3), `ROGUE.EXE` (launcher), `IFORCE2.DLL`, `DATA/OUT/DATA.DAT` (31.7 MB) + `DATA.HDR` (96 B), `DATA/BUNDLE.000/001`, `BUNDLE.000-003` (installer archives, magic `BUND`/`BNHD`) |
| `browser/rogue-data/Manual.pdf` | 25 pages, image-only (no extractable text) |
| `browser/rogue-data/rs-mem.bin` | unpacked 4.6 MB in-memory image of the exe (see "Unpacking") |

Tools (scripts only) are in `browser/rogue/`: `dump-exe.py` (unpack), `xrefs.py` (source-path/string xrefs, disassembly),
`lift.py` (x87-folding pseudo-decompiler), `craft-constants.py` (per-craft constant extraction).
Requires `pip install pefile capstone`. Ghidra 12 was not usable (Java 1.8 here).

## Unpacking

Both exes carry an old Steam stub (`.bind`); `.text` is encrypted on disk (entropy 8.0). Running a copy exits with code 53
and relaunches the launcher, so the user's "works but shows a launcher" is the stub, not a bug. What works: launch the
original `Rogue Squadron.EXE` with `SteamAppId=SteamGameId=455910`, wait about 12 s, `ReadProcessMemory` the image, kill.
Decrypted `.text` has entropy 6.4 and disassembles cleanly (non-optimised MSVC, stack locals, x87 floats).
Side effect to note: the original install gained `ROGUE\PlayerProfiles\highscores.dat` from that run. Nothing else was modified.

## Data format

* `DATA.HDR`: 3 x 32-byte entries (`data`, `dbg_data`, `data2`) each with a trailing size dword.
* `DATA.DAT`: a single memory-image style object database (first dwords 31547520, 28512, 0, 0, 1, 1236; then names such as
  `test4`, `TopLevel`, `mat_0`) with relative offsets and float data. Not yet decoded; this is NOT the SWE1R block/`comp`
  format. The exe's `data.c` loads `data\out\data.hdr`, `data.dat`, `lngm.dat`.
* 343,757 printable strings were extracted; asset-name families include `*_hi` LOD/texture names (`b_sc2_hi`, `v_spd_hi`,
  `i_spd_hi`), `sky_horizon`, `Jt_ATST_*`, `AT_PT_03`, `Train_Engine`, `Generator_Tie_01`, `Spline_*` (paths),
  `Wingman_02`, `player_StartPosition`, `COMBAT_SPLINE`, `MUSICRNG_LevelSettings`.
  So meshes, per-level object placements, spline paths and music ranges are all in there; decoding status is "present, undecoded".
* `DATA\BUNDLE.001` (20 MB) is probably the installer-compressed copy of the data. Audio was not located separately.
* Debug asserts in the exe reveal the original source tree (`D:\Scoundrel\Code\RoguePC\src\...`), useful as a function map.

## Vehicle inventory

Player craft (source `craft\*.c`, resources `pl_crafts/*`, cockpit `ov/ov_*`):

| Craft | Source | Notes |
|---|---|---|
| A-wing | `awing.c` | |
| X-wing | `xwing.c` | special action X/V/Y-wing only |
| Y-wing | `ywing.c` | |
| V-wing / Snowspeeder | `vwing.c`, `speeder.c` | "Speeder" has left/right brakes; `snowspeeder` resource |
| Millennium Falcon | `falcon.c` | |
| TIE Interceptor | `interceptor.c` | unlockable |
| Naboo starfighter | `naboo.c` | added in v1.3 |
| T-16 (Skyhopper, tentative) | `t16.c` | |
| Tow cable | `towcable.c` | snowspeeder tow mechanic |

Enemy/world objects (source `Objects\*.c`): AT-AT, AT-ST, AT-PT, tank droid, probe droid, TIE fighter / bomber / interceptor,
attack craft, shuttle, yachts, train, convoy, World Devastator, gun turrets, radar dish, power generator, shield,
stormtroopers, wingmen, generic vehicle/destroyable. There are no speeder bikes.
Models: all names above have mesh/texture strings in `DATA.DAT`; recoverability depends on the still-undecoded container.
Hull/weapon/damage tables were not extracted: only the player flight constants below were. Hull starts at 75 in the craft
struct (offset +0xc0/c4, 42 with flag 0x40), tentative.

## Flight dynamics

Structure: eight per-craft init blocks write tunables into a 0x2a0-byte craft struct; per-craft update functions manage the
throttle and then call one shared flight model (`0x40ecce`, 8.7 KB, a 9-craft shared function).

Pipeline:
1. Read stick axes (`0x706920/24`); dead-zone 0.1 (`v -= sign*dz`), then square keeping sign for finer control; AI/special
   types scale by 0.85; Y inversion option.
2. Axes -> angular rates: `rate = axis * pitch_gain (+0xf8) * limit (+0x110/0x114/0x118)` for pitch; roll/yaw use
   `roll_gain (+0xfc)`. Smoothed through factors at +0x164/+0x168/+0x174 (0.08-0.1, 0.32-0.5).
3. Bank angle is derived from yaw input and clamped to a limit (+0x120 = 60-65 deg, +0x124 = 180) with 0.5x damping
   when braking and 1.5x roll boost when the special/brake button (0x10) is held; return-to-level when input is neutral
   (+0x13c/+0x14c are eased back to zero by +0x140/+0x150 steps).
4. Throttle: target speed stepped by 0.09375 (boost) / 0.375 (brake) per frame, clamped to `[min, max]`; current speed
   approaches target by accel/decel.
5. Velocity = forward vector x speed, integrated with `dt`; terrain and objects handled by a ray/sweep helper (`0x568b00` etc.)
   and altitude clamping. Banking/auto-level, ground following and collision response branches were only partially read;
   treat steps 3-5 as characterised, not exact.

Tunables (units per frame; world scale not yet established). Mapping to craft names by source-file address order, so the
non-awing rows are tentative:

| Init | Craft (tentative) | speed | accel | decel | pitch | roll | min/cruise/max-style args |
|---|---|---|---|---|---|---|---|
| 0x40bbc0 | A-wing | 3.0 | 0.047 | 0.031 | 1.6 | 1.8 | 2.25 / 3.0 / 5.625 |
| 0x416690 | Falcon | 3.0 | 0.0625 | 0.031 | 1.3 | 2.0 | 2.25 / 3.0 / 5.625 |
| 0x417d30 | Interceptor | 3.375 | 0.15 | 0.075 | 1.6 | 2.0 | 2.25 / 3.375 / 4.5 |
| 0x418d00 | Naboo | 3.0 | 0.10 | 0.10 | 1.6 | 3.0 | 1.69 / 3.0 / 6.0 |
| 0x41c780 | T-16/speeder | 3.0 | 0.20 | 0.10 | 1.8 | 2.0 | 1.875 / 3.0 / 6.0 |
| 0x41f990 | V-wing | 3.0 | 0.15 | 0.333 | 1.6 | 1.5 | 2.25 / 3.0 / 4.5 |
| 0x42445a | X-wing | 2.625 | 0.0625 | 0.0625 | 1.6 | 1.75 | 2.25 / 2.625 / 3.75 |
| 0x425a80 | Y-wing | 2.25 | 0.025 | 0.1125 | 1.3 | 2.0 | 1.69 / 2.25 / 3.375 |

Shared across crafts: +0x104=15, +0x108=10, +0x118=40, +0x120=60 (65 A-wing), +0x124=180, dead-zones 0.1, +0x130=0.75,
+0x134=2, +0x138=20, +0x140=10, +0x144=60, +0x148=10, +0x150=5; pitch limits -30..-40 and -38..-45.
The model is arcade: rates are direct stick-times-gain, speed is a single scalar along the nose, no mass/drag/lift.

## Comparison with this project

`pod-attitude.js` integrates yaw/pitch from mouse/stick into a quaternion with bounded slew (`POD_TURN`: rate pi rad/s,
ease 8) and no roll; `pod-driver.js` hands thrust, boost/brake and gravity to the wasm world (`pod_sweep` collision,
inverse-square gravity). Rogue is far simpler: stick -> rate with dead-zone/square shaping, bank derived from yaw,
scalar speed with accel/decel and fixed min/cruise/max (boost/brake as steps), no gravity. A Rogue-style "arcade flight"
mode is a small module (about 150 lines) next to `movePodAim`; the dead-zone-square-gain-smooth chain and bank-from-yaw
are the pieces worth borrowing.

## Reuse of existing SWE1R tooling (`browser/swe1r/`)

* Not reusable: `block.js`/`comp.js`/`model.js` are tied to SWE1R's `out_modelblock.bin` table and compression.
* Reusable patterns: `png.js`/`image.js` (PNG encoding once textures are decoded), `folder.js`/`cache.js`
  (user-selected local directory + IndexedDB cache), `names.js` structure, and the `SWE1R_DATA` runtime-load convention.

## Feasibility verdict

Flight constants: done enough to implement now. Assets: feasible but not yet proven. A runtime loader (user supplies their own
`DATA.DAT`, like `SWE1R_DATA`; nothing committed) is plausible because the format is a flat relative-offset image, but it needs a
`DATA.DAT` decoder first. Legal posture is the same as SWE1R: parse only user-supplied files in the browser.

## Next steps

1. Decode `DATA.DAT`: find the entry table via `DATA.HDR` sizes and `TopLevel`/`mat_*` records; identify mesh, texture
   and spline chunk types (use the exe's loader functions near `data.c` as reference).
2. Establish world scale (units/frame at 30 fps?) and verify the craft-name to init mapping at runtime.
3. Finish reading the shared flight function (bank/auto-level, ground following, collision) and the object init tables for hull/weapons.
4. Export one craft mesh (X-wing) to glTF in a local-only script; load in the browser via a `ROGUE_DATA` folder picker.
5. Add an arcade flight controller using the constants above.

## DAT decoder and Falcon test render (phase 2)

- `browser/rogue/dat.js` is a minimal decoder: `readDirectory` scans DATA.DAT for 32-byte entries (u32 offset, u32 size, -1, 2, char[16] name; several scattered runs) and `parseHob` decodes HOB models.
- HOB: 5 nodes for the Falcon (0x84 bytes each), mesh records (0x60), i16 x/y/z/pad vertices at 1/256 units, packet lists (tag>>24 = dwords, bit0 quad, bit1 normal indices, u16 index pairs, per-vertex colours, optional 4.12 UVs). Vertices are already model-space; node translations are pivots only.
- `node browser/rogue/render.mjs <DATA.DAT> falcon_HOB out.png` renders four views (530 tris for the Falcon, 504 for the X-wing); both look correct. Vertex colours only; HMT (materials/textures) is still undecoded.
- Feasibility: loading HOB models at runtime from the user's local files is straightforward, in the SWE1R_DATA pattern. Next: decode HMT textures, then wire into a viewer.


### HMT materials and textures (decoded)

- `parseHmt` in `browser/rogue/dat.js`: u32 material count, u32 texture-table offset. Materials are 36 B (u16 kind 1=textured/2=flat, u16 texture index, floats 0.8/1.0/0, u32 10, char name[16]); a packet's material index selects one. Texture table: u32 count, then 0x34 B records (+0x00 pixel offset, +0x24 header offset, +0x28 u16 w,h, +0x2c flags). Flag byte 2 = 4 means 4-bit greyscale (high nibble first), 3 means 32-bit RGBA (engine glow). Pixels follow a 16 B header that starts with the name.
- Falcon: 29 materials, 23 textures. Rendering with texture x vertex colour (`render.mjs`) gives a recognisable textured Falcon, so the 'HMT undecoded' item above is resolved. Still open: UV wrap/mirroring flags, palette-less transparency, other craft's HMT variants.


### Whole-archive decode (phase 3)

- **Segments:** `DATA.HDR` is 32-byte records (char name[28], u32 base) = `data` 0, `dbg_data` 0x1e1cfe0, and a third at 0x1e1d730. Directory entry offsets are relative to the segment that holds the directory run, so `readDirectory(buf, readSegments(hdr))` is required to resolve the second-segment `koelsch` (the Koellsch/Rebel prototype craft) and `c_kolsch` assets.
- **Coverage:** 533 directory entries; every `*_HOB` (about 130 models) and `*_HMT` decodes, and the test asserts in-range vertex/normal indices for all of them. `opkg2_*` are empty 8-12 byte stubs. The rest of the archive is music (`*_SNG` MIDI-like songs, `*_SND`), UI/fonts/images, `*_DEM` demo data, `*_ANM`/`*_walk` animations, `tl_clouds`, and `weapon_info` / `medal_info` tables (not decoded).
- **Vehicles with models (HOB+HMT):** flying: `xwing`, `awing`, `ywing`, `vwing`, `falcon`, `snowspeeder`, `koelsch`, `t16` (skyhopper), `tiefighter`, `tiebomber`, `tieinter`, `tie_d`, `rmobil`, `shuttle`/`hvyshut`/`bosshut`, `raptor`, `cloudcar`, `assboat`, `wskimmer`; ground: `atst` (+ `_hi`), `atat` (+ `_lo`), `tankdroid`, `train`, `r_transp`/`r_combat`/`r_train`, many turrets (`gun_turret`, `mis_turret`, `megaturret`, `g5turret`, `dsturret`, `tal_turret`, `r_turret`), `pwrgen`, `radardish`, `lplatform`. `c_*` are cockpit/low-LOD variants; `wm*` are weapon/mission-select previews. Skyboxes are `sky_*`.
- **Texture formats (flags at +0x2e/+0x2f):** 0/4 = 4-bit intensity, 1/5 = 8-bit intensity, 2 = 16-bit (rare, unverified), 3 = RGB24 or RGBA32 when flag bit 7 is set. Textures are intensity-only; colour comes from the per-vertex colours (the vertex-colour x texture modulation gives the right look).
- **Normals:** tag bit 1 marks a normal-index block, but sky/box packets fill it with 0xFFFF sentinels (no normals), so such indices are dropped. About 2% of packets (tags like 0x7148/0x5146) have lengths that do not match the simple size formula; they are walked by the length field so vertex indices stay valid.
- **Open items:** (1) articulated models (AT-ST, AT-AT legs/head) decode as separate parts at joint-local positions; the node record has no usable translation (+0x50 is zero), so the rest-pose assembly probably comes from the `*_walk`/`*_start` animation entries, which are undecoded. (2) UV wrap/clamp flags (TIE wing panels show striping). (3) Collision hulls (`c_*`) and the `weapon_info` table. (4) Level terrain is not in this archive, it is in the other ROGUE files.
- **Feasibility update:** all static vehicle models and textures can be loaded at runtime from the user's local `DATA.DAT`/`DATA.HDR` (SWE1R_DATA pattern) in about 250 lines of JS, with no committed assets. Articulated walkers need the animation format before they assemble.
