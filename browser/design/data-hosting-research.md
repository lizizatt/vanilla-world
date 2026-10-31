# Data hosting research: how Azeroth Survivors handles WoW data

> **Not legal advice.** This is an engineering research spike based on public web pages read on 2026-10-31. Nothing here was verified by downloading or inspecting any copyrighted asset. Consult a qualified IP lawyer before hosting any Blizzard-derived data.

## Summary

- **Azeroth Survivors** is a free fan-made Vampire-Survivors-like set in WoW 1.12 (Classic era), by a developer called **Aethus**. Official page: <https://wow.aethus.pl/> (WebGPU browser build, plus a Windows `.rar` download linked from that page; Discord <https://discord.gg/azerothsurvivors>). No Steam/store page, no payment required, optional "Buy me a coffee" link ([unofficial guide](https://azerothsurvivorsgame.com/)). Official source is **not public**.
- It runs on a from-scratch Rust/Bevy WoW client engine compiled to WebAssembly: [benilla](https://github.com/samwhosung/benilla) and its browser fork [wenilla](https://github.com/Arnesen/wenilla) are the public engine lineage, per the community rebuild's README ([OutThisLife/azeroth-survivors-re](https://github.com/OutThisLife/azeroth-survivors-re)). The official game's exact relationship to these is not stated by the author in anything I could read.
- **Two distinct postures exist:**
  1. **Community rebuild** (`azeroth-survivors-re`): ships *no* Blizzard content; reads a user-supplied 1.12.1 `Data` folder (its script can fetch the client from archive.org, which is the part with legal risk).
  2. **Official build** (Aethus): appears to *host and distribute* the game with its data itself (browser data served from the site; a ~755 MB Windows archive that self-updates by downloading "data patches"). Legal posture = disclaimer only ("fan game, not affiliated with Blizzard"). **I could not confirm exactly what Blizzard-derived data is inside or whether it is converted/transformed.** Treat "they host Blizzard-derived assets under a disclaimer and are tolerated so far" as the likely situation, not a verified one.
- **No C&D or takedown was found** in what I could search, but absence of evidence is weak: the game is days-to-weeks old in its viral phase (guide pages date its surge to Oct 2026).
- **Recommendation for Azeroth Racer:** keep the current user-supplied-data model. Do not host Blizzard-derived data. A "shared/hosted" option is only defensible if the *server hosts code only* and the *user's own data never leaves their device* (client-side parsing, on-device caches). Do not copy Azeroth Survivors' hosting approach.

## Evidence

### What the project is
| Claim | Source |
|---|---|
| Free fan-made WoW roguelike by Aethus, played at wow.aethus.pl, local/offline, no account | [azeroth-survivors-re README](https://github.com/OutThisLife/azeroth-survivors-re), [mirror README](https://github.com/myslithell/azeroth-survivors) |
| Built on a from-scratch Rust engine, runs in WebGPU browser or Windows download; "created by Aethus"; no Steam release | [azerothsurvivorsgame.com](https://azerothsurvivorsgame.com/), [download page](https://azerothsurvivorsgame.com/download/) |
| Official source not public; GitHub `azeroth-survivors-re` is an *unofficial* rebuild of an older version needing your own 1.12 client data | [download page FAQ](https://azerothsurvivorsgame.com/download/) |
| Announcement thread (r/wowservers) and Discord exist | linked from the README above (Reddit page could not be fetched; unread) |

### What data is shipped / hosted, and where
| Item | Finding | Source |
|---|---|---|
| Community rebuild repo | "ships **no Blizzard content** — no art, models, sounds, maps, MPQ contents, or FrameXML"; reads user's `Data` folder at runtime | [README, "The game data" section](https://github.com/OutThisLife/azeroth-survivors-re) |
| Community rebuild data acquisition | `scripts/fetch-data.sh` downloads the English 1.12.1 (5875) client (~5.5 GB) from **archive.org** and extracts MPQs locally; URL overridable. This offloads hosting to a third party but is *not* clearly licensed either. | [README](https://github.com/OutThisLife/azeroth-survivors-re), [archive item](https://archive.org/details/WoW_1.12.1-5875) |
| Engine lineage (benilla) | "no bundled game assets"; reads data from the user's own install; **no prebuilt downloads** | [benilla README](https://github.com/samwhosung/benilla) |
| Browser fork (wenilla) | MPQ chain becomes single files fetched over HTTP from a host that serves the operator's `Data` dir; `wenilla-host` is a loopback testing tool ("never on the open internet"); `wenilla-realm` puts it behind a login. Host "never sends the MPQs" (as whole archives) | [wenilla README](https://github.com/Arnesen/wenilla), [wenilla-realm README](https://github.com/Arnesen/wenilla/blob/main/crates/wenilla-realm/README.md) |
| Official Windows build | ~755 MB `.rar` from the author's site; on first launch it "downloads any missing **data patches**, replaces its exe and restarts" | [Windows mirror README](https://github.com/XXJones21/azeroth-survivors-windows-build), [macOS/Windows mirror](https://github.com/myslithell/azeroth-survivors) |
| Official browser build | Loads in a WebGPU browser with no install, implying assets are served from the author's host (CDN/origin not identified) | [wow.aethus.pl](https://wow.aethus.pl/) |
| Third-party mods | Co-op mod repo states it redistributes no game code/assets and loads alongside a copy the player owns | [azeroth-survivors-source](https://github.com/bymarvin/azeroth-survivors-source) |
| Community hygiene | Fan guide site says it "never host[s] game files" and links only to the developer | [azerothsurvivorsgame.com](https://azerothsurvivorsgame.com/) |

Unknown: whether the official data is raw Blizzard files, repacked/converted (e.g. re-encoded textures/models), partially procedural, or substituted. This cannot be settled without inspecting the shipped archive, which was deliberately not done.

### Legal posture observed
- Disclaimers everywhere: "free fan game, not affiliated with or endorsed by Blizzard"; WoW assets are Blizzard's property ([mirror README](https://github.com/myslithell/azeroth-survivors)).
- Free/non-commercial (optional donation link) ([guide](https://azerothsurvivorsgame.com/)).
- Community rebuild is explicit that screenshots show art © Blizzard rendered from a user-supplied client, code is MIT/Apache, and that the repo itself ships nothing ([README "Legal"](https://github.com/OutThisLife/azeroth-survivors-re)).
- No public license grant, permission, or statement from Blizzard found. No takedown/C&D history found in the pages I could read (Reddit and Discord were not accessible; search coverage is thin).

### Blizzard's published policies (relevant excerpts)
- [Blizzard Legal FAQ](https://www.blizzard.com/en-us/legal/c1ae32ac-7ff9-4ac3-a03b-fc04b8697010/blizzard-legal-faq) (old, generic, not WoW-specific):
  - Personal, non-commercial use license for downloaded content; "you will not alter, disassemble, decompile, reverse engineer or otherwise modify the Downloaded Content"; Blizzard may revoke at any time.
  - Total conversions OK "for personal use" and that do not infringe the EULA or others' rights.
  - Mirroring *unaltered patches/demos* non-commercially is allowed; that does not cover game data in general.
  - Emulating protocols / hosting servers without consent is prohibited (this is the vmangos/server side, relevant to benilla, not to Racer).
- [Blizzard EULA](https://www.blizzard.com/en-us/legal/fba4d00f-c7e4-4883-b8b9-1b4500a402ea/blizzard-end-user-license-agreement): licenses, not sells, the Games; use is restricted to the license terms. I only read the opening; the reverse-engineering and derivative-work clauses were not read in this pass.
- I did **not** locate a current, standalone Blizzard "Fan Content Policy" (the obvious URL 404s; the legal index lists the fan-art submission terms, video policy and custom-game AUP, none of which licenses redistributing game files). Open question below.
- [Blizzard copyright infringement notice page](https://www.blizzard.com/en-us/legal/0f4d7809-ac0c-453c-a28b-003d77aac798/copyright-infringement-notice) is the DMCA channel; any host of Blizzard-derived data is exposed to it.

## Comparison

| Dimension | Azeroth Survivors (official) | Azeroth Survivors (community rebuild) | **Azeroth Racer (ours)** |
|---|---|---|---|
| Engine code | Closed; lineage of open benilla/wenilla | MIT/Apache | Own code, `browser/` |
| Blizzard data hosted by project | Apparently **yes** (site + `.rar` + data patches); contents unverified | **No** in repo; fetch script pulls whole client from archive.org | **No** |
| Where data comes from at runtime | Author's hosting | User's `Data` (or downloaded from archive.org) | User's local WoW `Data` folder (file picker / handle in IndexedDB) ([clean-checkout.md](clean-checkout.md)) |
| Derived/converted data redistributed | Unknown | No | No (never committed or hosted) |
| Monetization | Free, optional tip jar | Free | Free |
| Disclaimer | Yes | Yes | Add one (see below) |
| Public permission from Blizzard | None found | None found | None |
| Takedown history | None found | None found | None |
| Relative exposure | **Highest** (hosts and distributes) | Medium (script points at a third-party full-client copy) | **Lowest** (user-supplied only) |

## Can we offer a hosted/shared option safely?

Ordered from safest to riskiest. Only the first two are recommended.

1. **Hosted code, user-supplied data (status quo, safe).** Host the static app (JS/WASM/shaders, our own procedural content). User points to their own install. Zero Blizzard bytes on our servers.
2. **Client-side conversion and on-device caches.** Parse MPQ/DBC/ADT/BLP/M2 in the browser; keep converted meshes/textures only in IndexedDB/OPFS on the user's device. Never upload them, never ship a "pre-baked" pack. Offering "export cache" or "share cache link" would cross the line into redistribution, so do not.
3. **Self-hosted per-operator server (wenilla-host style).** Each person runs a local/private server over their own `Data`. Acceptable for personal use, but a public instance serving files to others is redistribution; do not run a shared one.
4. **Our own public server of converted data (not recommended).** Same exposure as the official Azeroth Survivors host: copyright (art, audio, maps are Blizzard's), EULA reverse-engineering/derivative clauses, DMCA takedown of host/CDN and possible account termination. Converting formats is unlikely to change the copyright analysis, since the output is still a copy or derivative of Blizzard's work.
5. **Pointing users at third-party full-client mirrors (e.g. archive.org).** Shifts hosting but does not obviously make it lawful; also invites guessing at provenance. At most, document that users should use their own client; do not script a download.

Related guardrails for the doc/UI:
- A visible disclaimer: unofficial, not affiliated with Blizzard; WoW/Blizzard trademarks belong to Blizzard; no assets included.
- Keep *screenshots/videos* of WoW art out of the repo (the rebuild README itself notes screenshots are © Blizzard).
- Don't use "World of Warcraft" in the product/domain name in a confusing way (Blizzard's FAQ discourages WoW-containing domain names).
- Keep non-commercial; no donation interstitials gating features.
- Keep a takedown/contact path and be ready to comply quickly.
- Don't integrate with private servers via protocol emulation in the hosted product.

## Risk assessment (with uncertainty)

| Scenario | Likelihood of dispute | Impact | Confidence in this rating |
|---|---|---|---|
| Hosting code only, user data stays local (current) | Low | Low | Medium-High: no Blizzard bytes; trademark/name issues remain |
| Local conversion + on-device caches | Low | Low | Medium: depends on keeping caches private and uncopied |
| Hosting converted Blizzard-derived data publicly | Medium-High if popular, otherwise unknown | High (DMCA, host termination, possible legal letter) | Low-Medium: tolerance is discretionary and can change |
| Copying Azeroth Survivors' "it's tolerated" posture | Unknown | High | **Low**: their situation is unverified and survivorship-biased (they are small and brand-new) |

Why Azeroth Survivors' apparent safety is not a precedent: (a) no explicit permission was found; (b) tolerance by a rights holder can be revoked at any time (Blizzard's own FAQ reserves revocation); (c) the project is recent and its visibility is rising, which is when enforcement usually starts; (d) it is small and free, but unauthorised distribution of copyrighted works is infringement regardless of price; (e) we only know what they say publicly.

## Recommendation

1. Keep the **user-supplied-data-only** model as the product. Do not add any hosted Blizzard-derived data.
2. If we want less friction, invest in **client-side** conversion and **on-device** caching (OPFS/IndexedDB), including a clear "your data never leaves this device" statement and a "clear cache" control.
3. Add a README/footer disclaimer and keep the repo free of WoW/Racer art, audio and screenshots (already the rule).
4. Do **not** replicate the official game's hosted-data approach, and do not script downloads of a client from third-party mirrors.
5. If a shared/hosted experience becomes important, ask an IP lawyer and/or contact Blizzard for written permission first.

## Archive.org option (spike, OFF by default)

The owner decided to build this as an opt-in deploy option despite the recommendation above. The legal call and any enabling are theirs; this section only documents the lever. Shipping it with the flag on means the deployed site offers users a download of Blizzard content from a third-party mirror whose license status is unverified (the item's metadata carries no license; collection `open_source_software`).

**Lever:** `ARCHIVE_DATA_SOURCE=1`, set when starting the dev server (`ARCHIVE_DATA_SOURCE=1 node browser/server.mjs`) or building (`ARCHIVE_DATA_SOURCE=1 node browser/build-dist.mjs`). Anything else, or unset, is OFF. There is no runtime query parameter.

**Off (default):** `archive-ui.js`, `archive-source.js` and `archive-manifest.js` are not in the shell manifest, so they are not served, published or precached; `archive-flag.js` stays `false`; the CSP has no archive.org entry; the page has no extra button. Tests in `archive-source.test.mjs` assert this (including that no shipped file mentions archive.org).

**On:** the welcome screen gets "Or download Data from archive.org (optional)". It opens a notice (unofficial, not affiliated with Blizzard, you are responsible for having the right to use the content, files go from archive.org directly into this browser's own storage, nothing hosted/proxied by us) and requires a checkbox before "Download". Files go to OPFS (`wow-archive-data/`), the folder handle is passed to the existing loader exactly like a picked Data folder, and is remembered like one. "Delete downloaded data" clears it. The CSP gains `connect-src 'self' https://archive.org https://*.archive.org`. Optional audio (+~0.9 GB) is a checkbox; whether the app is fully usable without `sound.MPQ`/`speech.MPQ` is unverified.

**What archive.org offers (probed with metadata/HEAD/1-byte-range requests, item `WoW_1.12.1-5875`):**
- The item holds one zip per locale (~5.3-6.0 GB each, enUS 5,475,617,875 bytes, md5 published) and no loose files. No per-file hashes; only the whole-zip md5/sha1/crc32.
- `https://archive.org/metadata/<id>`: JSON, `Access-Control-Allow-Origin: *`.
- `https://archive.org/download/<id>/<zip>/` (zip listing page): HTML with member names and uncompressed sizes; CORS allowed (origin echoed).
- `https://archive.org/download/<id>/<zip>/<url-encoded inner path>`: 302 to `.../view_archive.php?archive=...&file=...`, CORS allowed (origin echoed, preflight 200), **but `Range` is ignored** (a ranged request returned 200 with the whole member, no `Content-Length`/`Accept-Ranges`). So only whole members can be fetched; no partial MPQ reads and no mid-file resume.
- The raw zip (`/download/<id>/<zip>`, redirects to a `dn*`/`ia*.archive.org` node): honors `Range` (206, `Content-Range`) **but the responses carry no `Access-Control-Allow-Origin`**, so a browser page cannot read it (and `OPTIONS` there returns 405/500). Reading the zip central directory and ranged members, which would give per-file CRC-32 and mid-file resume, is therefore impossible from the browser.

**Feasible:** browser downloads of whole members via the view_archive endpoint, streamed into OPFS with progress, cancel, and file-granular resume. Only the 10 MPQs the world needs (`dbc, fonts, interface, misc, model, terrain, texture, wmo, patch, patch-2`, ~4.5 GB) are fetched, skipping audio, `base`, `backup`, cinematics and docs; that saves ~1.1 GB of the ~5.5 GB zip, not more, because MPQs are the bulk and are not sliceable.
**Not feasible in the browser:** ranged per-file/per-block reads, resuming inside a 2 GB `patch.MPQ`, per-file hashes. **Integrity actually done:** HTTP length and received length must equal the size listed by archive.org and the size pinned in `archive-manifest.js`; the first bytes must be the MPQ magic; a file is committed to OPFS only after verification (no partial file visible). This catches truncation/drift/swaps but is not a cryptographic check.
**CLI variant** (node can read the raw zip): `ARCHIVE_DATA_SOURCE=1 node browser/tools/fetch-archive-data.mjs --out <folder> --yes [--audio] [--locale enUS]` reads the central directory by Range (ZIP64, stored and deflate), downloads members with `.part` resume, and verifies each member's zip CRC-32 and the pinned size, then you pick `<folder>` in the app. It refuses (exit 2, no network) without the flag. The whole-zip md5 is not checked (it would need the full 5.5 GB).

**Risks:** the legal exposure in the table above applies to the deployer, now with a first-party button that points users at a third-party copy; archive.org can change or remove the item, its listing HTML, its CORS policy or throttle heavy downloads; ~4.5 GB in browser storage can hit quota/eviction (storage is not persisted unless the browser grants it); the HTML listing parse is a scraper; locales other than enUS are only checked against their live listing.
**Unverified:** a full real download end to end (deliberately never done; everything was tested against a local mock that imitates the observed headers, including a mock raw zip), that the browser really lets a cross-origin redirect from `archive.org` to `view_archive.php` through with CSP/CORS as probed with curl, OPFS quota behaviour at 2 GB writes, app behaviour without the audio MPQs, and whether the 302 data node always matches `*.archive.org`.
## Open questions

- What exactly is in the official `AzerothSurvivorsWindowsNew.rar` and the browser asset bundle (raw MPQ-extracted files, converted formats, substitutes)? Not checked by design.
- Where is the official data hosted (own origin vs CDN vs GitHub releases)? Not determined.
- Has Blizzard contacted Aethus or any mirror/mod repos? Reddit and Discord were inaccessible, so this is unverified. A GitHub DMCA search of `github/dmca` for "azeroth survivors" was not done and would be a cheap follow-up.
- Is there a current Blizzard fan-content policy covering fan games? Not found in this pass; the EULA's reverse-engineering/derivative sections should be read in full.
- Do benilla's clean-room claims ("no original client code") materially change risk for the *data* side? Probably not, since they address code only.
- Jurisdiction: the author's site is `.pl`; EU/PL law differences (e.g. interoperability exceptions, TDM) may matter to them and are not relevant to our risk without counsel.

## Sources
- <https://wow.aethus.pl/>
- <https://azerothsurvivorsgame.com/> and <https://azerothsurvivorsgame.com/download/>
- <https://github.com/OutThisLife/azeroth-survivors-re>
- <https://github.com/myslithell/azeroth-survivors>
- <https://github.com/XXJones21/azeroth-survivors-windows-build>
- <https://github.com/bymarvin/azeroth-survivors-source>
- <https://github.com/samwhosung/benilla>
- <https://github.com/Arnesen/wenilla> and <https://github.com/Arnesen/wenilla/blob/main/crates/wenilla-realm/README.md>
- <https://archive.org/details/WoW_1.12.1-5875>
- <https://www.blizzard.com/en-us/legal/> (index), [Legal FAQ](https://www.blizzard.com/en-us/legal/c1ae32ac-7ff9-4ac3-a03b-fc04b8697010/blizzard-legal-faq), [EULA](https://www.blizzard.com/en-us/legal/fba4d00f-c7e4-4883-b8b9-1b4500a402ea/blizzard-end-user-license-agreement), [Copyright infringement notice](https://www.blizzard.com/en-us/legal/0f4d7809-ac0c-453c-a28b-003d77aac798/copyright-infringement-notice)
- Internal: [clean-checkout.md](clean-checkout.md)
