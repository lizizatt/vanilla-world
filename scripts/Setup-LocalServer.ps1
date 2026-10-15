param(
    [ValidateSet('Tools', 'Build', 'Database', 'Extract', 'All')]
    [string]$Step = 'All',
    [string]$GameDirectory,
    [ValidateRange(1, 32)][int]$Jobs = 6
)
. "$PSScriptRoot\LocalServer.Common.ps1"
New-Item -ItemType Directory -Force "$Runtime\downloads", "$Runtime\tools", "$Runtime\logs" | Out-Null
# Credentials and derived game assets inherit access only for this Windows user.
$identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
& icacls.exe $Runtime /inheritance:r /grant:r "${identity}:(OI)(CI)F" | Out-Null
if ($LASTEXITCODE) { throw 'Could not restrict runtime directory permissions.' }

function Get-Archive($Name, $Url, $Hash, $Destination) {
    $file = "$Runtime\downloads\$Name"
    if (!(Test-Path $file)) {
        & curl.exe --fail --location --silent --show-error --output $file $Url
        if ($LASTEXITCODE) { throw "Download failed: $Url" }
    }
    if ((Get-FileHash $file -Algorithm SHA256).Hash -ne $Hash) { throw "Checksum mismatch: $Name" }
    if (!(Test-Path $Destination)) { Expand-Archive $file "$Runtime\tools" }
}

if ($Step -in 'Tools', 'All') {
    Get-Archive 'cmake.zip' `
        'https://github.com/Kitware/CMake/releases/download/v3.31.12/cmake-3.31.12-windows-x86_64.zip' `
        '0c4baa40f28b3f8225eb3fdf6946c987b4fe901403b4eaf2fbbd9378100aaa0c' `
        "$Runtime\tools\cmake-3.31.12-windows-x86_64"
    Get-Archive 'mariadb.zip' `
        'https://archive.mariadb.org/mariadb-10.11.15/winx64-packages/mariadb-10.11.15-winx64.zip' `
        '857224ef39f6c52a14073578b30416784434208e18e26e2a72797acc3d7f3965' `
        "$Runtime\tools\mariadb-10.11.15-winx64"
}

if ($Step -in 'Build', 'All') {
    $vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
    $vs = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
    if (!$vs -or !(Test-Path "$vs\VC\Auxiliary\Build\vcvars64.bat")) { throw 'Install Visual Studio C++ x64 Build Tools and a Windows SDK.' }
    $source = "$Runtime\source"
    $revision = & git -C $Root rev-parse HEAD:server
    if ($LASTEXITCODE) { throw 'Cannot resolve committed server source tree.' }
    if (Test-Path "$Runtime\source-tree.txt") {
        if ((Get-Content "$Runtime\source-tree.txt" -Raw).Trim() -ne $revision) {
            throw 'Server source changed. Preserve database/data, and move runtime\source and runtime\build aside before rebuilding.'
        }
    } else {
        if (Test-Path $source) { throw 'Unmarked runtime\source exists; move it aside before building.' }
        New-Item -ItemType Directory $source | Out-Null
        & git -C $Root archive --format=tar "--output=$Runtime\downloads\source.tar" HEAD:server
        if ($LASTEXITCODE) { throw 'Source archive failed.' }
        & tar.exe -xf "$Runtime\downloads\source.tar" -C $source
        if ($LASTEXITCODE) { throw 'Source extraction failed.' }
        Write-LocalFile "$Runtime\source-tree.txt" $revision
    }
    $cmake = "$Runtime\tools\cmake-3.31.12-windows-x86_64\bin\cmake.exe"
    # Upstream Windows CMake writes into its source directory, so build an ignored copy.
    $command = "call `"$vs\VC\Auxiliary\Build\vcvars64.bat`" >nul && `"$cmake`" -S `"$source`" -B `"$Runtime\build`" -G `"Visual Studio 17 2022`" -A x64 -DBUILD_EXTRACTORS=ON -DENABLE_MAILSENDER=OFF -DSUPPORTED_CLIENT_BUILD=CLIENT_BUILD_1_12_1 -DCMAKE_INSTALL_PREFIX=`"$Runtime\server`" && `"$cmake`" --build `"$Runtime\build`" --config Release --target install --parallel $Jobs"
    $savedPath = $env:PATH
    try {
        $env:PATH = (Split-Path $vswhere) + ';' + $env:PATH
        & $env:ComSpec /d /c "$command > `"$Runtime\logs\build.log`" 2>&1"
        if ($LASTEXITCODE) { throw 'Build failed; inspect runtime\logs\build.log.' }
    } finally { $env:PATH = $savedPath }
}

if ($Step -in 'Database', 'All') {
    if (Test-Path "$Runtime\database-ready.txt") { throw 'Database is already initialized; setup will not overwrite it.' }
    if (Test-Path "$Runtime\db") { throw 'Database directory already exists; inspect it manually rather than overwriting.' }
    $base = "$Runtime\downloads\world_full_14_june_2021.7z"
    if (!(Test-Path $base)) {
        & curl.exe --fail --location --silent --show-error --output $base 'https://raw.githubusercontent.com/brotalnia/database/master/world_full_14_june_2021.7z'
        if ($LASTEXITCODE) { throw 'Base world database download failed.' }
    }
    if ((Get-FileHash $base).Hash -ne '56040a3edecd9a9dabe328ba368f609933a2501a3ecabe68080892266f8c4212') { throw 'World database checksum mismatch.' }
    $sevenZip = "$env:ProgramFiles\7-Zip\7z.exe"
    if (!(Test-Path $sevenZip)) { throw '7-Zip is required to unpack the upstream world database.' }
    & $sevenZip e -y $base "-o$Runtime\downloads" | Out-Null
    if ($LASTEXITCODE) { throw 'World database extraction failed.' }
    $rootPassword = [Guid]::NewGuid().ToString('N')
    $serverPassword = [Guid]::NewGuid().ToString('N')
    Write-LocalFile $AdminOptions "[client]`nprotocol=tcp`nhost=127.0.0.1`nport=3307`nuser=root`npassword=$rootPassword`n"
    $dbPath = "$Runtime\db".Replace('\', '/')
    $dbHome = (Split-Path $DatabaseBin).Replace('\', '/')
    Write-LocalFile "$Runtime\database.ini" @"
[mysqld]
basedir=$dbHome
datadir=$dbPath
bind-address=127.0.0.1
port=3307
max_allowed_packet=128M
sql_mode=NO_ENGINE_SUBSTITUTION
character-set-server=utf8
collation-server=utf8_general_ci
"@
    & "$DatabaseBin\mariadb-install-db.exe" "--datadir=$Runtime\db" "--password=$rootPassword" --port=3307 --silent
    if ($LASTEXITCODE) { throw 'Database initialization failed.' }
    $db = $null
    try {
        $db = Start-LocalDatabase
        Wait-LocalDatabase $db
        $schema = "$Root\server\sql"
        $commands = New-Object Collections.Generic.List[string]
        foreach ($name in 'realmd', 'mangos', 'characters', 'logs') {
            $commands.Add("CREATE DATABASE $name DEFAULT CHARSET utf8 COLLATE utf8_general_ci;")
        }
        foreach ($entry in @(
            @('realmd', "$schema\logon.sql"), @('characters', "$schema\characters.sql"),
            @('logs', "$schema\logs.sql"), @('mangos', "$Runtime\downloads\world_full_14_june_2021.sql")
        )) {
            $commands.Add("USE $($entry[0]);")
            $commands.Add("SOURCE $($entry[1].Replace('\', '/'));")
        }
        foreach ($file in Get-ChildItem "$schema\migrations" -Filter '*.sql' | Sort-Object Name) {
            $database = switch -Regex ($file.Name) {
                '_world.sql$' { 'mangos' } '_logon.sql$' { 'realmd' }
                '_characters.sql$' { 'characters' } '_logs.sql$' { 'logs' }
                default { throw "Unrecognized migration: $($file.Name)" }
            }
            $commands.Add("USE $database;")
            $commands.Add("SOURCE $($file.FullName.Replace('\', '/'));")
        }
        $commands.Add("CREATE USER 'vanilla'@'127.0.0.1' IDENTIFIED BY '$serverPassword';")
        foreach ($name in 'realmd', 'mangos', 'characters', 'logs') {
            $commands.Add("GRANT SELECT,INSERT,UPDATE,DELETE ON $name.* TO 'vanilla'@'127.0.0.1';")
        }
        $commands.Add("GRANT DROP ON characters.game_event_status TO 'vanilla'@'127.0.0.1';")
        $commands.Add("INSERT INTO realmd.realmlist (id,name,address,localAddress,port,realmflags,gamebuild_min,gamebuild_max) VALUES (1,'Vanilla Local','127.0.0.1','127.0.0.1',8085,0,5875,5875);")
        Invoke-LocalSql ($commands -join "`n") > "$Runtime\logs\import.log"
        foreach ($component in 'mangosd', 'realmd') {
            $template = Get-Content "$Root\server\src\$component\$component.conf.dist.in" -Raw
            $template = $template -replace '(?m)^BindIP\s*=.*$', 'BindIP = "127.0.0.1"'
            $template = $template -replace '127.0.0.1;3306;mangos;mangos;', "127.0.0.1;3307;vanilla;$serverPassword;"
            $template = $template -replace '(?m)^LogsDir\s*=.*$', ('LogsDir = "' + "$Runtime\logs".Replace('\', '/') + '"')
            $template = $template -replace '(?m)^DataDir\s*=.*$', ('DataDir = "' + "$Runtime\data".Replace('\', '/') + '"')
            Write-LocalFile "$Runtime\$component.conf" $template
        }
        Write-LocalFile "$Runtime\database-ready.txt" ((& git -C $Root rev-parse HEAD:server) + "`nMariaDB 10.11.15; base 14 June 2021 plus sorted committed migrations")
        Write-Host 'Database initialized; configs and random credentials are private under runtime.'
    } finally { Stop-LocalDatabase $db }
}

if ($Step -in 'Extract', 'All') {
    if (!$GameDirectory -or !(Test-Path "$GameDirectory\Data\terrain.MPQ")) { throw 'Supply -GameDirectory pointing to your own build-5875 installation (parent of Data).' }
    if ($GameDirectory.Length -ge 120 -or "$Runtime\data".Length -ge 120) { throw 'MapExtractor has 128-byte path buffers; use a shorter checkout or game path.' }
    if (Test-Path "$Runtime\data-ready.txt") { throw 'Extraction already complete; no existing generated data will be overwritten.' }
    if ((Test-Path "$Runtime\data") -and (Get-ChildItem "$Runtime\data" | Select-Object -First 1)) {
        throw 'Partial extracted data already exists; preserve it and move runtime\data aside before starting fresh.'
    }
    New-Item -ItemType Directory -Force "$Runtime\data" | Out-Null
    $extractors = "$Runtime\server\Extractors"
    Push-Location "$Runtime\data"
    try {
        & "$extractors\MapExtractor.exe" --silent -i $GameDirectory -o . -e 3 > "$Runtime\logs\maps.log"
        if ($LASTEXITCODE) { throw 'Map/DBC extraction failed.' }
        & "$extractors\VMapExtractor.exe" --silent -d "$GameDirectory\Data" > "$Runtime\logs\vmap-extract.log"
        if ($LASTEXITCODE) { throw 'VMap extraction failed.' }
        New-Item -ItemType Directory -Force vmaps, mmaps, 5875 | Out-Null
        & "$extractors\VMapAssembler.exe" buildings vmaps > "$Runtime\logs\vmap-assemble.log"
        if ($LASTEXITCODE) { throw 'VMap assembly failed.' }
        if (Test-Path dbc) { Move-Item dbc 5875 }
        & "$extractors\MoveMapGenerator.exe" --silent --threads $Jobs `
            --configInputPath "$extractors\config.json" --offMeshInput "$extractors\offmesh.txt" > "$Runtime\logs\mmaps.log"
        if ($LASTEXITCODE) { throw 'Movement map generation failed.' }
        Assert-LocalData -WithMovementMaps
        Write-LocalFile "$Runtime\data-ready.txt" '5875; generated locally from user-provided MPQs'
    } finally { Pop-Location }
}
