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
Assert-Source $ordinary '(?s)if \(racerMovement && !_player->CanUseFlatsRacer\(\)\).*?StopFlatsRacer\(\);.*?return;.*?ValidateFlatsRacerMovement' 'Invalid live state must revoke before movement validation.'
Assert-Source $ordinary '(?s)if \(racerMovement && !_player->ValidateFlatsRacerMovement\(packet.movementInfo\)\).*?StopFlatsRacer\(\);.*?return;' 'Invalid racer movement must be rejected and corrected.'
Assert-Source $ordinary '(?s)if \(pPlayerMover && !racerMovement\)\s*\{\s*if \(\(m_moveRejectTime = _player->GetCheatData\(\)->HandleFlagTests.*?HandlePositionTests.*?return;' 'Normal movement must retain both stock anticheat checks and rejection.'

$player = Read-Source 'src\game\Objects\Player.cpp'
Assert-Source $player '(?s)float const safeZ = ground \+ FlatsRacer::ResetGroundClearance;.*?MapManager::IsValidMapCoord\(GetMapId\(\), GetPositionX\(\), GetPositionY\(\), safeZ, GetOrientation\(\)\).*?m_flatsRacerStartMap = GetMapId\(\);.*?m_flatsRacerStart.z = safeZ;' 'Saved correction anchor must include ground clearance, engine validation and the original grant map.'
Assert-Source $player '(?s)bool Player::StartFlatsRacer.*?m_flatsRacerActive \|\| IsMounted\(\).*?sCreatureDisplayInfoStore.LookupEntry\(displayId\).*?Mount\(displayId\) != MOUNTRESULT_OK.*?GetUInt32Value\(UNIT_FIELD_MOUNTDISPLAYID\) != displayId.*?m_flatsRacerActive = true;.*?SendSysMessage\("FLATS_RACER ON"\)' 'Activation must preserve existing mounts, validate display, and mount before granting.'
Assert-Source $player '(?s)bool Player::CanUseFlatsRacer.*?GetUInt32Value\(UNIT_FIELD_MOUNTDISPLAYID\) == m_flatsRacerMountDisplayId.*?!m_flatsRacerActive \|\| IsMounted\(\)' 'Active eligibility must require the owned mount.'
Assert-Source $player '(?s)bool Player::StopFlatsRacer.*?m_flatsRacerActive = false;.*?GetUInt32Value\(UNIT_FIELD_MOUNTDISPLAYID\) == m_flatsRacerMountDisplayId\)\s*Unmount\(\);.*?m_flatsRacerMountDisplayId = 0;' 'Revocation must unmount only its owned display without recursion.'
Assert-Source $player '(?s)UnitDismountResult Player::Unmount.*?SendDismountResult\(DISMOUNTRESULT_OK\);\s*if \(m_flatsRacerActive\)\s*StopFlatsRacer\(\);' 'External dismount must revoke the racer grant.'
Assert-Source $player '(?s)bool Player::ResetFlatsRacer.*?if \(!ReturnToFlatsRacerStart\(\)\).*?StopFlatsRacer\(false\);.*?return false;.*?SendSysMessage\("FLATS_RACER RESET"\)' 'Failed reset must revoke and release the mount instead of reporting success.'
Assert-Source $player '(?s)bool Player::CanUseFlatsRacer.*?CONFIG_BOOL_CUSTOM_FLATS_RACER.*?GetRemoteAddress.*?IsAlive\(\) && !IsInCombat\(\).*?!IsTaxiFlying\(\) && !GetTransport\(\)' 'Eligibility must enforce config, session, and live state.'
$validation = $player.Substring($player.IndexOf('bool Player::ValidateFlatsRacerMovement'))
$validation = $validation.Substring(0, $validation.IndexOf('void Player::Update'))
Assert-Source $validation '(?s)if \(!CanUseFlatsRacer\(\).*?!FlatsRacer::PlainMovement.*?return false;.*?FlatsRacerGroundError\(GetMap\(\), p, ground\).*?movement rejected: %s.*?return false;.*?return true;' 'Custom movement must validate live state and plain movement, and report actionable world/terrain rejections without a speed limit.'
Assert-Source $player '(?s)static char const\* FlatsRacerGroundError.*?!map->IsContinent\(\).*?FlatsRacer::WorldMap.*?FlatsRacer::FinitePosition.*?MapManager::IsValidMapCoord.*?MapManager::ExistMapAndVMap.*?GetHeight\(p.x, p.y, p.z, true, MAX_FALL_DISTANCE\).*?ground <= INVALID_HEIGHT.*?FlatsRacer::AboveGround.*?IsOutdoors' 'World endpoints must use engine coordinates, available tiles, full-depth ground, the ground sentinel and outdoor checks.'
Assert-Source $player '(?s)bool Player::StartFlatsRacer.*?FlatsRacerGroundError\(GetMap\(\), GetPosition\(\), ground\).*?fabs\(GetPositionZ\(\) - ground\) > 0.75f' 'Activation must remain grounded on validated outdoor terrain.'
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
Assert-Source $player '(?s)void Player::SetDeathState.*?if \(s != ALIVE && m_flatsRacerActive\)\s*StopFlatsRacer\(\);' 'Death must revoke the grant.'
Assert-Source $player '(?s)bool Player::TeleportTo.*?if \(m_flatsRacerActive\)\s*StopFlatsRacer\(false\);' 'External teleports must revoke without recursive correction.'
Assert-Source $player '(?s)void Player::RemoveFromWorld.*?if \(m_flatsRacerActive\)\s*StopFlatsRacer\(false\);' 'World removal must revoke.'
Assert-Source $player '(?s)bool Player::ReturnToFlatsRacerStart.*?SetMovementFlags\(MOVEFLAG_NONE\).*?ClearTransportData.*?TELE_TO_NOT_LEAVE_COMBAT.*?KickPlayer' 'Safe correction must clear motion, preserve combat, and fail explicitly.'
Assert-Source (Read-Source 'src\game\Objects\Unit.cpp') '(?s)SetFlag\(UNIT_FIELD_FLAGS, UNIT_FLAG_IN_COMBAT\);\s*if \(Player\* player = ToPlayer\(\)\)\s*if \(player->IsFlatsRacerActive\(\)\)\s*player->StopFlatsRacer\(\);' 'Combat entry must immediately revoke.'
Assert-Source (Read-Source 'src\game\Server\WorldSession.cpp') '(?s)void WorldSession::LogoutPlayer.*?if \(_player->IsFlatsRacerActive\(\)\)\s*_player->StopFlatsRacer\(inWorld\);.*?_player->SaveToDB' 'Logout must revoke and correct before position persistence.'
Assert-Source (Read-Source 'src\game\Chat\Chat.cpp') '"flatsracer",\s*SEC_PLAYER,\s*false,\s*&ChatHandler::HandleFlatsRacerCommand' 'Command must allow ordinary players without console access.'
Assert-Source (Read-Source 'src\game\Chat\Chat.cpp') '(?s)CONFIG_BOOL_PLAYER_COMMANDS.*?strncmp\(text \+ 1, "flatsracer", 10\).*?FlatsRacer::Authorized.*?if \(!racerCommand\).*?WasNotHandled' 'Disabled general player commands must only admit the exact locally authorized racer command.'
Assert-Source (Read-Source 'src\game\Commands\MiscCommands.cpp') '(?s)HandleFlatsRacerCommand.*?if \(!m_session \|\| !m_session->GetPlayer\(\)\)' 'Command must require an in-game player without account elevation.'
Assert-Source (Read-Source 'src\game\World.cpp') 'setConfig\(CONFIG_BOOL_CUSTOM_FLATS_RACER, "CustomFlatsRacer.Enable", FlatsRacer::DefaultEnabled\)' 'Config must use the tested disabled default.'
Assert-Source $player '(?s)uint32 const displayId = FlatsRacer::MountDisplayId;\s*if \(!sCreatureDisplayInfoStore.LookupEntry\(displayId\)\)' 'The verified fixed racer display must still exist in server data.'
Assert-Source (Read-Source 'src\mangosd\mangosd.conf.dist.in') 'CustomFlatsRacer.Enable = false' 'Distributed configuration must remain disabled.'
Write-Output 'Flats racer structural integration assertions passed.'
