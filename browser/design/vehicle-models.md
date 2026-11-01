# Vehicle-like models in WoW 1.12.1 Data (Part 2 survey)

Facts only. Source: the user's local 1.12.1 `Data` (`model`, `dbc`, `patch`, `patch-2` MPQs), read at runtime and never committed.
Model lists: `CreatureModelData.dbc` (field 2), `GameObjectDisplayInfo.dbc` (field 1), `SpellVisualEffectName.dbc` (field 2); 2773 distinct model paths in total. The `(listfile)` is almost empty, so paths not referenced by those DBCs were probed by name only.

Animation ids (`AnimationData.dbc`): 0 Stand, 1 Death, 4 Walk, 5 Run, 9 CombatWound, 10 CombatCritical, 16 AttackUnarmed, 32 SpellCast, 53 SpellCastDirected, 124 ChannelCastDirected, 130 CreatureSpecial, 135 Fly, 144 InFlight, 146 Close, 147 Closed, 148 Open, 150 Destroy, 153 Custom0, 157 Despawn, 158 Hold, 162 ShipStart, 163 ShipMoving, 164 ShipStop.

Size = M2 bounding box extent (x, y, z) in model units. "Craft bake" / "Actor" = result of the browser's own `SceneModel.craft` (static Stand pose, what a garage skin needs) and `SceneActor` (re-posing Stand `0` / Walk `4`, used for the animated skin) on that model with no skins applied. Clip lengths are in seconds.


## Ranking by garage value

| # | Model | Why |
|---|-------|-----|
| 1 | `Creature\GnomeRocketCar\GnomeRocketCar` (display 2490) | Implemented as the "Gnome rocket car" skin. Wheeled cart, Stand + Walk clips. |
| 2 | `Creature\GoblinRocketCar\GoblinRocketCar` (display 10318) | The existing Rocket. Same clip set (0, 4, 5). |
| 3 | `Creature\FlyingMachineCreature\FlyingMachineCreature` (display 8011) | Gnomish flying machine; hovering body, craft bake ok, no Walk. |
| 4 | `Creature\Object\Cannon`, `Creature\GolemStone\GolemCannonStone` | Craft bake ok; wheeled/gun carriage, little locomotion. |
| 5 | `Creature\GnomeSpidertank\GnomePounder`, `GnomeBot`, `GnomeBomBot` | Craft bake ok; walkers, Walk clip 1.0–1.33 s. |
| 6 | `Creature\SilithidTank\SilithidTank` | Craft bake ok; Walk clip, insectoid rather than a vehicle. |
| 7 | `Creature\GolemHarvest*`, `GolemStone`, `FleshGolem` | Craft bake ok; humanoid golems. |
| 8 | `Creature\Goblin\GoblinShredder`, `Creature\SteamTonk\SteamTonk`, `GnomeSpidertank\GnomeSpiderTank`, `MechaStrider\*` | Vehicle-like, but craft bake fails (see Blockers). |
| 9 | Static doodads (catapult, rowboat, carts, mine carts) | Craft bake ok but only Stand, no motion. |
| 10 | WMO transports (ships, zeppelins) | Not M2; no craft path. |

## Dwarven tanks

- No dwarven tank model exists in this Data. Searched all 2773 model paths for `tank`; matches are only `Creature\SilithidTank\SilithidTank`, `Creature\SilithidTankBoss\*`, `Creature\SteamTonk\SteamTonk`, `Creature\GnomeSpidertank\*`, `World\KhazModan\Ironforge\PassiveDoodads\SteamTank\IronForgeSteamTank`. Probed `Creature\DwarvenTank\DwarvenTank.m2`, `Creature\Tank\Tank.m2` and `World\Generic\Dwarf\Passive Doodads\DwarvenTank\DwarvenTank.m2`: absent.
- `Creature\SteamTonk\SteamTonk.m2` (displays 15381, 15382): anims 0,1,4,5,9; 36 bones, 606 vertices, 2 textures; size 1.88 x 1.70 x 1.72; Stand 0.33 s, Walk 2.67 s, authored move speed 3.47. Vehicle-like: high (tracked toy tank). Blocker: craft bake fails, `Static Stand bake does not support required billboard/parent overrides or global bone tracks`; `SceneActor` works.
- `Creature\SilithidTank\SilithidTank.m2` (displays 91, 481, 1561, 3195): anims 0,1,4,5,9,10,16; 54 bones, 441 vertices, no texture slots in the header (skins from the display row); size 8.70 x 6.49 x 4.19. Vehicle-like: low (a silithid, tank only by name). Craft bake ok (2214 indices); Actor ok (Stand 1.33 s, Walk 1.00 s). No blocker.
- `World\KhazModan\Ironforge\PassiveDoodads\SteamTank\IronForgeSteamTank.m2`: anim 0 only; 2 bones, 1697 vertices; size 14.59 x 10.40 x 8.82. Vehicle-like: none (scenery boiler).

## Night elf glaive thrower

- No glaive thrower model exists in this Data. Searched all model paths for `glaive`, `thrower`, `night.?elf`, `nelf`, `kaldorei`: no vehicle matches. Probed `Creature\GlaiveThrower\GlaiveThrower.m2`, `Creature\NightElfGlaiveThrower\NightElfGlaiveThrower.m2`, `World\Generic\NightElf\Passive Doodads\GlaiveThrower\GlaiveThrower.m2`, `World\Kalimdor\Ashenvale\PassiveDoodads\GlaiveThrower\GlaiveThrower.m2`: absent.
- Blocker: the model is not in 1.12.1 client data.

## Siege machines

- `World\Azeroth\Elwynn\PassiveDoodads\Catapult\Catapult.m2`: anim 0; 1 bone, 677 vertices; size 9.14 x 9.84 x 3.40. Vehicle-like: medium (wheeled frame, static). Craft bake ok (1362 indices); Actor ok (Stand 3.33 s, no Walk). Blocker: no motion clips.
- `Creature\Object\Cannon.m2` (displays 3127, 3146, 10753): anims 0,1,4,5,9,10,32; 18 bones, 328 vertices; size 10.79 x 9.66 x 7.24. Vehicle-like: medium. Craft bake ok (762 indices); Actor ok (Stand 0.03 s, Walk 2.40 s).
- `World\Goober\G_Cannon01.m2`: anims 0,153; 10 bones, 236 vertices; size 11.37 x 4.47 x 4.23. `World\ENVIRONMENT\DOODAD\Carnival\Carni_Cannon.m2`: anims 0,153; 779 vertices; size 10.57 x 8.06 x 6.53. Both are gameobject doodads with a single custom clip, vehicle-like: low.
- `World\Goober\G_bombwagon.m2`: anims 147,148,150 (Closed, Open, Destroy); 16 bones, 1276 vertices, 6 textures; size 6.01 x 4.50 x 4.54. Vehicle-like: medium (wagon). Blocker: no Stand sequence; craft bake fails `Model has no authored Stand sequence`; Actor fails `Actor has no Stand clip`.
- `Creature\GolemStone\GolemCannonStone.m2`: anims 0,1,4,5,9,10,16,53,124; 45 bones, 980 vertices; size 6.79 x 4.60 x 4.91. Craft bake ok (3030 indices); Actor ok (Stand 2.67 s, Walk 2.00 s). Vehicle-like: low (golem with a cannon).
- No ram, ballista, trebuchet or demolisher model found by name. `Creature\Ram\*` are the riding ram mounts (see vehicle-like creatures).

## Zeppelins and boats

- Transports are WMOs, not M2s; the browser's craft path loads M2 only:
  - `World\wmo\transports\transport_ship\transportship.wmo`: 4 groups, 143 doodads, bounding box 103.1 x 52.9 x 66.4.
  - `World\wmo\transports\passengership\transportship_A.wmo`: 4 groups, 142 doodads, bounding box 103.1 x 52.9 x 66.4.
  - `World\wmo\transports\transport_zeppelin\transport_zeppelin.wmo`: 1 group, 1 doodad, bounding box 77.8 x 37.9 x 55.8.
  - `World\wmo\transports\zeppelin\transport_zeppelin.wmo`: 1 group, 0 doodads, bounding box 77.8 x 45.1 x 56.5.
  - Vehicle-like: high as objects, but 40x to 100x a racer; the ship and zeppelin motion clips (162 ShipStart, 163 ShipMoving, 164 ShipStop) live on the transport doodads, not on these WMOs. Blocker: WMO path and scale.
- `World\Azeroth\RedRidge\PassiveDoodads\RowBoat\RowBoat01.m2`: anim 0; 1 bone, 240 vertices; size 9.67 x 4.29 x 2.89. Craft bake ok (546 indices); Actor ok (Stand 3.33 s). Vehicle-like: medium. Blocker: static, no motion.
- `World\Azeroth\Westfall\PassiveDoodads\WreckedRowBoat\WreckedRowBoat.m2`: anim 0; 507 vertices; size 9.49 x 4.01 x 4.28. Wreck, no motion.
- `World\Goober\G_BELLSHIP.m2`: anims 0,153; 5 bones, 338 vertices; size 5.63 x 7.17 x 4.68. A bell, not a ship.
- `World\Goober\G_FlyingMachine.m2`: anims 0,153,157; 18 bones, 691 vertices, 1 texture; size 25.21 cube. Craft bake ok (2448 indices); Actor ok (Stand 0.27 s). Vehicle-like: medium (gnome flying machine object). Bounding box looks inflated by an emitter.
- `Creature\FlyingMachineCreature\FlyingMachineCreature.m2` (display 8011): anims 0,5,135 (Stand, Run, Fly); 40 bones, 1628 vertices, 8 textures; size 12.97 cube (inflated bounds; baked mesh extents approx 4.9 x 6.0 x 3.8). Vehicle-like: high (a gnome flying machine). Craft bake ok (5862 indices); Actor ok (Stand 1.07 s, no Walk clip). No blocker for a static or Stand-animated skin; `Fly` (135) is not re-posed by `SceneActor`.
- `World\Generic\Gnome\Passive Doodads\Subway\SubwayCar.m2` and `GnomeHutElevator.m2`: anims 0,162,163,164; SubwayCar 5 bones, 2699 vertices, size 18.36 x 11.36 x 17.39; elevator size 3.91 x 4.11 x 16.37. Craft bake ok (SubwayCar 7734 indices); Actor Stand 0.03 s. Vehicle-like: medium (rail car). Blocker: ship clips 162-164 are not re-posed.
- No other boat, ship, galleon, canoe, raft or zeppelin M2 in the model lists.

## Mechanical bosses

- `Creature\SilithidTankBoss\SilithidTankBoss.m2`: anims 0,1,4,5,9,10,11,12,16,25,51,53,55,57,124,130; 48 bones, 1013 vertices; size 18.60 x 16.04 x 13.62. Craft bake ok (3324 indices); Actor ok (Stand 2.03 s, Walk 1.47 s, no authored move speed). Vehicle-like: low. `SilithidTankBoss_Damaged.m2`: 81 bones, 1840 vertices; size 49.44 x 49.54 x 53.92; craft bake fails (billboard/parent overrides or global bone tracks).
- `Creature\GolemHarvestStage2\GolemHarvestStage2.m2` (displays 72, 149, 953, 1097, 1159, 5299): anims 0,1,4,5,9,10,14,16,21; 53 bones, 1229 vertices; size 7.96 x 5.69 x 4.64. Craft bake ok (2544 indices); Actor ok (Stand 1.50 s, Walk 1.00 s, move speed 2.50). Vehicle-like: low.
- `Creature\GnomeSpidertank\GnomeBot.m2`: anims 0,1,4,5,9,10,14,16,21; 61 bones, 2905 vertices; size 14.09 x 14.09 x 16.13. Craft bake ok (14868 indices); Actor ok (Stand 1.50 s, Walk 1.00 s). Vehicle-like: low.
- `Creature\GnomeSpidertank\GnomePounder.m2`: anims 0,1,4,5,8,16,130; 104 bones, 3902 vertices; size 8.71 x 7.00 x 7.74. Craft bake ok (19749 indices); Actor ok (Stand 3.33 s, Walk 1.33 s). Vehicle-like: medium.
- `Creature\GnomeSpidertank\GnomeSpiderTank.m2` (displays 5926, 6890, 6891, 6915): anims 0,1,4,5,9,10,16,32; 112 bones, 1997 vertices; size 7.37 cube. Vehicle-like: high (walker chassis). Blocker: craft bake fails (billboard/parent overrides or global bone tracks); Actor ok (Stand 0.93 s, Walk 0.93 s).
- `Creature\GnomeSpidertank\GnomeAlertBot.m2` (anims 0,1,4,5,9,10,14,16,21; size 8.47 x 5.61 x 5.19): craft bake fails; Actor ok. `GnomeBomBot.m2` (size 3.56 x 3.04 x 4.58): craft ok (9936 indices); Actor ok.
- `Creature\GolemStone\GolemStone.m2`, `Creature\FleshGolem\FleshGolem.m2`, `Creature\BoneGolem\BoneGolem.m2`: humanoid golems, vehicle-like: none. Craft bake ok for the first two, fails for BoneGolem.
- `World\Generic\Gnome\ActiveDoodads\GnomeMachine\GnomeMachine.m2`: anims 0,153; 3416 vertices, 18 textures; size 18.92 x 19.29 x 18.32. Machines, not mobile.

## Vehicle-like creatures

- `Creature\GnomeRocketCar\GnomeRocketCar.m2` (display 2490): anims 0,4,5,130; 87 bones, 1606 vertices, 4 textures; size 8.95 x 5.63 x 6.75; Stand 3.30 s, Walk 1.67 s, no authored move speed. Vehicle-like: high (gnome in a wheeled cart under a riveted steel tower with a copper funnel). Craft bake ok (4923 indices); Actor vertex order identical to the craft bake. No blocker; implemented as a skin.
- `Creature\GoblinRocketCar\GoblinRocketCar.m2` (display 10318): anims 0,4,5; 102 bones, 1652 vertices, 1 texture; size 9.48 x 4.98 x 2.46; Stand 3.33 s, Walk 2.00 s, move speed 2.50. Vehicle-like: high. Craft bake ok (4698 indices).
- `Creature\Goblin\GoblinShredder.m2` (displays 1269, 1303, 2280): anims 0,1,4,5,8,13,16,37,38,39,42,130; 114 bones, 2145 vertices, 2 textures; size 8.93 x 8.79 x 7.52. Vehicle-like: high (goblin-piloted machine). Blocker: craft bake fails (billboard/parent overrides or global bone tracks); Actor ok (Stand 3.33 s, Walk 1.33 s).
- `World\Generic\Goblin\PassiveDoodads\GoblinShredderSuit\GoblinShredderSuit02.m2`: anim 0; 1073 vertices; size 3.34 x 6.16 x 5.38. Static prop.
- `Creature\MechaStrider\MechaStrider.m2`, `GnomeMechaStrider.m2`, `PvPMechaStrider.m2`: anims 0,1,4,5,9,10,11,12,13,16,37,38,39(,94); 57-59 bones, 1285-2266 vertices; sizes 6.47 x 4.28 x 4.33, 5.32 x 4.50 x 4.50, 6.71 x 4.77 x 5.16. Vehicle-like: medium (mechanical mount). Blocker: craft bake fails (MechaStrider and PvP: billboard/parent overrides or global bone tracks; GnomeMechaStrider: `Invalid posed Stand vertex`); Actor ok (Stand 2.00 s, Walk 1.33 s).
- `Creature\Ram\Ram.m2`, `RidingRam.m2`, `PVPRidingRam.m2`: anims 0,1,4,5,9,10,11,12,13,16,37-42,94; 58-61 bones, 957-1140 vertices; size about 4.9 x 4.6 x 5.2. Vehicle-like: low (animal mount). Blocker: craft bake fails for Ram and RidingRam (billboard/parent overrides or global bone tracks).
- `World\Azeroth\Elwynn\PassiveDoodads\MineCart\ElwynnMineCart.m2`: anim 0; 417 vertices; size 7.70 x 5.85 x 3.32. Craft bake ok (714 indices); Actor Stand 3.33 s. `World\Generic\Dwarf\Passive Doodads\ExcavationWaterWagon\ExcavationWaterWagon.m2`: anim 0; 427 vertices; size 7.41 x 4.25 x 3.98. `World\Azeroth\Westfall\PassiveDoodads\Westfall Wagon\WestfallWagon01.m2`: anim 0; 216 vertices; size 9.12 x 5.03 x 2.57. Vehicle-like: medium (wheeled, static). Blocker: no motion clips.
