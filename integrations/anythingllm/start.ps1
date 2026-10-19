param([switch]$CheckOnly)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

& (Join-Path $PSScriptRoot 'fetch-source.ps1') -CheckOnly
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    throw 'Docker with Compose is required. Source verification completed; no service was started.'
}
& docker compose version
if ($LASTEXITCODE -ne 0) { throw 'Docker Compose is unavailable.' }

$envFile = Join-Path $PSScriptRoot '.env'
if (-not (Test-Path -LiteralPath $envFile)) {
    if ($CheckOnly) { throw 'Local .env is missing. Run start.ps1 without -CheckOnly to initialize it.' }
    $template = Get-Content -LiteralPath (Join-Path $PSScriptRoot '.env.example') -Raw
    foreach ($name in @('SIG_KEY', 'SIG_SALT', 'JWT_SECRET')) {
        $bytes = [System.Security.Cryptography.RandomNumberGenerator]::GetBytes(32)
        $value = [Convert]::ToHexString($bytes).ToLowerInvariant()
        $template = $template.Replace("__GENERATE_$($name)__", $value)
    }
    [System.IO.File]::WriteAllText($envFile, $template, [System.Text.UTF8Encoding]::new($false))
    Write-Host 'Initialized local .env with random signing and session keys.'
}
$envText = Get-Content -LiteralPath $envFile -Raw
if ($envText.Contains('__GENERATE_')) {
    throw 'The local .env contains template placeholders. Replace them with random keys before starting.'
}

$composeFile = Join-Path $PSScriptRoot 'docker-compose.yml'
$composeArgs = @('compose', '--project-directory', $PSScriptRoot, '--env-file', $envFile, '-f', $composeFile)
& docker @composeArgs config --quiet
if ($LASTEXITCODE -ne 0) { throw 'Compose configuration validation failed.' }
if ($CheckOnly) {
    Write-Host 'Source and Compose configuration verified. No containers were started.'
    return
}

& docker @composeArgs up -d --build
if ($LASTEXITCODE -ne 0) { throw 'Knowledge base build/start failed. Persistent data was preserved.' }
& docker @composeArgs ps
Write-Host 'Startup requested. Check container health, then initialize the administrator and models at http://localhost:3001.'
