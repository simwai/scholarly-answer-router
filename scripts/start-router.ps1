# Start the Scholarly Answer Router.
#
# Idempotent: if the port is already serving (healthz answers), this does nothing
# and exits 0. Otherwise it starts the router in the background.
#
# Usage:  .\scripts\start-router.ps1 [-Port 3000]

param(
    [int]$Port = 3000
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $PSScriptRoot
$Health = "http://127.0.0.1:$Port/healthz"

# Already running?
try {
    $response = Invoke-WebRequest -Uri $Health -TimeoutSec 3 -UseBasicParsing
    if ($response.StatusCode -eq 200) {
        Write-Host "router already running on port $Port"
        exit 0
    }
} catch {
    # Not listening; fall through and start it.
}

if (-not (Test-Path -LiteralPath (Join-Path $RepoRoot "dist\index.js"))) {
    Write-Host "no built router found; running npm install && npm run build"
    Push-Location $RepoRoot
    try {
        npm install
        if ($LASTEXITCODE -ne 0) { throw "npm install failed" }
        npm run build
        if ($LASTEXITCODE -ne 0) { throw "npm run build failed" }
    } finally {
        Pop-Location
    }
}

Write-Host "starting router on port $Port"
$env:ROUTER_PORT = "$Port"
Start-Process -FilePath "node" -ArgumentList "dist/index.js" -WorkingDirectory $RepoRoot -WindowStyle Hidden

# Wait for it to answer healthz.
for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Milliseconds 500
    try {
        $response = Invoke-WebRequest -Uri $Health -TimeoutSec 3 -UseBasicParsing
        if ($response.StatusCode -eq 200) {
            Write-Host "router is up on http://127.0.0.1:$Port"
            exit 0
        }
    } catch {
        # keep waiting
    }
}

Write-Error "router did not become healthy on port $Port"
exit 1
