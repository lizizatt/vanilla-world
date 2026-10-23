# SWE1R bottom HUD: ground truth (numbers only, no art)

Reference: one 596x335 in-game screenshot supplied by the user (not stored here). All values are pixel
measurements of that frame (so x/596, y/335 fractions) plus what the local `lev01 out_spriteblock.bin`
sprite index shows. Nothing is copied from the game.

## What the sprite data does and does not say

- Sprite block indices 0-127 contain: 28/29 (64x64 RGBA32 ring/disc, circular), 30/32 (tan face and second
  ring), 31/33/34 (glow/star), 35 (48x8 grey strip), 19-21 (countdown digits).
- No oval-dial sprite and no tall engine-panel sprite was identified in 0-127. The oval dial and the
  engine panels in the screenshot are therefore **not confirmed to be sprites** (they may be tiled/composed
  from other blocks or drawn from textured quads). Layout below is measured from the screenshot, not from
  game data. The SWE1R-folder path keeps using sprites 28/29 and 30/32 where they apply.
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
at 16:9. Top row (lap / time / pos) is out of scope here.

## Our mapping (Azeroth Racer)

- Engines: green while heat < 50%, yellow 50-80%, red >= 80% (the klaxon zone), blinking at 100%.
  Both engines share the one heat value (this is not per-part damage; there is no damage model).
- Dial: arc length = heat 0-100% (replaces the old boost bar; boost is unlimited), purple -> amber -> red
  with the engines' thresholds; light is green below 80%, red at/above; rim flashes at overheat.
- Unmeasured/assumed: yellow/red hues, flash rate, number font (own italic UI font, not the game's).
