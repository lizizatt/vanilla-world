$ErrorActionPreference = 'Stop'
$server = Split-Path $PSScriptRoot -Parent

function Read-Source($path) {
    Get-Content -Raw (Join-Path $server $path)
}

function Assert-Source($source, $pattern, $message) {
    if ($source -notmatch $pattern) {
        throw $message
    }
}

# Structural guardrails only; real policy behavior is exercised in FlatsRacerTests.cpp.
$movement = Read-Source 'src\game\Handlers\MovementHandler.cpp'
$ordinary = $movement.Substring($movement.IndexOf('void WorldSession::HandleMovementOpcodes'))
$ordinary = $ordinary.Substring(0, $ordinary.IndexOf('void WorldSession::HandleForceSpeedChangeAckOpcodes'))
Assert-Source $ordinary 'bool const racerMovement = _player->IsFlatsRacerActive\(\)' 'Movement exception must require an explicit per-player grant.'
Assert-Source $ordinary '(?s)if \(racerMovement && !_player->CanUseFlatsRacer\(\)\).*?StopFlatsRacer\(true, "eligibility/control state changed before movement"\);.*?return;.*?ValidateFlatsRacerMovement' 'Invalid live state must revoke with a reason before movement validation.'
Assert-Source $ordinary '(?s)if \(racerMovement && !_player->ValidateFlatsRacerMovement\(packet.movementInfo\)\).*?StopFlatsRacer\(true, "movement validation failed"\);.*?return;' 'Invalid racer movement must be rejected and corrected with a reason.'
Assert-Source $ordinary '(?s)if \(pPlayerMover && !racerMovement\)\s*\{\s*if \(\(m_moveRejectTime = _player->GetCheatData\(\)->HandleFlagTests.*?HandlePositionTests.*?return;' 'Normal movement must retain both stock anticheat checks and rejection.'
Assert-Source $movement '(?s)if \(pMover->m_movementInfo.GetPos\(\).z < -500.0f && !pPlayerMover->IsGameMaster\(\) &&\s*!pPlayerMover->IsFlatsRacerActive\(\)\)' 'Validated racer terrain below -500 must not trigger the stock void teleport; ordinary players must retain it.'

$player = Read-Source 'src\game\Objects\Player.cpp'
Assert-Source $player '(?s)float const safeZ = ground \+ FlatsRacer::ResetGroundClearance;.*?MapManager::IsValidMapCoord\(GetMapId\(\), GetPositionX\(\), GetPositionY\(\), safeZ, GetOrientation\(\)\).*?m_flatsRacerStartMap = GetMapId\(\);.*?m_flatsRacerStart.z = safeZ;' 'Saved correction anchor must include ground clearance, engine validation and the original grant map.'
Assert-Source $player '(?s)bool Player::StartFlatsRacer.*?m_flatsRacerActive \|\| IsMounted\(\).*?sCreatureDisplayInfoStore.LookupEntry\(displayId\).*?Mount\(displayId\) != MOUNTRESULT_OK.*?GetUInt32Value\(UNIT_FIELD_MOUNTDISPLAYID\) != displayId.*?m_flatsRacerActive = true;.*?SendSysMessage\("FLATS_RACER ON"\)' 'Activation must preserve existing mounts, validate display, and mount before granting.'
Assert-Source $player '(?s)bool Player::CanUseFlatsRacer.*?GetUInt32Value\(UNIT_FIELD_MOUNTDISPLAYID\) == m_flatsRacerMountDisplayId.*?!m_flatsRacerActive \|\| IsMounted\(\)' 'Active eligibility must require the owned mount.'
Assert-Source $player '(?s)bool Player::StopFlatsRacer.*?m_flatsRacerActive = false;.*?GetUInt32Value\(UNIT_FIELD_MOUNTDISPLAYID\) == m_flatsRacerMountDisplayId\)\s*Unmount\(\);.*?m_flatsRacerMountDisplayId = 0;' 'Revocation must unmount only its owned display without recursion.'
Assert-Source $player '(?s)UnitDismountResult Player::Unmount.*?SendDismountResult\(DISMOUNTRESULT_OK\);\s*if \(m_flatsRacerActive\)\s*StopFlatsRacer\(true, "external dismount"\);' 'External dismount must revoke the racer grant.'
Assert-Source $player '(?s)bool Player::ResetFlatsRacer.*?if \(!ReturnToFlatsRacerStart\(\)\).*?StopFlatsRacer\(false, "reset correction failed"\);.*?return false;.*?SendSysMessage\("FLATS_RACER RESET"\)' 'Only failed reset must revoke and release the mount instead of reporting success.'
Assert-Source (Read-Source 'src\game\Objects\Player.h') 'StopFlatsRacer\(bool correctPosition = true, char const\* reason = nullptr\)' 'Default and explicit off must not fabricate a revocation reason.'
Assert-Source $player '(?s)bool Player::StopFlatsRacer.*?if \(!m_flatsRacerActive\)\s*return false;\s*if \(reason\).*?PSendSysMessage\("Flats racer stopped: %s%s\.".*?sLog.Player\(GetSession\(\), LOG_MOVEMENT, LOG_LVL_MINIMAL,.*?Flats racer stopped: %s; correct=%u.*?m_flatsRacerActive = false;' 'Automatic stop reasons must go to player and standard movement log once, before unmount/correction, only for an active grant.'
$eligibility = $player.Substring($player.IndexOf('bool Player::CanUseFlatsRacer'))
$eligibility = $eligibility.Substring(0, $eligibility.IndexOf('bool Player::StartFlatsRacer'))
Assert-Source $eligibility '(?s)CONFIG_BOOL_CUSTOM_FLATS_RACER.*?GetRemoteAddress.*?IsInWorld\(\) && IsAlive\(\) && !IsTaxiFlying\(\) && !GetTransport\(\)' 'Eligibility must enforce opt-in, session and alive state without rejecting combat.'
if ($eligibility -match 'IsInCombat|UNIT_FLAG_IN_COMBAT') {
    throw 'Combat alone must not invalidate racer activation, maintenance or reset eligibility.'
}
Assert-Source $player '(?s)bool Player::StartFlatsRacer.*?!CanUseFlatsRacer\(\).*?bool Player::ResetFlatsRacer.*?!CanUseFlatsRacer\(\)' 'Activation and reset must both use the shared combat-permitting eligibility policy.'
Assert-Source $eligibility '(?s)CanFreeMove\(\).*?IsSelfMover\(\) && GetConfirmedMover\(\) == this' 'Racer eligibility must retain control-loss safeguards.'
Assert-Source $eligibility '!HasUnitMovementFlag\(MOVEFLAG_ROOT' 'Racer eligibility must retain root rejection.'
Assert-Source (Read-Source 'src\game\Objects\Unit.h') 'bool CanFreeMove\(\) const \{ return !HasUnitState\(UNIT_STATE_NO_FREE_MOVE\)' 'The ordinary free-movement gate must still reject blocked unit state.'
Assert-Source (Read-Source 'src\game\Objects\UnitDefines.h') 'UNIT_STATE_NO_FREE_MOVE\s*=\s*UNIT_STATE_ROOT \| UNIT_STATE_STUNNED' 'Root and stun must remain free-movement blockers.'
$validation = $player.Substring($player.IndexOf('bool Player::ValidateFlatsRacerMovement'))
$validation = $validation.Substring(0, $validation.IndexOf('void Player::Update'))
Assert-Source $validation '(?s)if \(!CanUseFlatsRacer\(\).*?!FlatsRacer::PlainMovement.*?return false;.*?FlatsRacerGroundError\(GetMap\(\), p, ground, true\).*?movement rejected: %s.*?return false;.*?return true;' 'Custom movement must validate live state and plain movement, and report actionable world/terrain rejections without a speed limit.'
$racerPolicy = $player.Substring($player.IndexOf('static char const* FlatsRacerGroundError'))
$racerPolicy = $racerPolicy.Substring(0, $racerPolicy.IndexOf('void Player::Update'))
Assert-Source $racerPolicy '(?s)static char const\* FlatsRacerGroundError.*?!map->IsContinent\(\).*?FlatsRacer::WorldMap.*?FlatsRacer::FinitePosition.*?MapManager::IsValidMapCoord.*?GridMap::ExistMap\(map->GetId\(\), gx, gy\).*?isMapLoadingEnabled\(\).*?CanLoadMap\(sWorld.GetDataPath\(\) \+ "vmaps", map->GetId\(\), gx, gy, true\).*?GetHeight\(p.x, p.y, p.z, true, MAX_FALL_DISTANCE\).*?ground <= INVALID_HEIGHT.*?FlatsRacer::AboveGround' 'World endpoints must retain continent-only coordinates, real terrain, compatible collision data and full-depth support while allowing empty VMAP tiles.'
if ($racerPolicy -match 'IsOutdoors|IsOutdoor|SPELL_ATTR_ONLY_OUTDOORS|destination is indoors') {
    throw 'Racer activation, ongoing validation and reset anchors must not reject indoor flags on supported continents.'
}
Assert-Source $player '(?s)void Player::CheckAreaExploreAndOutdoor.*?else if \(sWorld.getConfig\(CONFIG_BOOL_VMAP_INDOOR_CHECK\) && !IsGameMaster\(\)\)\s*RemoveAurasWithAttribute\(SPELL_ATTR_ONLY_OUTDOORS\);' 'Ordinary indoor aura checks must remain enabled.'
Assert-Source $player '(?s)void Player::DismountCheck.*?GetAurasByType\(SPELL_AURA_MOUNTED\).*?mountSpell.CheckCast\(true\).*?SPELL_FAILED_NO_MOUNTS_ALLOWED.*?RemoveSpellsCausingAura\(SPELL_AURA_MOUNTED\);.*?Unmount\(true\);' 'Ordinary mount-spell restrictions must remain unchanged; the racer uses direct display mounting.'
Assert-Source $player '(?s)if \(moving\).*?getLiquidStatus\(p.x, p.y, p.z,\s*MAP_LIQUID_TYPE_WATER \| MAP_LIQUID_TYPE_OCEAN, &liquid\) != LIQUID_MAP_NO_WATER.*?FlatsRacer::AboveGround\(p.z, liquid.level, INVALID_HEIGHT, FlatsRacer::MovementGroundTolerance\) &&\s*liquid.level > ground.*?ground = liquid.level;.*?moving \? FlatsRacer::MovementGroundTolerance : 0.75f' 'Only moving racer endpoints may use bounded spring slack and water/ocean support near or below the pose, preserving higher bridge ground.'
$mapTree = Read-Source 'src\game\vmap\MapTree.cpp'
Assert-Source (Read-Source 'src\game\vmap\MapTree.h') 'CanLoadMap\([^;]*bool allowEmptyTile = false\)' 'Normal VMAP availability checks must remain strict by default.'
Assert-Source $mapTree '(?s)bool StaticMapTree::CanLoadMap.*?if \(!rf\)\s*return false;.*?readChunk\(rf, chunk, VMAP_MAGIC, 8\).*?if \(tiled\).*?if \(!tf\)\s*(?://[^\n]*\n\s*)*success = allowEmptyTile && errno == ENOENT;.*?readChunk\(tf, chunk, VMAP_MAGIC, 8\).*?success = false;' 'Empty tile opt-in must not accept missing/invalid trees, incompatible existing tiles or non-ENOENT errors.'
Assert-Source (Read-Source 'src\game\vmap\VMapManager2.cpp') 'return StaticMapTree::CanLoadMap\(std::string\(pBasePath\), pMapId, x, y\);' 'Normal VMAP callers must not opt into the racer exception.'
Assert-Source $player '(?s)bool Player::StartFlatsRacer.*?FlatsRacerGroundError\(GetMap\(\), GetPosition\(\), ground\).*?fabs\(GetPositionZ\(\) - ground\) > 0.75f' 'Activation must remain grounded on validated terrain/collision support, indoors or outdoors.'
Assert-Source $player '(?s)bool Player::ReturnToFlatsRacerStart.*?GetMapId\(\) == m_flatsRacerStartMap.*?FlatsRacerGroundError\(GetMap\(\), m_flatsRacerStart, ground\).*?fabs\(m_flatsRacerStart.z - ground\) > 0.75f.*?KickPlayer.*?TeleportTo\(m_flatsRacerStartMap, m_flatsRacerStart.x, m_flatsRacerStart.y, m_flatsRacerStart.z' 'Reset/off must revalidate and return to the immutable grant anchor and map, failing closed if unavailable.'
Assert-Source $player '(?s)bool Player::CanUseFlatsRacer.*?!m_flatsRacerActive \|\| GetMapId\(\) == m_flatsRacerStartMap' 'A grant must not survive an unexpected map change.'
if ([regex]::Matches($player, 'm_flatsRacerStartMap\s*=').Count -ne 1 -or
    [regex]::Matches($player, 'm_flatsRacerStart\.[xyzo]\s*=').Count -ne 4) {
    throw 'Only activation may assign the original grant anchor/map; zone changes must not replace it.'
}
if ($validation -match 'GetAreaId|OnTrack|ground \+ 6' -or (Read-Source 'src\game\Objects\FlatsRacer.h') -match 'InBounds|OnTrack|6500|5700|4500|3300|ground \+ 6') {
    throw 'World exploration must not retain Flats rectangles, areas or arbitrary maximum hover/hop altitude.'
}
if ($validation -match 'WorldTimer|stime|MotionBudget|Consume' -or $player -match 'm_flatsRacerBudget') {
    throw 'Client-authoritative racer movement must not retain a time or displacement budget.'
}
Assert-Source $player '(?s)bool Player::CanUseFlatsRacer.*?IsInWorld\(\).*?!IsLaunched\(\) && CanFreeMove\(\) && !HasPendingSplineDone\(\).*?movespline->Finalized\(\) && IsSelfMover\(\) && GetConfirmedMover\(\) == this.*?!HasUnitMovementFlag.*?FlatsRacer::FinitePosition.*?MapManager::IsValidMapCoord' 'Invalid control, spline, movement or current-position state must still reject the custom path.'
Assert-Source $player '(?s)void Player::SetDeathState.*?if \(s != ALIVE && m_flatsRacerActive\)\s*StopFlatsRacer\(true, "death"\);' 'Death must revoke the grant.'
Assert-Source $player '(?s)bool Player::TeleportTo.*?if \(m_flatsRacerActive\)\s*StopFlatsRacer\(false, "external teleport"\);' 'External teleports must revoke without recursive correction.'
Assert-Source $player '(?s)void Player::RemoveFromWorld.*?if \(m_flatsRacerActive\)\s*StopFlatsRacer\(false, "world removal"\);' 'World removal must revoke.'
Assert-Source $player '(?s)bool Player::ReturnToFlatsRacerStart.*?SetMovementFlags\(MOVEFLAG_NONE\).*?ClearTransportData.*?TELE_TO_NOT_LEAVE_COMBAT.*?KickPlayer' 'Safe correction must clear motion, preserve combat, and fail explicitly.'
Assert-Source (Read-Source 'src\game\Objects\Unit.cpp') '(?s)void Unit::SetInCombatState.*?SetFlag\(UNIT_FIELD_FLAGS, UNIT_FLAG_IN_COMBAT\);\s*if \(IsCharmed\(\)' 'Combat entry must set normal combat state without revoking racer mode.'
Assert-Source (Read-Source 'src\game\Server\WorldSession.cpp') '(?s)void WorldSession::LogoutPlayer.*?if \(_player->IsFlatsRacerActive\(\)\)\s*_player->StopFlatsRacer\(inWorld, "logout"\);.*?_player->SaveToDB' 'Logout must revoke and correct before position persistence.'
foreach ($path in @('src\game\Objects\Player.cpp', 'src\game\Objects\Unit.cpp', 'src\game\Handlers\MovementHandler.cpp', 'src\game\Server\WorldSession.cpp')) {
    foreach ($call in [regex]::Matches((Read-Source $path), 'StopFlatsRacer\([^;\r\n]*\);')) {
        Assert-Source $call.Value '^StopFlatsRacer\((?:true|false|inWorld), "[^"]+"\);$' "Automatic racer stop lacks an explicit reason: $path $($call.Value)"
    }
}
foreach ($reason in @('speed-change acknowledgement', 'movement-flag acknowledgement', 'root/unroot acknowledgement', 'knockback acknowledgement', 'spline-completion acknowledgement', 'inactive-mover movement')) {
    Assert-Source $movement ([regex]::Escape("StopFlatsRacer(true, `"$reason`");")) "Movement revocation reason is missing: $reason"
}
Assert-Source (Read-Source 'src\game\Chat\Chat.cpp') '"flatsracer",\s*SEC_PLAYER,\s*false,\s*&ChatHandler::HandleFlatsRacerCommand' 'Command must allow ordinary players without console access.'
Assert-Source (Read-Source 'src\game\Chat\Chat.cpp') '(?s)CONFIG_BOOL_PLAYER_COMMANDS.*?strncmp\(text \+ 1, "flatsracer", 10\).*?FlatsRacer::Authorized.*?if \(!racerCommand\).*?WasNotHandled' 'Disabled general player commands must only admit the exact locally authorized racer command.'
Assert-Source (Read-Source 'src\game\Commands\MiscCommands.cpp') '(?s)HandleFlatsRacerCommand.*?if \(!m_session \|\| !m_session->GetPlayer\(\)\)' 'Command must require an in-game player without account elevation.'
$misc = Read-Source 'src\game\Commands\MiscCommands.cpp'
Assert-Source $misc '(?s)if \(action == "off"\)\s*(?://[^\n]*\n\s*)*success = player->StopFlatsRacer\(false\);' 'A plain ".flatsracer off" dismount must not teleport the player back to the saved start; only "reset" may correct position.'
if ($misc -match '(?s)if \(action == "off"\)\s*(?://[^\n]*\n\s*)*success = player->StopFlatsRacer\(\);') {
    throw 'Regression: ".flatsracer off" reverted to the default correcting StopFlatsRacer() overload.'
}
Assert-Source (Read-Source 'src\game\World.cpp') 'setConfig\(CONFIG_BOOL_CUSTOM_FLATS_RACER, "CustomFlatsRacer.Enable", FlatsRacer::DefaultEnabled\)' 'Config must use the tested disabled default.'
Assert-Source $player '(?s)uint32 const displayId = FlatsRacer::MountDisplayId;\s*if \(!sCreatureDisplayInfoStore.LookupEntry\(displayId\)\)' 'The verified fixed racer display must still exist in server data.'
Assert-Source (Read-Source 'src\mangosd\mangosd.conf.dist.in') 'CustomFlatsRacer.Enable = false' 'Distributed configuration must remain disabled.'
Write-Output 'Flats racer structural integration assertions passed.'
