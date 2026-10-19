param([switch]$CheckOnly)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$sourceLock = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'source-lock.json') -Raw | ConvertFrom-Json
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$sourcePath = Join-Path $repoRoot $sourceLock.sourceDirectory

function Invoke-SourceGit {
    param([string[]]$GitArgs)
    & git @GitArgs
    if ($LASTEXITCODE -ne 0) {
        throw "Git failed (exit $LASTEXITCODE). Existing source and files were preserved."
    }
}

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    throw 'Git is required to fetch and verify the upstream source.'
}
if (-not (Test-Path -LiteralPath $sourcePath)) {
    if ($CheckOnly) {
        throw 'Upstream source is missing. Run fetch-source.ps1 without -CheckOnly first.'
    }
    New-Item -ItemType Directory -Path (Split-Path $sourcePath) -Force | Out-Null
    Invoke-SourceGit -GitArgs @('-c', 'http.version=HTTP/1.1', 'clone', '--filter=blob:none', '--no-checkout',
        '--branch', $sourceLock.version, '--depth', '1', $sourceLock.repository, $sourcePath)
}
if (-not (Test-Path -LiteralPath (Join-Path $sourcePath '.git'))) {
    # Project clones track the complete upstream snapshot as ordinary files.
    $trackedSource = Invoke-SourceGit -GitArgs @('-C', $repoRoot, 'ls-files', '--', "$($sourceLock.sourceDirectory)/package.json")
    if (-not $trackedSource) {
        throw 'The source directory has neither upstream Git metadata nor project-tracked source. Existing files were preserved.'
    }
    foreach ($relativePath in $sourceLock.requiredFiles) {
        if (-not (Test-Path -LiteralPath (Join-Path $sourcePath $relativePath))) {
            throw "Required upstream file is missing: $relativePath"
        }
    }
    Write-Host "Using project-tracked AnythingLLM source (upstream baseline $($sourceLock.version) at $($sourceLock.commit))."
    return
}
$actualCommit = (Invoke-SourceGit -GitArgs @('-C', $sourcePath, 'rev-parse', 'HEAD')).Trim()
if ($actualCommit -ne $sourceLock.commit) {
    throw "Upstream commit is $actualCommit; expected $($sourceLock.commit). No files were reset."
}
if (-not $CheckOnly) {
    # Only download the directories used by the official Docker build; root license files remain included.
    Invoke-SourceGit -GitArgs (@('-C', $sourcePath, 'sparse-checkout', 'set') + @($sourceLock.checkoutDirectories))
    Invoke-SourceGit -GitArgs @('-C', $sourcePath, 'checkout', '--detach', $sourceLock.commit)
}
foreach ($relativePath in $sourceLock.requiredFiles) {
    if (-not (Test-Path -LiteralPath (Join-Path $sourcePath $relativePath))) {
        throw "Required upstream file is missing: $relativePath"
    }
}
$changes = Invoke-SourceGit -GitArgs @('-C', $sourcePath, 'status', '--porcelain', '--untracked-files=no')
if ($changes) {
    throw 'The upstream tracked files have local changes. Preserve and review them before building.'
}
Write-Host "Verified AnythingLLM $($sourceLock.version) at $actualCommit"
