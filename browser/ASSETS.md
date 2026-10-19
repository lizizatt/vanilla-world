# Browser-local Data archive source

`asset-source.js` reads the player's own WoW 1.12 Data directory directly in a module
worker. It does not request game bytes from a server, copy archives into IndexedDB,
pre-extract files, or load entire archives into Wasm. No game assets are shipped.

## Worker contract

```js
import { openDataSource } from './asset-source.js';

// input: structured-cloned FileSystemDirectoryHandle OR [{ path, file }]
const source = await openDataSource(input);
const bytes = await source.read('World\\Maps\\Kalimdor\\Kalimdor_39_43.adt');
// source.readFile(path) is the same method.
const identity = source.fingerprint;
await source.close();
```

Catalog `path` is relative to Data. The common selected-root prefix from a
`webkitdirectory` input's `file.webkitRelativePath` is also accepted. Subdirectories
do not mount. `catalogDataFolder(handle)` produces a Data-relative catalog.
`source.archives` lists mounted archive names in ascending priority.
`source.stats` reports index bytes, cumulative read bytes/calls, maximum read size,
and peak read-window bytes; these are diagnostics, not a progress denominator.

Paths use ASCII case folding and either slash, matching native Storm hashes.
The source returns independent `Uint8Array` bytes for any internal asset path
(WDT/WDL/ADT/M2/WMO/BLP/DBC included); it does not parse asset formats.

`AssetError.code === 'NOT_FOUND'` means an authoritative miss or delete marker.
Never catch every rejection as missing: `CORRUPT`, `UNSUPPORTED`, `LIMIT`, `IO`,
`PERMISSION`, `INVALID_PATH`, `INVALID_FOLDER`, and `CLOSED` describe real failures.
A corrupt or unsupported winning patch never falls back to old base data.
The chain uses the native `benilla-formats::Chain` mount order: dbc, speech,
fonts, interface, misc, sound, wmo, terrain, texture, model, patch, case-folded
`patch-?.MPQ` (exactly one character), then speech2. Base/backup/patch-10 MPQs
are not mounted. Native vanilla hash lookup picks the first matching hash;
expansion locale subdirectories are intentionally not treated as vanilla archives.

Reads are serialized across callers to bound simultaneous decode allocations.
There is no decoded-asset cache. Discard stale results at the caller's world
generation boundary; cancellation of an individual read is not exposed.
`close()` rejects queued/new reads and releases indexes after an active read ends.

Sector extraction checks a 4 ms work budget and yields to a browser task between
sectors. Merely awaiting already-resolved promises can starve queued physics
messages even while the main thread keeps rendering. The active archive read
remains serialized across these yields; extraction bytes, validation and memory
bounds do not change. This is cooperative scheduling, not a hard deadline for an
individual sector decode or a guarantee against all streaming pauses.

The fingerprint is SHA-256 of ordered archive names, sizes, and last-modified
timestamps. It matches handle and file-input routes to the same install, but is
not a cryptographic content identity: files modified while preserving size and
timestamp cannot be detected by this metadata-only check.

## Folder permission and persistence

`asset-folder.js` exports:

- `rememberDataFolder(handle)`, `restoreDataFolder()`, `forgetDataFolder()`:
  persist only the directory handle in a separate IndexedDB database.
- `authorizeDataFolder(handle, { request: false })`: query read permission,
  returning a boolean without prompting.
- `authorizeDataFolder(handle, { request: true })`: query/request read permission;
  call directly from a main-thread user-gesture button. A denial returns false;
  an API failure throws `AssetError` with code `PERMISSION`.

The UI owns `showDirectoryPicker({ mode: 'read' })` and must invoke it from a user
gesture. On reload restore the handle, query permission, and show a reauthorize
button if needed. Pass an authorized handle to the worker. A file-input fallback
passes a cloned catalog and requires reselection on reload; never persist that
catalog or its archive Files. Storage failures throw code `STORAGE`.

## Bounds and archive support

Storm crypto/hash and index traversal follow the repository's `benilla-mpq`
implementation. Zlib uses the browser's native `DecompressionStream('deflate')`,
not a new codec dependency. Packed input enters it in 1 KiB chunks, output is
checked against the declared length, and both overflow and short/corrupt streams
fail explicitly. Synthetic tests additionally cover encrypted sector tables,
per-sector keys, adjusted file keys, stored files, and single-unit files.

Limits exported as `ASSET_LIMITS`: 64 MiB per extracted/packed file, 64 MiB per
archive's combined indexes, 128 MiB total indexes, 1 MiB maximum File.slice read,
1 MiB sector/read window, and 1 MiB header search. There is only one active read
window, cleared after extraction. Output and temporary buffers are bounded by
those limits; callers must also cap how many returned assets they retain.

Within that single extraction, up to **two** independent sector inflaters
overlap. Their combined declared output is capped at the existing 1 MiB sector
budget (large sectors reduce concurrency to one). Packed reads and encryption
remain ordered through the single read window; decoded sectors write to their
original output offsets. Every started inflater is drained before an error,
deferral or next full asset. Required work still preempts optional extraction
between bounded batches. Single-unit files retain their existing path.
`decodePeak` / `decodePeakBytes` expose observed concurrency; `inflateMs` sums
overlapping operation durations and is **not** elapsed wall time or CPU time.

Supports MPQ v0 and v1 with ordinary block offsets, zlib-compressed and stored
sectors, encryption, delete markers, and single-unit storage. CRC-table gaps are
skipped as in native `Archive`; optional sector CRCs are not checked separately
from zlib checksums. PKWARE, Huffman, ADPCM, bzip2/combined codec masks,
incremental PTCH files, extended block-offset tables, and newer MPQ versions
throw `UNSUPPORTED`, rather than returning placeholder data.

## Validation

```powershell
node browser\asset-source.test.mjs
$env:CARGO_TARGET_DIR = Join-Path (Get-Location) 'client\target\assets'
cargo build --manifest-path client\Cargo.toml -p benilla-formats --bin mpqx
$env:WOW_DATA = 'C:\path\to\your\Data'
$env:MPQX = Join-Path $env:CARGO_TARGET_DIR 'debug\mpqx.exe'
node browser\asset-smoke.mjs
# Also sample six geographically spaced WDT-backed ADTs on each map, then actual
# placed models, WMO roots/first+last groups, and terrain/WMO textures:
$env:ASSET_BROAD = '1'
node browser\asset-smoke.mjs
# Developer-only read-only census of every mounted block and sector method:
python browser\asset-codec-census.py $env:WOW_DATA
```

The smoke test requires the browser project's existing Playwright dependency
and installed Edge. It compares native `Chain`/`mpqx` bytes against the JS reader,
then SHA-256/lengths against actual Edge module-worker extraction using
directory-backed Files for both continents' WDT/WDL, the raceway ADT, Map.dbc,
and discovered patched M2/WMO/BLP entries. Temporary native outputs are removed.
The test HTTP server serves only test code, never install data.

On the authorized 1.12 install, all nine comparisons passed in Edge 155:
13,089,776 bytes of indexes and maximum 1,048,576-byte archive reads.
Handle serialization/persistence is exercised with an OPFS directory.
Native `showDirectoryPicker`'s trusted OS dialog and externally revoked folder
permissions are not automated; the UI must retain explicit reselection and
reauthorization paths.

The broad run compared 77 assets / 22,878,641 decoded bytes: 13 geographically
spaced ADTs across both maps, 13 M2s, 6 WMO roots and 10 groups, 30 BLPs, and the
two maps' WDT/WDL plus Map.dbc. Actual ADT placements select scene references;
reads resolve across base model/texture/WMO archives and both patch levels.
All matched native bytes and Edge worker hashes. Index/window bounds were
unchanged; cumulative reads were 106,413,448 bytes in 127 slices.

The separate native census inspected all 97,087 block entries in the authorized
install's 12 mounted archives, including every compressed sector method byte:
2,389,542 zlib `0x02` sectors, 3,929 stored sectors, 200 stored blocks, and 5,708
tombstone/empty blocks. Flags were `0x80000200`, `0x84000200` (sector CRC),
`0x80000000`, and `0x82000000` only: no encrypted, single-unit, IMPLODE, or
unsupported compression variant was present. This establishes codec coverage
for that install, not byte-for-byte validation of every payload or every
different player's installation. The census uses read-only native memory mapping
for inspection; this is not used by the browser source.
