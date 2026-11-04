# UI pass: Esc menu, settings, keybinds

Mock: [`ui-pass-mock.html`](ui-pass-mock.html) (interactive; open it from a local server or `file://` after extracting art, see [Asset plan](#asset-plan)).
Screenshots are kept out of git. Request: "a pass over the UI, the escape menu, settings menus, general keybinds ... something that'll carry us forward, ideally using wow assets where we can."

No production code was changed. The only repo changes are this doc, the mock, and a `.gitignore` line for the local art folder.

## 1. Audit

### Menus and panels

| Surface | Where | Findings |
|---|---|---|
| Game Menu | `<dialog id="race-menu">`, 5 tabs: Game, Options, Controls, Diagnostics, Data | Title is "Game Menu" but it is also the settings window, the help page, the save manager and the debug page. The first tab is a flat list of 11 buttons with no grouping. Fly and Drive have no key on the keyboard (Start on pad only). Key hints are in the button text, typed by hand. |
| Options tab | same dialog | Four fieldsets plus a collapsed "Handling" with 18 numeric inputs. Wraps and reflows (checkbox rows wrap mid-sentence). No search, no reset, no per-setting help. "Space key" select actually chooses the control profile. |
| Controls tab | same dialog | Four static paragraphs. `#keyboard-guide` is rewritten per profile but the rest is hand-typed text and has drifted (it documents **N night**, which no handler implements). |
| Diagnostics, Data | same dialog | Status text and Save/Load/Retry. Reasonable content, wrong place for an end user. |
| Garage | `#garage` dialog, `G` | Different styling from the Game Menu (flat gold line, no double border). Footer text repeats the shortcut. |
| World map | `#map-panel`, `M` | Full-screen, own close button, own `M` handler on the dialog. |
| Track editor | `#track-editor`, `T` | Toolbar and side panels use a third look. Shortcuts `G/V/S/Del/Ctrl+Z` are shown only in a status line and button labels. Bug: `<span id="te-dirty">Â· unsaved</span>` and the garage arrows show mojibake in source (`â—€`). |
| Loading, welcome | `#loading-screen`, `#welcome` | Loading screen already uses WoW art (good precedent). Welcome is a plain card. |
| HUD | `.meters`, `#flight-hud`, `#time-hud`, `#menu-hint`, `#race-*`, `#hit-flash`, weather, `#status`/`#error` | Eight independent positioning systems. `Esc · Menu` hint is tiny, top-right, low contrast. Race band is cyan/blue while everything else is gold/brown. Prompts ("Press F to start race") hard-code the key in the string. |
| Dev tools | wind panel (`Ctrl+Alt+W`), pose export (`F8`), test crash (`Ctrl+Alt+K`) | Hidden chords, undocumented to players, fine but should be flagged "Debug" in the registry. |

Current look (viewed in headless Edge): brown/gold panel with `3px double` border, Georgia headings, system-ui everywhere else. WoW art is used only in the loading screen and the compass ring (`hud-art.js`).

### Settings inventory

| Setting | Location | Persistence |
|---|---|---|
| Clouds, Planet view, Cloud quality | Options > Graphics | `racer.cloudQuality`, `racer.planet`; **clouds not persisted** |
| Weather, Weather quality | Options > Graphics | `racer.weather`, `racer.weatherQuality` |
| Particles | Options > Graphics | **not persisted** |
| Distant terrain, Scenery, Distant models | Options > Graphics | **not persisted** (`horizon/scenery/distant`) |
| Animate NPCs, Ocean waves | Options > Graphics | `racer.animateNpcs`, `racer.waves` |
| Memory budget | Options > Graphics | `racer.memoryBudget` |
| Sound, Music, HUD dial, Racer SFX | Options > Sound | `racer.music` only; the rest **not persisted** |
| Master volume | Options > Sound | `racer.masterVolume` |
| Music volume | Options > Sound | **not persisted** |
| Durability, Break apart, Overheat, Impact speed | Options > Crashes | `racer.durability`, `racer.gib`, `racer.overheat`, `racer.gibSpeed` |
| Camera distance | Options > Camera | **not persisted** |
| Control profile ("Space key") | Options > Camera | **not persisted** |
| Time scale | `#time-hud` slider | `racer.timeScale` |
| Handling tuning (18 fields) | Options > Handling | IndexedDB (`worldTuning`, per world) |
| Wind tuning | Ctrl+Alt+W panel | `racer.windTune.v2` |
| Vehicle + skin | Garage | `racer.vehicle` |
| Globe mesh / registry | no UI | `racer.globeMesh`, `racer.globeRegistry` (read-only dev keys) |
| Asset folder handle, world caches | Data | IndexedDB |

Findings: about half the toggles reset on reload; every setting is wired by hand in `app-settings.js` with its own try/catch around `localStorage`; the same labels live in HTML, JS and the help text.

### Keybinds

All hard-coded, in six files (`app-input.js`, `world-input.js` `DRIVE_KEYS`, `app-frame.js`, `track-editor.js`, `app-pose.js`, `wind-tuning-panel.js`, plus the garage and map dialogs). No registry, no rebinding.

| Problem | Evidence |
|---|---|
| `F` is two actions | cockpit, or start the race if a flag is near / "race again" (`app-input.js:19`) |
| `V` conflicts with itself | look back in the world, "Select/Move" in the editor |
| `G` conflicts with itself | garage globally, "Add gate" in the editor |
| `T` is a toggle and a mode | opens the editor; in the editor closes it; Esc does too |
| `Space` changes per profile | drift vs brake, chosen in a dropdown that is not labelled as a profile |
| `Up/Down` change by vehicle | pod pitch vs look |
| `X` is brake (drive) and nadir look (flight) | fine, but undocumented as context-sensitive |
| `Esc` has four jobs | menu, close map, close editor, close garage |
| Help text documents a key that does not exist | `N night` |
| Undiscoverable | `Ctrl+Alt+V` cockpit, `L` Elune (only in shared space), `F8` pose export |
| Naming inconsistent | "Unstuck (U)", "Reset to raceway (F9)", "Cockpit (F)" vs "Esc · Menu" vs "G add" |
| Gamepad is separate | mapping lives in `WorldInput.sample`; Controls text lists pad buttons by hand, `Back` opens the menu but `Start` flies |

Full current binding list is in [section 4](#4-keybind-table).

## 2. Proposal

### 2.1 Information architecture

Esc opens a short **Game Menu** (WoW-style, one column, grouped by separators); everything deep is one click away and has a key.

```
Game Menu (Esc)
 ├ Options            O      ── Graphics · Sound · Controls · Interface · Gameplay · Handling
 ├ Key Bindings       K      ── registry editor
 ├ Controls           F1     ── generated cheatsheet (hold F1 in game)
 ├ World Map          M
 ├ Garage             G
 ├ Track Editor       T
 ├ Fly / Drive        Tab
 ├ Unstuck            U
 ├ Data & Saves…         (Save, Load, Retry, asset folder)
 ├ Diagnostics…          (place, coordinates, input device)
 └ Return to Game     Esc
```

Rules:

1. **One window shell** for Menu, Options, Key Bindings, Controls, Garage, Data. Same frame, plaque title, buttons, tab strip, footer (Defaults / Done). The map and editor keep full-screen layouts but reuse the same button and toolbar components.
2. **Settings are data.** One schema array (`id`, label, category, kind, default, storage key, tags, `needs: reload|none`). It renders the page, powers search, "reset to default" per row and per category, and replaces the per-setting wiring in `app-settings.js`. Everything persists under one versioned key (`racer.settings.v2`), migrated from the existing `racer.*` keys on first run.
3. **Search** in the Options header filters across categories (see mock: type "volume").
4. **Handling and wind tuning** move under Options > Handling > "Advanced" and are clearly marked as tuning, not preferences.
5. **Diagnostics and Data** leave the main path: still reachable, no longer tabs next to Options.
6. **Contextual hiding**, as today: Restart/Abandon race only in a race; Garage/Editor not in a race.

### 2.2 Keybind registry

One module (`keymap.js`) is the single source of truth: `{id, label, category, context, defaults:{key:[…], pad:…}, hold?}`. Input code asks `keymap.down('drive.boost')` or subscribes to `keymap.on('ui.garage')`; nothing reads `event.code` directly except the registry.

- **Contexts** (`drive`, `fly`, `race`, `ui`, `editor`, `menu`) decide which actions can conflict. Drive and Fly may share keys (they are never active together); everything conflicts with `ui`.
- **Rebinding screen** (mock: Key Bindings): list grouped by category, Primary / Secondary / Gamepad columns, click a slot, press a key, Esc cancels, Backspace clears. Conflicts are shown inline and resolved by **swap** (the previous holder gets the old key). "Reset to defaults" per row/category/all.
- **Profiles** replace the "Space key" dropdown: *Native* (Space drift) and *Legacy* (Space brake) are presets of the same table. Custom edits create "Custom".
- **Persistence:** `racer.bindings.v1` stores only deviations from the preset.
- **Gamepad:** shown read-only in v1 (labelled in the user's glyph set); rebinding pad buttons is a follow-up. Pad mapping moves into the same registry so the cheatsheet is complete.
- **Cheatsheet** is generated from the registry, filterable by context (All / Driving / Flight / Race / Interface / Gamepad), so it can never drift. Hold `F1` for an overlay; also in the Game Menu.
- **Prompts** ("Press [F] to start race") take their label from the registry.
- **Fixes the proposal makes:** race-start gets its own key (`R` suggested) instead of sharing `F` with cockpit; editor tool keys become editor-context actions with a visible list; Fly/Drive gets `Tab`; `Esc` always means "back one layer".
- **Accessibility:** every action rebindable, a hold/toggle option for hold actions (boost, look back), full keyboard navigation in all windows (focus ring on every control, `Enter` on a slot starts rebinding).

### 2.3 HUD

A zone grid (mock: HUD layout): top-left status, top-centre world/race, top-right system, bottom-left vehicle health, bottom-right speed, centre-low prompts, optional bottom-centre action bar of shortcuts (new, off by default). One tooltip frame and one fade for every transient message. Race band adopts the same gold/ink palette as the menus (today it is cyan). HUD scale and "reduce motion" become settings.

### 2.4 Accessibility and input notes

- Contrast: 4.5:1 minimum for body text; FRIZQT at >= 14 px; gold on dark brown passes, dim gold (`#a8946a`) is for secondary text only.
- Don't rely on colour: conflict state also has text; gauges keep their numeric readout.
- Reduced motion setting disables pulse/flash/shake; honours `prefers-reduced-motion` by default.
- Gamepad navigation of menus (D-pad, A/B) is part of step 5.
- **Touch (note only):** the same shell scales; large hit targets (WoW button 22 px height is too small, scale 1.5x at `pointer: coarse`); touch driving controls are out of scope.

### 2.5 Visual language: three directions

All three share layout, registry and components; only the skin differs (`html[data-dir]` in the mock).

| | A · Classic frames | B · Gilded modern | C · Hybrid (recommended) |
|---|---|---|---|
| Frame | WoW `DialogBox` border and background, header plaque | Plain CSS rounded panel, thin gold line | WoW dialog frame and plaque |
| Buttons | WoW red `Panel-Button` sprites | Flat, hover glow | Flat gold-outline (ink on dark), WoW hover tint |
| Type | FRIZQT / MORPHEUS | FRIZQT / MORPHEUS | FRIZQT / MORPHEUS |
| Needs art | yes, all (CSS fallback present) | only the fonts (optional) | frame + font (CSS fallback present) |
| Pros | Most recognisably WoW; matches the game world | Clean, readable, no dependencies | Looks like WoW but dense lists (keybinds, 30 settings) stay scannable |
| Cons | Red buttons dominate long lists; button art is low-res when scaled | Least character | Mixed styles to maintain |

**Recommendation: C.** The frame, plaque, font and sounds carry the WoW feel; plain controls inside keep long settings and keybind tables readable. It also degrades best: with no art it becomes B plus a CSS frame.

## 3. Asset plan

Surveyed from the local 1.12.1 `Data\*.MPQ` (patch-2 > patch > misc > interface > fonts > sound read order) with `mpyq` + Pillow (BLP -> PNG). Extracted to `browser/design/ui-assets/` (gitignored) **for the mock only**.

| Group | Files (under `Interface\`) | Use | Verdict |
|---|---|---|---|
| Dialog frame | `DialogFrame\UI-DialogBox-Border/Background/Header/Divider/Corner`, Gold variants | Window shell, plaque | **Usable.** Border is a 256x32 strip of 8 cells (L, R, T, B rotated, TL, TR, BL, BR). Needs re-slicing into a 3x3 border image (done in the mock). |
| Tooltips | `Tooltips\UI-Tooltip-Border/Background`, `UI-StatusBar-Border` | HUD toasts, prompts | Usable (same 8-cell layout). The mock only uses the background tile. |
| Buttons | `Buttons\UI-Panel-Button-Up/Down/Highlight/Disabled`, `UI-DialogBox-Button`, `UI-CheckBox-*`, `UI-RadioButton`, `UI-SliderBar-*`, `UI-ScrollBar-*`, `UI-Quickslot2` | Controls | Usable. Panel button art occupies the top-left 80x22 of the 128x32 sheet; crop before use. Checkbox art is 32x32. |
| Glues | `Glues\Common\Glue-Panel-Button-*`, `Glue-BigButton`, `Glue-Tooltip`, `Glues-EditBox-Background`, logos | Main-menu-style buttons, search box | Usable. |
| Keybind frame | `KeyBindingFrame\UI-KeyBindingFrame-*` (6 parts) | Template for the rebinding window | Usable as reference; the mock uses the dialog shell instead. |
| Other | `ChatFrame\*`, `MainMenuBar\*` (action bar art, 256x256), `Minimap\UI-Minimap-Border` (already used), `OptionsFrame\*`, `PaperDollInfoFrame\*` tabs, `Cursor\*`, `Icons\*` (2,693) | Action bar, tab strips, garage icons, cursors | Usable. Icons give vehicle/garage glyphs without drawing any. |
| Fonts | `Fonts\FRIZQT__.TTF` (UI), `MORPHEUS.TTF` (headings), `SKURRI.TTF`, `ARIALN.TTF` | Typography | Usable. FRIZQT lacks non-Latin glyphs; keep a system fallback. |
| Sounds | `Sound\interface\iUiInterfaceButtonA`, `iUIMainMenuButtonA`, `uChatScrollButton`, `uCharacterSheetTab`, `iQuestLogOpenA/CloseA`, `Error` | Click, tab, open/close, error | Partly. `igMainMenuOpen/Close`, `igCharacterInfoOpen`, level-up were not found in this client's listfile. |
| Bindings reference | `FrameXML\Bindings.xml`, `WTF\DefaultBindings.wtf` | Naming/category reference for actions | Reference only (WoW names: Movement, Camera, Interface). |
| Not present | `FrameGeneral` (does not exist in 1.12), `Ability_Mount_RocketMount` icon | | n/a |

### Runtime loading (mirrors `hud-art.js`)

1. A `ui-art.js` module, started after the asset source is ready (like `HudArt`), reads the paths above with `source.read(path,{background:true,shouldDefer})` through the existing asset worker and decodes BLP via the wasm `SceneTexture` (`metadata()`, `rgba()`). Fonts are read as bytes (the existing `MAX_FONT` 1 MiB cap applies).
2. It composes the 3x3 border sheets and button crops on an `OffscreenCanvas`, then hands the result to the page as `ImageBitmap`/blob URLs set as CSS custom properties (`--dlg-border`, `--btn-up`, ...). Fonts are registered with `new FontFace('Friz', bytes)`.
3. A `html.has-art` class is set only when everything needed loaded; all art rules are scoped to it. Without it the CSS-only look (identical to direction B plus a CSS frame) applies. A user toggle (`Use WoW UI art`) forces it off.
4. **CSP:** `index.html` currently has `style-src 'self'` and no `img-src`/`font-src`, so it falls back to `default-src 'self'`. Blob/data images and `FontFace` from bytes require adding `img-src 'self' blob: data:` and `font-src 'self' blob:` (and `shell-manifest.mjs` CSP to match). This is the one security-relevant change and is isolated to media types.
5. **Nothing is committed:** no BLP/PNG/TTF/WAV in git. The mock reads `browser/design/ui-assets/` (ignored via `/browser/design/ui-assets/`), generated by a local extraction script from the user's own Data. In production the art is read from the user's attached Data folder at runtime, never bundled or cached in the shell manifest.
6. Sounds load lazily the same way, play through the existing audio graph, respect the master volume and the Sound toggle; silent if absent.

## 4. Keybind table

Current vs proposed. `-` means not bound.

| Action | Current | Proposed (Native) | Gamepad | Note |
|---|---|---|---|---|
| Throttle / reverse | W / S | W / S | RT / LT | |
| Steer | A / D | A / D | L-stick | |
| Boost | Shift | Shift | A / ✕ | hold/toggle option |
| Drift | Space (native), C | Space, C | X / □ | profile preset |
| Hard brake | X (Space in legacy) | X | - | |
| Hop | J | J | RB | |
| Pod pitch | Up / Down (pod) | Up / Down | L-stick | invert option |
| Look | Left / Right, right-drag | Left / Right | R-stick | |
| Look back | V | V | - | no longer clashes: editor tools move to `1-3` |
| Cockpit | F, Ctrl+Alt+V | **H** (Ctrl+Alt+V kept as alias) | R3 | frees `F` |
| Zoom | Wheel | Wheel | D-pad up/down | |
| Fly / Drive | menu only | **Tab** | Start | |
| Fly up / down | E / Q | E / Q | - | |
| Nadir look (fly) | X | X | - | |
| Start race | F at flag | **R** | Y | label in prompt comes from registry |
| Reset to raceway | F9 | F9 | Y / △ | |
| Unstuck | U | U | - | |
| Menu | Esc | Esc | Back | Esc = back one layer |
| Map | M | M | - | |
| Garage | G | G | - | |
| Track editor | T | T | - | |
| Elune arrival | L (shared space only) | L | - | listed only when available |
| Controls cheatsheet | - | **F1** | - | new |
| Options / Key bindings | - | **O / K** | - | new |
| Editor tools (editor ctx) | G / V / S, Del, Ctrl+Z | 1 add / 2 select / 3 start, Del, Ctrl+Z | - | G/V no longer clash with world keys |
| Night | documented, **not implemented** | remove from help | - | |
| Debug: pose export | F8, Ctrl+Alt+Y | F8 | - | marked Debug |
| Debug: wind panel / crash | Ctrl+Alt+W / Ctrl+Alt+K | same | - | Debug, hidden unless `?debug` |

## 5. Migration plan (small shippable steps)

1. **Registry, no UI change.** Add `keymap.js` with the current table; route `app-input.js`, `world-input.js`, `track-editor.js`, `app-pose.js`, `wind-tuning-panel.js` through it. Behaviour identical; add tests that every key in the table is reachable and that contexts don't conflict. Remove the false `N` line.
2. **Generated cheatsheet.** Replace the static Controls tab with output from the registry (still in the current dialog). Prompts read labels from the registry.
3. **Settings schema.** Move the Options page to a schema-driven renderer with one persistence key and a migration from `racer.*`. Fixes the not-persisted toggles. Add reset/defaults.
4. **Window shell + new Game Menu IA.** Shared dialog component (frame, buttons, tabs, footer), new menu order, Data and Diagnostics become sub-pages. CSS-only skin (direction B/C without art). Gamepad/Keyboard focus ring.
5. **Rebinding UI.** Key Bindings window, conflict swap, profiles replace the "Space key" select, `racer.bindings.v1`. Move cockpit/race-start/editor tool keys (the conflict fixes), with a one-time "controls changed" notice.
6. **Settings search + categories** (in the new shell).
7. **WoW art loader.** `ui-art.js`, CSP change, `has-art` skin, sounds, "Use WoW UI art" toggle; CSS fallback verified in smokes.
8. **HUD zone pass.** Zone grid, shared toast/tooltip, race band recolour, optional action bar, HUD scale. Garage and editor adopt the shell.
9. **Later:** pad rebinding, menu pad navigation, touch scale note.

Each step is independently mergeable and keeps the game launchable; 1-3 are pure refactors with visible wins (cheatsheet, persistence).

## 6. Open questions

1. Is changing default keys acceptable (cockpit `F`->`H`, race start `R`, Fly/Drive `Tab`), or do you want defaults frozen and the changes opt-in via a "Classic" preset?
2. Direction A, B or C? (Recommendation: C.) Should the red WoW button be a theme option?
3. OK to add `img-src/font-src blob:` to the CSP for the art loader?
4. Are Handling and Wind tuning player-facing or developer-only (hide behind `?debug`)?
5. Should Diagnostics and Data stay reachable from the in-game menu, or move to the welcome/boot screen?
6. How far should gamepad support go: read-only mapping display, or full menu navigation and rebinding?
7. Do you want the optional action bar of shortcuts, or is `Esc · Menu` plus F1 enough?
8. Which sounds matter: only the ones found (click, tab, open/close, error), or extend from the SWE1R set?

## 7. Mock notes

`ui-pass-mock.html` is self-contained (no build). Top bar: screen (Esc menu, Settings with tabs and search, Key bindings with live rebinding and conflict swap, generated Cheatsheet, HUD layout), direction A/B/C, and "WoW art" on/off. Query string for screenshots: `?dir=C&view=keys&art=0`. If `./ui-assets/` is absent the page shows the CSS-only fallback and a badge says so.
