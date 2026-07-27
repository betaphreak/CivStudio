#requires -Version 7
<#
.SYNOPSIS
  Deploy everything that changed, in the order that keeps the surfaces in sync.

.DESCRIPTION
  CivStudio has four deployables on three different triggers — the server and the studio are rolled
  by hand, the site auto-deploys on push, and content is a CI workflow — so a release is a sequence
  somebody has to remember. It was remembered wrong on 2026-07-27 (web live at 06:51, server rolled
  hours later) and it was carried in one head all through the session that fixed it. This encodes it.

  WHAT IT DOES NOT DO is decide anything interesting. Each step is the existing script; the value is
  the ORDER, the skipping, and the fact that it verifies at the end instead of assuming:

    1. server  (tools/deploy-server.ps1)  if engine/server/pom changed since what is deployed
    2. studio  (tools/deploy-studio.ps1)  if studio/ changed
    3. push                               if there are unpushed commits — this is what ships web/,
                                          and deploy-web.yml refuses to run ahead of the server it
                                          was built against (tools/verify-server-ahead.mjs)
    4. content                            REPORTED, not run, unless -Seed. See the note below.
    5. verify   world invariants + content parity + the ordering gate's own question

  Server before web is the load-bearing order: the site calls endpoints the server may not have yet.
  Studio is independent of both (its admin calls the server, never the reverse).

  CONTENT IS OPT-IN. Seeding is a wipe-and-reseed of the production database; a command called
  "deploy" must not do that because the world-bundle happened to change. Without -Seed a content
  change is reported with the two commands that apply it.

.PARAMETER Seed
  Also run the Seed Studio workflow and tools/refresh-content.ps1 when the committed world-bundle
  snapshot has changed. Wipes and reseeds the production content store.

.PARAMETER Force
  Deploy the server and studio even when nothing under their paths changed.

.PARAMETER WhatIf
  Print the plan and exit, touching nothing.

.EXAMPLE
  pwsh tools/deploy-all.ps1 -WhatIf     # what would happen
  pwsh tools/deploy-all.ps1             # code + site
  pwsh tools/deploy-all.ps1 -Seed       # …and reseed the content store
#>
[CmdletBinding(SupportsShouldProcess)]
param(
  [switch]$Seed,
  [switch]$Force
)
$ErrorActionPreference = 'Stop'

$SERVER_SITE = 'https://dev.civstudio.com'
$SNAPSHOT    = 'civstudio-engine/src/test/resources/world-bundle.json.gz'
# Mirrors each deployable's own trigger paths — deploy-server.yml, strapi-deploy.yml, deploy-web.yml.
$SERVER_PATHS = @('civstudio-engine', 'civstudio-server', 'pom.xml', '.mvn')
$STUDIO_PATHS = @('studio')
$WEB_PATHS    = @('web')

function Assert-Tool($name, $hint) {
  if (-not (Get-Command $name -ErrorAction SilentlyContinue)) { throw "$name not found on PATH — $hint" }
}
Assert-Tool git  'install git'
Assert-Tool node 'install Node (the verifiers run on it)'
Assert-Tool az   'install the Azure CLI and run `az login`'

# ---- where are we? --------------------------------------------------------
$branch = (git rev-parse --abbrev-ref HEAD).Trim()
if ($branch -ne 'master') {
  Write-Warning "on branch '$branch', not master — deploys ship master. Continuing, but check that is what you meant."
}
$head = (git rev-parse HEAD).Trim()
$dirty = [bool](git status --porcelain)
if ($dirty) {
  Write-Warning 'working tree is dirty — images will be tagged "-dirty" and the push will not include your changes.'
}

# What is running right now? Everything below is measured against this.
try {
  $info = Invoke-RestMethod -Uri "$SERVER_SITE/actuator/info" -TimeoutSec 15
  $deployed = $info.build.commit
} catch {
  throw "cannot reach $SERVER_SITE/actuator/info — deploy-all measures what changed against the RUNNING server, so it cannot plan without it. ($_)"
}
try { $deployedFull = (git rev-parse "$deployed^{commit}").Trim() }
catch { throw "the server reports commit $deployed, which is not in this repository's history — roll it from master first." }

Write-Host "==> deployed server: $deployed" -ForegroundColor Cyan
Write-Host "==> local HEAD:      $($head.Substring(0,8))$(if ($dirty) {' (dirty)'})" -ForegroundColor Cyan

# ---- what changed? --------------------------------------------------------
function Changed($paths) {
  if ($deployedFull -eq $head) { return $false }
  $out = git diff --name-only "$deployedFull..$head" -- @paths
  return [bool]$out
}
$needServer  = $Force -or (Changed $SERVER_PATHS)
$needStudio  = $Force -or (Changed $STUDIO_PATHS)
$webChanged  = Changed $WEB_PATHS
$contentChanged = Changed @($SNAPSHOT)
$unpushed = [bool](git log '@{u}..HEAD' --oneline 2>$null)

$plan = @()
if ($needServer)  { $plan += 'server  — tools/deploy-server.ps1' }
if ($needStudio)  { $plan += 'studio  — tools/deploy-studio.ps1' }
if ($unpushed)    { $plan += "push    — ships web/ via deploy-web.yml$(if (-not $webChanged) {' (no web changes; push only)'})" }
if ($contentChanged) {
  $plan += $Seed ? 'content — Seed Studio + tools/refresh-content.ps1' `
                 : 'content — CHANGED but skipped (pass -Seed to apply)'
}
$plan += 'verify  — world invariants, content parity, server/web ordering'

Write-Host "`n==> plan" -ForegroundColor Cyan
foreach ($p in $plan) { Write-Host "    $p" }
if (-not ($needServer -or $needStudio -or $unpushed)) {
  Write-Host '    (nothing to deploy — everything already matches the running server)' -ForegroundColor Yellow
}
if ($WhatIfPreference) { Write-Host "`n-WhatIf: stopping here." -ForegroundColor Yellow; exit 0 }

# ---- do it ----------------------------------------------------------------
# Server FIRST: the site calls endpoints the server may not have yet, and deploy-web.yml will refuse
# to ship ahead of it anyway — better to satisfy that here than to fail a run and re-trigger.
if ($needServer) {
  Write-Host "`n==> [1/4] server" -ForegroundColor Green
  & (Join-Path $PSScriptRoot 'deploy-server.ps1')
  if ($LASTEXITCODE -ne 0) { throw 'server deploy failed — stopping before anything else ships.' }
}
if ($needStudio) {
  Write-Host "`n==> [2/4] studio" -ForegroundColor Green
  & (Join-Path $PSScriptRoot 'deploy-studio.ps1')
  if ($LASTEXITCODE -ne 0) { throw 'studio deploy failed.' }
}
if ($unpushed) {
  Write-Host "`n==> [3/4] push (ships web/)" -ForegroundColor Green
  git push origin HEAD
  if ($LASTEXITCODE -ne 0) { throw 'push failed.' }
}
if ($contentChanged) {
  if ($Seed) {
    Write-Host "`n==> [4/4] content — seeding" -ForegroundColor Green
    Assert-Tool gh 'install the GitHub CLI (the seed runs as a workflow)'
    gh workflow run seed-studio.yml --ref master
    if ($LASTEXITCODE -ne 0) { throw 'could not start the Seed Studio workflow.' }
    Write-Host '    waiting for the seed to finish...'
    Start-Sleep -Seconds 15
    $runId = (gh run list --workflow=seed-studio.yml --limit 1 --json databaseId --jq '.[0].databaseId').Trim()
    gh run watch $runId --exit-status
    if ($LASTEXITCODE -ne 0) { throw "the Seed Studio run $runId failed — content not applied." }
    & (Join-Path $PSScriptRoot 'refresh-content.ps1')
    if ($LASTEXITCODE -ne 0) { throw 'refresh-content failed — the seed landed but the caches still hold the old bundle.' }
  } else {
    Write-Host "`n==> content CHANGED but not applied" -ForegroundColor Yellow
    Write-Host '    the committed world-bundle differs from what is deployed. To apply it:'
    Write-Host '      gh workflow run seed-studio.yml --ref master'
    Write-Host '      pwsh tools/refresh-content.ps1'
    Write-Host '    (or re-run this script with -Seed)'
  }
}

# ---- verify ---------------------------------------------------------------
# The point of the whole exercise: not "did the steps run" but "is prod right afterwards".
Write-Host "`n==> verify" -ForegroundColor Green
$failed = @()
node (Join-Path $PSScriptRoot 'verify-world.mjs') $SERVER_SITE
if ($LASTEXITCODE -ne 0) { $failed += 'world invariants' }
node (Join-Path $PSScriptRoot 'verify-content-parity.mjs') $SERVER_SITE --settle 90
if ($LASTEXITCODE -ne 0) { $failed += 'content parity' }
node (Join-Path $PSScriptRoot 'verify-server-ahead.mjs') --base $SERVER_SITE
if ($LASTEXITCODE -ne 0) { $failed += 'server/web ordering' }

if ($failed.Count) {
  throw ("DEPLOY VERIFY FAILED: " + ($failed -join ', ') + ". The steps ran; the result is not right. " +
    'See the failed checks above — each names its own remedy.')
}
Write-Host "`n==> done — everything deployed and verified." -ForegroundColor Green
