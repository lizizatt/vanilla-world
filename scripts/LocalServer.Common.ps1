$ErrorActionPreference = 'Stop'
$Root = Split-Path $PSScriptRoot -Parent
$Runtime = Join-Path $Root 'runtime'
$DatabaseBin = Join-Path $Runtime 'tools\mariadb-10.11.15-winx64\bin'
$AdminOptions = Join-Path $Runtime 'admin.ini'

function Write-LocalFile([string]$Path, [string]$Text) {
    [IO.File]::WriteAllText($Path, $Text, (New-Object Text.UTF8Encoding $false))
}

function Assert-LocalData([switch]$WithMovementMaps) {
    $patterns = @('maps\*.map', '5875\dbc\*.dbc', 'vmaps\*.vmtree', 'vmaps\*.vmtile')
    if ($WithMovementMaps) { $patterns += 'mmaps\*.mmap', 'mmaps\*.mmtile' }
    foreach ($pattern in $patterns) {
        if (!(Get-ChildItem "$Runtime\data\$pattern" -File | Select-Object -First 1)) {
            throw "Extraction produced no $pattern files."
        }
    }
}

function Invoke-LocalSql([string]$Sql) {
    $Sql | & "$DatabaseBin\mariadb.exe" "--defaults-file=$AdminOptions" --batch --skip-column-names `
        --abort-source-on-error --max-allowed-packet=128M --default-character-set=utf8
    if ($LASTEXITCODE) { throw "Database command failed ($LASTEXITCODE)." }
}

function Start-LocalDatabase {
    if (Get-NetTCPConnection -State Listen -LocalPort 3307 -ErrorAction SilentlyContinue) {
        throw 'Port 3307 is already occupied; no existing database will be reused or stopped.'
    }
    Start-Process "$DatabaseBin\mariadbd.exe" -ArgumentList @(
        "--defaults-file=`"$Runtime\database.ini`"", '--console'
    ) -WorkingDirectory $Runtime -PassThru -NoNewWindow `
        -RedirectStandardOutput "$Runtime\logs\database.stdout.log" `
        -RedirectStandardError "$Runtime\logs\database.stderr.log"
}

function Wait-LocalDatabase($Process) {
    for ($i = 0; $i -lt 90; $i++) {
        if ($Process.HasExited) { throw 'Database exited; inspect runtime\logs\database.stderr.log.' }
        & $env:ComSpec /d /c "`"$DatabaseBin\mariadb-admin.exe`" `"--defaults-file=$AdminOptions`" ping --silent >nul 2>&1"
        if ($LASTEXITCODE -eq 0) { return }
        Start-Sleep 1
    }
    throw 'Database readiness timed out.'
}

function Stop-LocalDatabase($Process) {
    if ($Process -and !$Process.HasExited) {
        & $env:ComSpec /d /c "`"$DatabaseBin\mariadb-admin.exe`" `"--defaults-file=$AdminOptions`" shutdown > `"$Runtime\logs\database-shutdown.log`" 2>&1"
        if ($LASTEXITCODE) { Write-Warning 'Database shutdown failed; waiting before terminating the owned process.' }
        if (!$Process.WaitForExit(20000)) { Stop-Process -Id $Process.Id }
    }
}
