# Next-waypoint arrow – design pass

Mock: `browser/design/waypoint-arrow-mock.html` (open directly; drag in any view to move the gate; buttons for Left/Right/Behind/Above/Below/Far/Near/Final, bright/dark sky toggle). Design only – no game code touched.

Screenshots (kept out of git, in the session files folder `C:\Users\liz\.copilot\session-state\f2138176-e119-43e7-b1b5-dd59099a047f\files\`): `mock-left-bright.png`, `mock-behind-bright.png`, `mock-above-dark.png`, `mock-far-bright.png`, `mock-near-dark.png`, `mock-final-bright.png`.

## How it works today

- `gate-guide.js` `gateGuide()` takes craft pos/yaw and `race.nextGate`, returns `{angle, range, climb, behind, visible}`. `angle` = `bearing()` (race.js) – horizontal bearing relative to craft yaw only; elevation ignored except a ▲/▼ glyph when |dy| > 25 yd. `behind` = |angle| > 0.6π.
- `app-race.js` (~line 166) writes it into the DOM: `#race-arrow` (a ▲ text glyph inside the race HUD sub-row, `index.html`) is rotated by `angle`; `#race-range` shows `"412 yd ▲"` (yd, then `k yd`).
- Colour: amber `#ffd36a`; when behind it turns red `#ff6b6b` and blinks (`style.css` 144-145). Hidden if the gate is on another body (label shows the body name).
- It is a small 22px glyph in the top HUD band, not in the 3D view, so it is a compass-style heading hint only: no elevation cue besides ▲/▼, no distance scaling, no on-screen gate marker (the gate itself is the in-world prop mesh, `renderer-terrain.js` `gateMesh`; the final gate has a checkered banner). Red/amber is the only behind cue (colour-blind weak).

## Common rules for all concepts

- Pair every colour with a shape/motion cue: gate = **amber ring/diamond**, "behind / turn around" = **cyan + double chevron + pulse**, final gate = **checkered mark** (not a colour).
- Amber + cyan are separable under protan/deutan/tritan; luminance-contrasting black outline (3px) on every glyph for bright sky and dark terrain.
- Range text always has a dark stroke; climb/dive as ▲/▼ plus word where room.

## Concepts

| | Look | Off-screen / behind | Very far | Very near | Bright sky / dark terrain | Cost | Perf risk |
|---|---|---|---|---|---|---|---|
| **A. 3D chevron + compass ring** | Ground ring ahead-below the craft with a flat chevron lying in it pointing at the gate, tilting up/down with elevation | Chevron swings round naturally; behind = cyan, "TURN AROUND" | Constant size, range text only | Chevron stays, gate ring appears around gate | Outlined solid fill: good on both; ring is thin/white so weak on bright sky | Medium-high: new mesh + WGSL/draw path in cockpit/chase, per-view camera attach | Low (one small mesh) |
| **B. Screen-edge clamp** | Corner brackets on gate when visible; when off-screen an outlined chevron clamped to an inset ellipse with range beside it | Chevron at edge (bottom when dead behind), cyan + pulse | Brackets shrink to a floor size | Brackets grow to a cap, range stays | Strong outline reads everywhere | **Low**: DOM/SVG overlay, needs projection of gate with the camera matrix (already have in renderer) | Very low |
| **C. Ribbon / breadcrumb** | Chevron trail from the craft that bends toward gate, fading with distance | Trail curls to turn side; weak when exactly behind | Capped to ~70 yd so far gates are just a direction | Few chevrons, tail ends at gate | Amber + pale-yellow alternate; reads fine, busy over cluttered terrain | High: world-space instanced chevrons with terrain/altitude following | Medium (many quads, terrain sampling) |
| **D. Holographic gate ghost + pointer** | Dashed cyan scan-line ring marking the gate through scenery; off-screen mini ghost + amber pointer at edge | Mini ghost at edge, same as B | Ghost shrinks to a dot (visible far away) | Ghost matches real gate size, can fade out when <50 yd | Cyan on light sky is the weakest (low contrast) – needs a dark outline pass | Medium: DOM/canvas overlay, or alpha-blended ring mesh drawn without depth test | Low |
| **E. HUD compass strip** | Top strip with ticks; amber diamond tick for gate, ▲/▼ + range under | Diamond pins at strip end with ◀◀ / U-TURN | Same; range only | Same | Dark plate behind makes it background-independent | **Lowest**: replaces the 22px glyph with an SVG strip in `#race-hud` | None |
| **F. Beam + radar dial** | Vertical light column at the gate (seen at any range), radar dial bottom-left with log-scaled gate blip and range | Radar shows direction fully (incl. behind); beam absent off-screen | Beam is the strength – visible from far | Beam widens, blip sits at centre | Beam on bright sky is weak; radar plate fine | Medium: beam is a prop (`beamFx` hook exists) + SVG radar | Low (beam additive quad) |

### Notes per concept

- **A** – most "in-world" and discoverable, best sense of 3D direction including up/down, but takes screen real-estate right in the sight line; needs a cockpit-vs-chase placement decision.
- **B** – the familiar racing/flight-sim convention; solves off-screen, behind, above/below in one mechanism and tells you exactly where the gate is when visible.
- **C** – nicest for low-altitude ground racing but poor for large altitude changes and when the gate is far; most work.
- **D** – nice flavour, helps find a gate hidden behind terrain/clouds; ghost alone doesn't solve off-screen so it needs B's pointer (that's what the mock draws).
- **E** – very quiet and cheap; loses precision for up/down and is easy to ignore in a fast race.
- **F** – radar gives a full 360° answer, but is another instrument to read; beam is the best far-gate cue.

## Ranking and recommendation

1. **B + E combined (recommended)**: edge-clamped chevron/brackets (B) as the primary cue, with the existing `gateGuide()` output driving it – `angle`/`behind`/`climb`/`range` already exist; only a gate-to-screen projection is new. Keep a slim compass strip (E) in the race HUD in place of the 22px glyph for the heading and range. Mostly DOM/SVG; no WGSL; trivial perf; fixes the current weaknesses (elevation, behind cue not colour-only, no on-screen gate marker).
2. **F** (beam + radar) – add the beam for far-gate visibility if gates are hard to spot from range; radar optional.
3. **A** – best "wow", worth it if we want an in-world pod-attached cue; needs 3D work.
4. **D** – as an optional cosmetic layer on top of B.
5. **E alone** – fine fallback.
6. **C** – last: highest cost and perf risk, weakest at long range.

## Suggested implementation sketch (for later)

Extend `gateGuide` with `elevation` (atan2(dy, horizontal range)); add a tiny overlay module that projects `gate.pos` with the renderer's view-projection, clamps to an inset ellipse when outside, and sets CSS custom properties; reuse existing `#race-range` text. Honour `prefers-reduced-motion` for the pulse.

## Implemented

Concept C shipped (`gate-trail.js`, chevron pass in `world-renderer.js`/`renderer-init.js`, wired in `app-race.js`). The small compass (`#race-arrow`) is removed; `#race-range` stays. No extra gate marker was added.

- Trail of up to 14 chevrons capped to 70 yd, bending from the heading toward the gate, fading with distance; unlit so it stays readable at night; black outline, no depth test.
- Behind: cyan double chevron that bends in a U-turn and blinks (static under `prefers-reduced-motion`). Final gate: checkered last chevron.
- Orbit regime and cross-body gates use a straight line along the shared-frame direction; range shows as `Nk yd`. Geometry depends only on direction and the capped length, so it stays finite/bounded at any range. Track format already supports per-gate `body`.
- Hidden outside races, during body swap, or when there is no next gate. No terrain sampling (altitude is interpolated craft to gate).
- Verified by unit tests only (`gate-trail.test.mjs`, `gate-guide.test.mjs`). Unverified: real-browser render/shader compile, cross-body smoke script, handler p99 (~20 ms) / 0 errors.

