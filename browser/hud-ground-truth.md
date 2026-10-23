# SWE1R bottom HUD: ground truth (numbers only, no art)

Reference: one 596x335 in-game screenshot supplied by the user (not stored here). All values are pixel
measurements of that frame (so x/596, y/335 fractions) plus what the local `lev01 out_spriteblock.bin`
sprite index shows. Nothing is copied from the game.

## What the sprite data says (corrected)

An earlier revision claimed no dial/panel sprite exists; that was wrong. `decodeSprite` ignored the N64 TMEM
row padding (rows padded to 8 bytes; 16 px for 4-bit, 2 px for RGBA32), so non-multiple-of-8 sprites were
garbled (fixed in 31ce229). In `lev01 out_spriteblock.bin` (179 sprites) the **block index equals the
swrSprite_NAME id** from the community RE enum (reference only, AGPL SW_RACER_RE; nothing copied). HUD pieces:

| id | size | RE name | role |
|---|---|---|---|
| 40/41/42 | 26x63 etc | hudframe_top/mid/btm | vertical frame struts |
| 43 | 91x3 | speedbar | thin tick strip |
| 46/47/48/49 | ~27x62 | engdisp0..3 | engine-module icons for the bottom-left cluster (6 damage modules + 2 cooling, per swrRace_InRaceEngineUI) |
| 99 | ~34x34 | dial_gradient | red->blue half-ring ramp (the arc colour ramp; coloured, not fixed purple) |
| 101 | ~16x16 | dial_lightflash | white lamp dot |
| 102/103/104 | | dial_speed_edge_blue / mid_blue / speed_wire | speed readout frame pieces |
| 105-108 | | dial_time_wire / top_h_wire / trakmid / traktop | top row (lap/time/pos) wires |
| 166 | 71x59 | dial_meter_only | the oval dial outline with the lamp socket and swoosh |
| 111-126 | 14x14 | hi/lo_border_* | 9-slice window corner/edge pieces (menus, not HUD) |
| 95/96, 138-148 | | award/lrg/sml window, rectangle_blue | menu windows (previously mis-taken for the panels) |
| 28-34 | 64x64 | lensflare1-5, sun_tat, glowstar | flares/glows (the old ring/disc guess was these) |

Ruled out: textures/models blocks hold 3D parts, not the HUD; `images\*.TGA` are menu art; no bitmap digit font for the
speed number was found in the spriteblock (the digits 19-21 are the 64x64 race countdown). The original draws the
number as engine text (so our own italic font is the closest option). The dial/engine layout lives in code
(swrObjJdge_DrawSpeedDialHud, swrRace_InRaceEngineUI) on a ~320x240 design grid, anchored bottom-left / bottom-right.
Not verified locally: exact sprite x/y placements (they are in the game executable, not the data files) and the
damage-colour tint rules, so the layout below stays screenshot-measured.
- Sounds (Sounds.map): `sfx_klaxon1/2/3_loop` (warning stages), `sfx_pod_coolant_spray_on/_loop` (cooldown).
## Left: twin engine panels

| item | measured | fraction of frame |
|---|---|---|
| left panel box | x 28-62, y 238-310 (34x72) | x .047-.104, y .71-.93 |
| right panel box | x 80-115, y 238-310 (35x72) | x .134-.193, y .71-.93 |
| gap between panels | ~18 px | .030 w |
| panel aspect | ~1 : 2.1 (tall, narrow) | |
| bottom margin | 25 px | .075 h |
| left margin | 28 px | .047 w |

Look: translucent green fill (~35% alpha, bright green when healthy), cyan-ish 2 px border, one
pod-part icon centred (the right panel's icon includes a brown block). Colour is the damage state:
green (healthy) -> yellow (damaged) -> red (critical). The screenshot only shows green.
Anchor: bottom-left, margins proportional to frame height; the pair is not centred.

## Right: speed dial

| item | measured | fraction |
|---|---|---|
| oval rim | centre (493, 267), ~120 x 50 | x .83, y .80; w .20, h .15 |
| rim colour | teal/blue, dark translucent fill | |
| speed number | italic, ~24 px tall, cyan-white with dark outline, centred in oval; "355" | .07 h |
| green light | circle ~9 px at (513, 232), on top-right of the oval | x .86, y .69 |
| arc | purple/magenta swoosh on the right side, from near the light (535, 232) curving down to ~(545, 300), ~9 px thick, outside the rim | spans y .69-.90 |
| right margin | ~40 px | .067 w |

Anchor: bottom-right. Arc length encodes the boosted/heated quantity; colour from purple toward
red is an assumption (only purple is visible in the reference).

## Aspect handling

Both clusters are anchored to the bottom corners with margins proportional to frame height, so at 4:3
(e.g. 640x480) and 16:9 (e.g. 1280x720) sizes scale with height and the gap between clusters widens
at 16:9. Top row: see "Top banner" below.

## Our mapping (Azeroth Racer)

- Engines: green while heat < 50%, yellow 50-80%, red >= 80% (the klaxon zone), blinking at 100%.
  Both engines share the one heat value (this is not per-part damage; there is no damage model).
- Dial: arc length = heat 0-100% (replaces the old boost bar; boost is unlimited), purple -> amber -> red
  with the engines' thresholds; light is green below 80%, red at/above; rim flashes at overheat.
- Unmeasured/assumed: yellow/red hues, flash rate, number font (own italic UI font, not the game's).

## Top banner (lap / time / pos)

Reference frame (596x335): a full-width teal band curving down to a centre dip; LAP `1/3` left (x .06, text ~14 px, label under it), TIME `3:51.38` centre (~16 px, label `TIME`), POS `12/12` right (x .92). Band height ~.12 h at the edges, ~.15 h at the dip; cyan rim; white italic digits with a dark outline; small spaced caps labels beneath each value.

Sprites: 40/41/42/105-108 (the RE names `hudframe_*` / `dial_time_wire` etc.) decode as brass/steel frame struts and rivet plates (hangar/selection-screen style), not a teal curved band, so no matching pieces were found; the band and digits are drawn by the engine. Both the SWE1R-folder and hosted paths therefore use our own SVG/CSS band (no Racer art involved).

Our layout: band `min(100vw, 900px)` centred, height clamp(44, 7vw, 78) px; value font clamp(16, 3.2vw, 34) px (time clamp(21, 4.6vw, 48) px); cells in a 1 : 1.6 : 1 grid. Below it a small line shows best, split delta, last/best lap, gate n/N and the next-gate arrow. Position shows `1/1` (no AI racers; the slot is kept so the layout matches Racer). At <=1100 px wide the band drops to 26 px so it clears the `Esc - Menu` hint. Lap banners (LAP n / FINAL LAP / LAP RECORD / FINISH) are no longer limited to the Racer HUD.
