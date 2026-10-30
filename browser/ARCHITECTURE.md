# Azeroth Racer: system architecture (current)

Single-player browser world over WoW 1.12 Kalimdor + Eastern Kingdoms, with a globe (planet R = 42,785 yd), driveable Rocket/podracers, and space.
WoW 1.12 data is required (no demo/no-data world: a missing Data folder shows "WoW data folder not found"); art and audio are never committed. Agents use the real data read-only via the parent checkout runtime\browser (never commit it).

```mermaid
flowchart TB
  subgraph Data["Data sources (runtime, never committed)"]
    LOCAL["User WoW Data folder<br/>(MPQ: ADT, WDL, M2, BLP, DBC)"]
    DEMO["Demo world<br/>adt-synth.js + demo-source.js"]
    SWE["Optional SWE1R assets"]
  end

  subgraph Shell["Delivery"]
    SRV["server.mjs :4173<br/>static + generated shell manifest"]
    SW["sw.js service worker<br/>(shell cache = manifest hash)"]
    WASM["pkg/ (flats-racer-web wasm)<br/>physics + whirlpool + mesh"]
  end

  subgraph Main["Main thread"]
    APP["world-app.js<br/>wiring, F8 pose export, settings"]
    INPUT["world-input / world-camera"]
    SIM["flight.js, vehicles.js, race.js<br/>planet-frame (f64) / planet-physics"]
    HUD["hud-model, map-panel, worldmap,<br/>track-editor"]
    AUDIO["world-audio, music, world-music"]
    REND["world-renderer.js (WebGPU)"]
  end

  subgraph Render["Render passes"]
    TERR["Terrain tiles + bend shader<br/>(authored ADT near field)"]
    GLOBE["Globe: space.js + globe-patches<br/>height-bake, tile-registry"]
    OCEAN["ocean-mesh + water-shader<br/>2500 yd cells, whirlpool dip"]
    SKY["sky.js, shadow.js, particles"]
    CLOUDS["clouds.js (Standard/High raymarch)<br/>cloud-flow wind + Maelstrom, cloud-march JS mirror"]
    ACT["actors, npc-pack, wander, wreck, beam"]
  end

  subgraph Workers["Workers"]
    WW["world-worker.js<br/>scene / tile orchestration"]
    AW["asset-worker.js<br/>decode, glb"]
    FW["far-worker.js<br/>far/WDL LOD"]
  end

  subgraph Streams["Streaming layer"]
    ST["scene-stream, terrain-stream,<br/>water-stream, far-stream, craft-stream"]
    CH["asset-channel / far-channel<br/>asset-source / asset-folder"]
    STORE["world-store (IndexedDB cache)"]
  end

  subgraph Native["Wasm build (Rust, client/)"]
    CR["benilla-formats + mpq, adt, wdt, wmo, m2, blp, dbc"]
    FR["flats-racer-physics / -web"]
  end

  subgraph Test["Gates"]
    T["node --test browser (555)<br/>build-dist, sweeps, p99 drive check :4183"]
  end

  LOCAL --> CH
  DEMO --> CH
  SWE --> CH
  CH --> AW
  CH --> FW
  AW --> ST
  FW --> ST
  ST <--> WW
  WW <--> STORE
  WW --> REND
  SRV --> SW --> APP
  SRV --> WASM --> SIM
  FR -. builds .-> WASM
  CR -. shared formats .-> FR
  APP --> INPUT --> SIM
  SIM --> REND
  SIM --> AUDIO
  SIM --> HUD
  APP --> HUD
  REND --> TERR
  REND --> GLOBE
  REND --> OCEAN
  REND --> SKY
  REND --> CLOUDS
  REND --> ACT
  GLOBE -- "fog/sky colour,<br/>depth, limb" --> CLOUDS
  OCEAN -- "land mask" --> CLOUDS
  T -. guards .-> Main
```

## Notes
- **Frames:** world units are yards; flat tiles are bent onto the sphere by a shader (M5b, removing it, is deferred). The globe uses a coarse baked height texture (~130 yd/texel); authored ADT is only used near-field.
- **Handoff:** the flat ocean mesh hides above 25k yd and the globe sea takes over. Zone lighting fades to global sun lighting in space.
- **Night lights:** `night-lights.js` bakes a hand-written settlement table (warm firelight; Dalaran arcane, Karazhan eerie) into a 2048x1024 equirect texture once per world; `surface()` in `space.js` samples it on the dark side above ~2.5k yd. Demo worlds fall back to a few demo settlements. No per-frame cost beyond one texture read.
- **Files:** `shell-manifest.mjs` generates the shell list from the import graph (plus a small `RUNTIME_ASSETS` registry); `server.mjs` and `build-dist` serve/publish it and stamp it into `sw.js`, whose cache name is the manifest hash. No hand-edited list or version bump.
- **Removed material:** the VMaNGOS C++ server, native Bevy client crates, runtime/, tools/ and bootstrap scripts are no longer in the tree; see the root README for the commit that last contained them.
- **Next (rocket phase):** unified space physics per `SPACE-PHYSICS.md`; see `GLOBE-REFACTOR.md`, `CLOUD-FLOW.md`, `HARDENING.md`, `DEBT.md`.
- **Flight instruments:** `flight-hud.js` (right-edge compass, drum altimeter, climb rate) is fed once per frame from `app-frame.js` with the active framed body, `renderer.view` and sim time. `compass.js` converts the camera's chart basis to inertial space (`chartAxes`), picks the nearest body (`nearestSurface`) and returns the north-pole bearing and altitude, so one formula covers orbit, Elune and the E/N/S pole charts. `altimeter.js` holds the pure drum/climb model. The optional WoW ring texture and FRIZQT font come from the worker (`hud-art.js`, action `hud-art` -> event `hud-art`); images are drawn to canvas because the CSP blocks blob/data image URLs.

## Weather
See README 'Weather' and design/weather.md. Modules: weather-*.js plus renderer-weather.js (curtain, near particles, bolts, flash), stepped from stepWeather; audio via world-audio setWeather/thunder.

