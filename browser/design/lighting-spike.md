# Lighting spike: god rays and "high end" lighting

Goal: emulate the look of World of Warcraft: Forever / modern WoW (soft bloom, shafts of sun, atmospheric fog, graded color) in the Azeroth Racer world renderer. No Blizzard art is included; references are links plus descriptions.

## References

**Could not be verified.** The official page (`worldofwarcraft.blizzard.com/en-us/forever`) is JS-rendered and fetched empty; Wowpedia returned 403; search engines were bot-blocked. Nothing specific about WoW Forever's lighting stack (godrays, bloom, SSAO, shadows, grading) is confirmed here. Treat "WoW looks like X" as an aesthetic target to compare against by eye, not a spec. Someone with the live game should capture reference screenshots (kept out of git).

Techniques (all URLs returned HTTP 200 when checked):

| Technique | Source | Notes |
|---|---|---|
| Screen-space radial-blur god rays | [GPU Gems 3 ch.13](https://developer.nvidia.com/gpugems/gpugems3/part-ii-light-and-shadows/chapter-13-volumetric-light-scattering-post-process) | Occlusion mask, march each pixel toward the projected sun with decay/weight/density. Cheapest option; only works with the sun on screen. |
| Froxel volumetric fog | [Wronski, AC4 (SIGGRAPH 2014)](https://advances.realtimerendering.com/s2014/wronski/bwronski_volumetric_fog_siggraph2014.pdf) | Camera-aligned 3D grid, inject light + density, integrate along depth. Gives real shafts and local fog, needs shadow data to be good. |
| Volumetric lights (shadow-map raymarch) | [Pestana](https://www.alexandre-pestana.com/volumetric-lights/) | Per-pixel march sampling a shadow map. Needs shadow maps. |
| Sky/atmosphere LUTs | [Hillaire 2020](https://sebh.github.io/publications/egsr2020.pdf) | Physically based sky, aerial perspective. Later stage. |
| Filmic tonemap | [Narkowicz ACES fit](https://knarkowicz.wordpress.com/2016/01/06/aces-filmic-tone-mapping-curve/) | One-line fit; needs an HDR input to matter. |
| Bloom | Jimenez, "Next Generation Post Processing in Call of Duty: Advanced Warfare" (cited by name; the PDF URL 404'd) | Downsample chain with 13-tap filter, upsample with tent. |
| WebGPU post-processing | [WebGPU Fundamentals](https://webgpufundamentals.org/webgpu/lessons/webgpu-post-processing.html), [spec](https://www.w3.org/TR/webgpu/) | Render-to-texture patterns. |

## Renderer audit

Corrects the brief: the renderer is **WebGPU/WGSL, not WebGL2**.

- **No offscreen scene target.** Everything draws straight into the swapchain (`getPreferredCanvasFormat()`, opaque). No HDR/float target, so no bloom, tonemap or grade without a structural change.
- **Depth** is `depth24plus`, standard-Z, with `TEXTURE_BINDING`; clouds and the craft shadow already read it as `texture_depth_2d`. Depth access is the one thing already free.
- **Pass order:** main (clear, sky, dome, planet, patches, terrain, scene) -> craft shadow -> cloud pass (clouds, curtain, flash, body clouds) -> props -> particles -> weather/bolts/wind.
- **Shadows:** no shadow map. Only a fullscreen projected craft blob (`shadow.js`).
- **Sun:** `r.sunLocal ?? sunDirection(r.timeOfDay)`, a world-space unit vector; day/night and weather already exist.
- **Clouds:** Standard and High (volumetric raymarch), High costs 8-13 ms/pass at 1080p and auto-downgrades via `SlowFrameGuard`. Rain curtain ~5 ms.
- **Perf budget** (`design/perf-pass.md`, real data, 1280x720, ground): mean 4.80 ms (p99 10.7) after the perf pass. Little headroom at 1080p on weak GPUs with clouds High; new passes must be tiered and guardable.

## Staged plan (cheapest wow first)

| Stage | What | Cost / perf risk | Benefit |
|---|---|---|---|
| 1 | Sun-occlusion screen-space god rays (**prototyped**) | Low code. One fullscreen pass, N depth loads/pixel (16 low, 40 high). Move to half-res target before shipping. | Medium at sunrise/sunset, only with sun in view |
| 2 | Offscreen `rgba16float` scene target, then bloom (dual filter), ACES tonemap, sunset/time-of-day grade (LUT or params) | Medium-high: touches every pipeline's target format, MSAA, and screenshot/readback paths. 1 extra full-res copy + ~5 small passes. | Largest overall "WoW look"; also makes stage 1 look right (rays need bloom/HDR) |
| 3 | Height/volumetric fog, then froxel integration | Medium; froxels ~1-2 ms at 160x90x64 plausible, unverified | Depth and atmosphere, real shafts |
| 4 | Cascaded shadow maps for terrain/props, then SSAO | High: new geometry passes over the whole scene, biggest perf risk | Grounding, shafts through trees/gaps |
| 5 | Atmosphere LUTs (Hillaire) | Medium, mostly precompute | Sky realism |

Tiers: Off / Low / High per effect in Graphics settings (default off, persisted in localStorage like other settings), plus the existing `SlowFrameGuard` pattern to step tiers down on slow frames. Recommendation: do stage 2 next (it is the enabler), then retune stage 1 on top of it.

## Prototype (stage 1)

Setting `God rays` (off/low/high), default **off**, persisted as `racer.godrays`.

- `godrays.js`: config, uniform packing, WGSL shader. `renderer-godrays.js`: lazy pipeline (no cost when off). Drawn additively at the end of the cloud pass in `world-renderer.js`.
- Shader projects the sun to NDC, marches each pixel toward it in screen space counting depth==1 (open sky) as light, IGN jitter, facing/distance falloff.
- Unit tests: `godrays.test.mjs`.
- Capture: `node heavy-lock.mjs --label lighting -- node lighting-shots.mjs` writes git-ignored `test-results/lighting/`.

Known limits: tied to the cloud-pass toggles; clouds don't occlude (depth-only mask); full-res; no HDR so rays can clip; space view skips it.

## Results and what is unverified

- Setting plumbing, pipeline compile (after a WGSL fix) and zero error output in headless Edge: verified.
- **Visual quality is NOT verified.** In captures the visible vertical sunlit column appears identically with god rays Off, so it is a pre-existing artifact of the existing sky/sun path (or headless capture), not the prototype; it makes before/after hard to judge. With the sun off-screen or low the rays contribute little in the shots taken; no clear radial shafts were observed. Tuning (strength/decay, brightness) is still needed.
- **Perf is NOT verified.** Headless Edge rAF is vsync-capped (~12-18 ms mean regardless of tier, adapter info empty), so tier differences are within noise. Needs `perf-pose.mjs`-style profiling or GPU timestamp queries on real hardware. Analytic cost only: 33-83M depth loads/frame at 1080p.
- WoW Forever reference details: unverified (see References).
