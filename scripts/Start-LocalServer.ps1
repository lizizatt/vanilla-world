param([switch]$CreateProbeAccount, [switch]$DisablePathfinding)
. "$PSScriptRoot\LocalServer.Common.ps1"
if (!(Test-Path "$Runtime\database-ready.txt")) {
    throw 'Run Setup-LocalServer.ps1 -Step Database first.'
}
if (!$DisablePathfinding -and !(Test-Path "$Runtime\data-ready.txt")) {
    throw 'Full extraction is incomplete. Wait for it, or explicitly use -DisablePathfinding for a limited login test.'
}
Assert-LocalData -WithMovementMaps:(!$DisablePathfinding)
foreach ($port in 3724, 8085) {
    if (Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue) {
        throw "Port $port is occupied; existing processes will not be stopped."
    }
}
$db = $null
$auth = $null
$world = $null
$output = $null
$errors = $null
$copyOutput = $null
$copyErrors = $null
try {
    $db = Start-LocalDatabase
    if (Test-Path "$Runtime\stop-request.txt") { Remove-Item "$Runtime\stop-request.txt" }
    Wait-LocalDatabase $db
    $worldConfig = Get-Content "$Runtime\mangosd.conf" -Raw
    if ($DisablePathfinding) {
        if ($worldConfig -notmatch '(?m)^mmap\.enabled\s*=') { throw 'Missing mmap.enabled setting.' }
        $worldConfig = $worldConfig -replace '(?m)^mmap\.enabled\s*=.*$', 'mmap.enabled = 0'
        Write-Warning 'LIMITED LOGIN TEST: mmap pathfinding is disabled. Do not use this mode for normal gameplay.'
    }
    Write-LocalFile "$Runtime\mangosd-active.conf" $worldConfig
    $auth = Start-Process "$Runtime\server\realmd.exe" -ArgumentList "-c `"$Runtime\realmd.conf`"" `
        -WorkingDirectory $Runtime -NoNewWindow -PassThru `
        -RedirectStandardOutput "$Runtime\logs\auth.stdout.log" -RedirectStandardError "$Runtime\logs\auth.stderr.log"
    $start = New-Object Diagnostics.ProcessStartInfo
    $start.FileName = "$Runtime\server\mangosd.exe"
    $start.Arguments = "-c `"$Runtime\mangosd-active.conf`""
    $start.WorkingDirectory = $Runtime
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardInput = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $output = [IO.FileStream]::new("$Runtime\logs\world.stdout.log", 'Create', 'Write', 'ReadWrite', 1)
    $errors = [IO.FileStream]::new("$Runtime\logs\world.stderr.log", 'Create', 'Write', 'ReadWrite', 1)
    $world = [Diagnostics.Process]::Start($start)
    $copyOutput = $world.StandardOutput.BaseStream.CopyToAsync($output)
    $copyErrors = $world.StandardError.BaseStream.CopyToAsync($errors)
    $ready = $false
    for ($i = 0; $i -lt 240; $i++) {
        if ($auth.HasExited -or $world.HasExited -or $db.HasExited) { throw 'A server process exited; inspect runtime\logs.' }
        $ports = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
            Where-Object { ($_.OwningProcess -eq $auth.Id -and $_.LocalPort -eq 3724) -or ($_.OwningProcess -eq $world.Id -and $_.LocalPort -eq 8085) })
        if ($ports.Count -eq 2 -and (Select-String -Path "$Runtime\logs\world.stdout.log" -Pattern 'SERVER STARTUP TIME:' -Quiet)) {
            if (@($ports | Where-Object LocalAddress -ne '127.0.0.1').Count) { throw 'A server listener is not loopback-only.' }
            $ready = $true
            break
        }
        Start-Sleep 1
    }
    if (!$ready) { throw 'World/auth readiness timed out; inspect runtime\logs.' }
    if ($CreateProbeAccount) {
        if ((Invoke-LocalSql "SELECT COUNT(*) FROM realmd.account WHERE username='LOCALPROBE';") -ne '0') {
            throw 'LOCALPROBE already exists; credentials will not be overwritten.'
        }
        $password = [Guid]::NewGuid().ToString('N').Substring(0, 16).ToUpperInvariant()
        $world.StandardInput.WriteLine("account create LOCALPROBE $password")
        for ($i = 0; $i -lt 20; $i++) {
            Start-Sleep 1
            if ((Invoke-LocalSql "SELECT COUNT(*) FROM realmd.account WHERE username='LOCALPROBE';") -eq '1') { break }
        }
        if ($i -eq 20) { throw 'Probe account creation failed.' }
        Write-LocalFile "$Runtime\probe.json" (@{ username = 'LOCALPROBE'; password = $password } | ConvertTo-Json)
    }
    Write-LocalFile "$Runtime\processes.json" (@{ database = $db.Id; auth = $auth.Id; world = $world.Id } | ConvertTo-Json)
    Write-Host 'READY: auth 127.0.0.1:3724; world 127.0.0.1:8085; database 127.0.0.1:3307.'
    Write-Host 'Keep this command running. Ctrl+C stops its owned processes. Logs: runtime\logs.'
    while (!$world.HasExited -and !$auth.HasExited -and !$db.HasExited) {
        if (Test-Path "$Runtime\stop-request.txt") { break }
        Start-Sleep 2
    }
    if (!(Test-Path "$Runtime\stop-request.txt")) { throw 'A local server process exited unexpectedly; inspect runtime\logs.' }
} finally {
    try {
        if ($world -and !$world.HasExited) {
            try { $world.StandardInput.WriteLine('server shutdown 0') }
            catch [IO.IOException] { Write-Warning "World stdin closed during shutdown: $_" }
            if (!$world.WaitForExit(30000)) { Stop-Process -Id $world.Id }
        }
    } finally {
        try {
            if ($auth -and !$auth.HasExited) { Stop-Process -Id $auth.Id }
            if ($copyOutput) { $null = $copyOutput.GetAwaiter().GetResult() }
            if ($copyErrors) { $null = $copyErrors.GetAwaiter().GetResult() }
        } finally {
            if ($output) { $output.Dispose() }
            if ($errors) { $errors.Dispose() }
            Stop-LocalDatabase $db
            if (Test-Path "$Runtime\processes.json") { Remove-Item "$Runtime\processes.json" }
            if (Test-Path "$Runtime\stop-request.txt") { Remove-Item "$Runtime\stop-request.txt" }
        }
    }
}
