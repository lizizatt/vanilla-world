$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$env:CARGO_TARGET_DIR = Join-Path $root 'target-web'
Push-Location (Join-Path $root 'client')
try {
    cargo build -p flats-racer-web --target wasm32-unknown-unknown --release -j 2
    if ($LASTEXITCODE -ne 0) { throw 'Wasm build failed' }
    $bindgen = Join-Path $root 'target-web\tools\bin\wasm-bindgen.exe'
    if (!(Test-Path $bindgen)) { throw 'Install wasm-bindgen-cli 0.2.122 as documented in browser\README.md' }
    & $bindgen (Join-Path $env:CARGO_TARGET_DIR 'wasm32-unknown-unknown\release\flats_racer_web.wasm') --target web --out-dir (Join-Path $PSScriptRoot 'pkg')
    if ($LASTEXITCODE -ne 0) { throw 'Wasm binding generation failed' }
} finally { Pop-Location }
