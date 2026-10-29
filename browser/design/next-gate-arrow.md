# Next-gate arrow: proposal

## What is wrong today
`raceHud` rotates a 16 px `▲` in the race HUD by `bearing(pos,yaw,gate.pos)`.

- **Cross-body:** the arrow is hidden when the next gate is on another body. The only hint is a body name in the gate text. There is no direction and no distance.
- **Space / launch:** `bearing` is a flat xz angle. During a ramp launch or orbit the gate is mostly above or below the craft, so the arrow points at the gate's ground shadow and says nothing about climb or descent.
- **Poles:** the bearing is exact only in the local frame. Near a pole the heading flips quickly and the arrow twitches, and nothing tells the player the gate is "far, roughly this way".
- **Occlusion:** the beacon column can be hidden by terrain or fade with distance, and the arrow is the only fallback. It has no emphasis when the gate is behind the player, so it is easy to miss.
- **Distance:** no readout. Gates a few yards or several thousand yards away look identical.
- **Scale:** a fixed 16 px glyph is too small to read at speed and is not tied to the Racer HUD scale.

## Options
1. **HUD guide (arrow + range + climb cue).** Keep the arrow in the race band. Compute it in a pure `gateGuide()` helper: a 3D range with adaptive units (`yd` / `k yd`), a climb or descent cue (`▲`/`▼`) when the vertical offset matters, an emphasised "behind you" state, and for other-body gates a body label with no arrow and no range. Cheap, independent of the renderer and camera, works the same in space, at poles and through occlusion.
2. **Projected world marker.** Project the gate onto the screen each frame and draw an edge-clamped marker, with a pure projection helper and a canvas or DOM overlay. It would read best on screen, but it needs the camera matrices in every mode (drive, fly, pod journey, cockpit). It also needs special handling for behind-camera and near-pole cases, and the renderer API differs between bodies.

## Recommendation
**Option 1.** It fixes every listed problem except "marker on the gate itself" using only data the race code already has (telemetry position and yaw, gate position, gate body). It adds no per-frame renderer coupling and stays in the existing Racer HUD style, so it is low risk for the p99 gate. Option 2 can be layered on later, because `gateGuide()` already returns the angle and range it would need.
