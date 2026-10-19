param([switch]$Setup)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

# Follows vendor/anythingllm/BARE_METAL.md; no upstream tracked files are edited.
& (Join-Path $PSScriptRoot 'fetch-source.ps1') -CheckOnly
$sourcePath = (Resolve-Path (Join-Path $PSScriptRoot '../../vendor/anythingllm')).Path
$nodePath = (Get-Command node -ErrorAction Stop).Source
$storagePath = Join-Path $sourcePath 'server/storage'
$logPath = Join-Path $PSScriptRoot 'data/local-logs'
$adapter = Join-Path $PSScriptRoot 'local-runtime.cjs'
New-Item -ItemType Directory -Path $storagePath, $logPath -Force | Out-Null

function Invoke-InDirectory {
    param([string]$Directory, [scriptblock]$Action)
    Push-Location $Directory
    try {
        & $Action
        if ($LASTEXITCODE -ne 0) { throw "Command failed in $Directory (exit $LASTEXITCODE)." }
    } finally { Pop-Location }
}

if ($Setup) {
    $env:PUPPETEER_SKIP_DOWNLOAD = 'true'
    foreach ($component in @('server', 'collector', 'frontend')) {
        $installArgs = @('install', '--frozen-lockfile', '--non-interactive', '--network-timeout', '120000')
        if ($component -ne 'frontend') { $installArgs += '--production' }
        Invoke-InDirectory (Join-Path $sourcePath $component) {
            & npx.cmd --yes --package yarn@1.22.22 yarn @installArgs
        }
    }
    $env:VITE_API_BASE = '/api'
    Invoke-InDirectory (Join-Path $sourcePath 'frontend') { & npm.cmd run build }
}

foreach ($component in @('server', 'collector')) {
    if (-not (Test-Path -LiteralPath (Join-Path $sourcePath "$component/node_modules/.yarn-integrity"))) {
        throw "Missing $component dependencies. Run start-local.ps1 -Setup first."
    }
}
$publicPath = Join-Path $sourcePath 'server/public'
if ($Setup -or -not (Test-Path -LiteralPath (Join-Path $publicPath '_index.html'))) {
    $distPath = Join-Path $sourcePath 'frontend/dist'
    if (-not (Test-Path -LiteralPath (Join-Path $distPath '_index.html'))) {
        throw 'Missing frontend build. Run start-local.ps1 -Setup first.'
    }
    New-Item -ItemType Directory -Path $publicPath -Force | Out-Null
    Get-ChildItem -LiteralPath $distPath -Force | Copy-Item -Destination $publicPath -Recurse -Force
}

$serverEnv = Join-Path $sourcePath 'server/.env'
if (-not (Test-Path -LiteralPath $serverEnv)) {
    # JWT_SECRET / VECTOR_DB are deliberately left for onboarding: pre-setting
    # these makes upstream classify a fresh database as already onboarded.
    $lines = @(
        'SERVER_PORT=3001',
        ('STORAGE_DIR="' + $storagePath.Replace('\', '/') + '"'),
        'DISABLE_TELEMETRY=true',
        'DISABLE_SWAGGER_DOCS=true',
        'TARGET_OCR_LANG=chi_sim,eng'
    )
    foreach ($key in @('SIG_KEY', 'SIG_SALT')) {
        $bytes = [System.Security.Cryptography.RandomNumberGenerator]::GetBytes(32)
        $lines += $key + '=' + [Convert]::ToHexString($bytes).ToLowerInvariant()
    }
    [System.IO.File]::WriteAllLines($serverEnv, $lines, [System.Text.UTF8Encoding]::new($false))
}

$env:NODE_ENV = 'production'
$env:STORAGE_DIR = $storagePath
$env:SERVER_PORT = '3001'
$env:COLLECTOR_PORT = '8888'
$env:DISABLE_TELEMETRY = 'true'
$env:DISABLE_SWAGGER_DOCS = 'true'
$env:TARGET_OCR_LANG = 'chi_sim,eng'
foreach ($chromePath in @(
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'
)) {
    if (Test-Path -LiteralPath $chromePath) {
        $env:PUPPETEER_EXECUTABLE_PATH = $chromePath
        break
    }
}

if ($Setup -or -not (Test-Path -LiteralPath (Join-Path $sourcePath 'server/node_modules/.prisma/client/index.js'))) {
    Invoke-InDirectory (Join-Path $sourcePath 'server') {
        & $nodePath './node_modules/prisma/build/index.js' generate --schema=./prisma/schema.prisma
    }
}
Invoke-InDirectory (Join-Path $sourcePath 'server') {
    & $nodePath './node_modules/prisma/build/index.js' migrate deploy --schema=./prisma/schema.prisma
}

foreach ($service in @(
    @{ Name = 'collector'; Port = 8888; Health = '/accepts' },
    @{ Name = 'server'; Port = 3001; Health = '/api/ping' }
)) {
    $directory = Join-Path $sourcePath $service.Name
    $entry = Join-Path $directory 'index.js'
    $listeners = @(Get-NetTCPConnection -State Listen -LocalPort $service.Port -ErrorAction SilentlyContinue)
    if ($listeners.Count -gt 0) {
        foreach ($listener in $listeners) {
            $owner = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)"
            if (-not $owner -or -not $owner.CommandLine -or -not $owner.CommandLine.Contains($entry)) {
                throw "Port $($service.Port) is occupied by another process. It was left running."
            }
        }
        Write-Host "$($service.Name) is already running."
    } else {
        $stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
        $stdout = Join-Path $logPath "$($service.Name)-$stamp.log"
        $stderr = Join-Path $logPath "$($service.Name)-$stamp.err.log"
        $process = Start-Process -FilePath $nodePath -ArgumentList @('--require', ('"' + $adapter + '"'), ('"' + $entry + '"')) `
            -WorkingDirectory $directory -WindowStyle Hidden -PassThru `
            -RedirectStandardOutput $stdout -RedirectStandardError $stderr
        Write-Host "Started $($service.Name) PID $($process.Id). Logs: $stdout"
    }
    $ready = $false
    for ($attempt = 0; $attempt -lt 45; $attempt++) {
        try {
            $response = Invoke-WebRequest -Uri "http://127.0.0.1:$($service.Port)$($service.Health)" -TimeoutSec 2
            if ($response.StatusCode -eq 200) { $ready = $true; break }
        } catch { Start-Sleep -Seconds 1 }
    }
    if (-not $ready) { throw "$($service.Name) did not become healthy. Check $logPath. Persistent data was preserved." }
}
$page = Invoke-WebRequest -Uri 'http://localhost:3001/' -TimeoutSec 10
if ($page.StatusCode -ne 200 -or $page.Content -notmatch '<div\s+id="root"[\s>]') {
    throw 'The frontend did not return the expected application page.'
}
Write-Host 'Knowledge base is ready: http://localhost:3001/'
