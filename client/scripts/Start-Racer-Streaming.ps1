param(
    [Parameter(Mandatory = $true)]
    [string]$DataPath,
    [string]$AuthAddress = '127.0.0.1:3725',
    [string]$TuningFrom,
    [switch]$Trace
)

$ErrorActionPreference = 'Stop'
$work = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$exe = Join-Path $work 'target-racer\streaming\benilla.exe'
$home = Join-Path $work 'target-racer\streaming-state'
if (!(Test-Path -LiteralPath $exe -PathType Leaf)) {
    throw "Build and copy the streaming executable first: $exe"
}
$data = (Resolve-Path -LiteralPath $DataPath).Path
if (!(Test-Path -LiteralPath $data -PathType Container)) {
    throw 'DataPath must be the existing game Data directory.'
}
New-Item -ItemType Directory -Path $home -Force | Out-Null
if ($TuningFrom) {
    $destination = Join-Path $home 'racer-tuning.txt'
    if (Test-Path -LiteralPath $destination) {
        throw "Refusing to overwrite saved tuning: $destination"
    }
    Copy-Item -LiteralPath (Resolve-Path -LiteralPath $TuningFrom).Path -Destination $destination
}

$names = @(
    'WOW_DATA', 'BENILLA_HOME', 'WOW_FLATS_RACER', 'WOW_CAPTURE', 'WOW_UNATTENDED',
    'WOW_RACER_STREAM_PROBE', 'WOW_USER', 'WOW_PASS', 'WOW_CHAR',
    'WOW_MOVE_TRACE', 'WOW_MOVE_TRACE_TAGS', 'WOW_HOST', 'WOW_REALM', 'WOW_NOSOUND'
)
$names += @(Get-ChildItem Env: | Where-Object { $_.Name -like 'WOW_*' } |
    ForEach-Object { $_.Name })
$names = @($names | Select-Object -Unique)
$saved = @{}
foreach ($name in $names) {
    $saved[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}
try {
    foreach ($name in $names) {
        [Environment]::SetEnvironmentVariable($name, $null, 'Process')
    }
    $env:WOW_DATA = $data
    $env:BENILLA_HOME = $home
    $env:WOW_FLATS_RACER = '1'
    $env:WOW_HOST = $AuthAddress
    $env:WOW_NOSOUND = '1'
    if ($Trace) {
        $env:WOW_MOVE_TRACE = Join-Path $home 'racer-trace.log'
        $env:WOW_MOVE_TRACE_TAGS = 'racer'
    }
    Push-Location $work
    try {
        & $exe
        if ($LASTEXITCODE -ne 0) {
            throw "Racer exited with code $LASTEXITCODE"
        }
    } finally {
        Pop-Location
    }
} finally {
    foreach ($name in $names) {
        [Environment]::SetEnvironmentVariable($name, $saved[$name], 'Process')
    }
}
