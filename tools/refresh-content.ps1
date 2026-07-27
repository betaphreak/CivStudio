#requires -Version 7
<#
.SYNOPSIS
  Make freshly-seeded content actually VISIBLE: drop both bundle caches, then verify the world.

.DESCRIPTION
  Seeding the Studio writes rows and stops. It does not change what anyone sees, because the bundle
  is cached TWICE on the way out:

    1. Strapi caches the assembled projection, module-scoped, KEYED BY contentVersion
       (studio/src/api/world-bundle/services/world-bundle.ts). A reseed whose data changed but whose
       contentVersion did not leaves this cache holding the old bytes — identical Content-Length is
       the tell.
    2. civstudio-server caches the bundle in a static field ("static per deploy" — WorldBundle),
       so it re-reads the upstream only at boot.

  Both are process-scoped, so both die with a restart — and the ORDER MATTERS: restarting the server
  first only makes it re-fetch the stale bytes Strapi is still serving. Strapi first, then the server.

  This happened for real on 2026-07-27: a clean reseed (5,268 provinces, 0 errors) reported success
  while prod kept serving the pre-realm-split world, and the live map showed "Cannor: 0 provinces".
  The seed was fine; nothing had dropped the caches. See docs/client-server.md §Deployment.

  Steps: restart the Strapi revision -> wait for /_health -> restart the server revision ->
  wait for /actuator/health -> node tools/verify-world.mjs (the world invariants).

  Needs an authenticated `az` session. The CI seed workflow cannot do this itself: the subscription
  is reached by a guest identity that cannot create role assignments, so there is no CI service
  principal (the same reason deploys are local — see tools/deploy-server.ps1).

.PARAMETER SkipStudio
  Leave Strapi alone (its cache is already fresh, e.g. you only rolled the server).

.PARAMETER SkipServer
  Leave civstudio-server alone.

.EXAMPLE
  pwsh tools/refresh-content.ps1              # after a Seed Studio run
  pwsh tools/refresh-content.ps1 -SkipStudio  # server-only cache drop
#>
[CmdletBinding()]
param(
  [switch]$SkipStudio,
  [switch]$SkipServer
)
$ErrorActionPreference = 'Stop'

$RG          = 'civstudio'
$STUDIO_APP  = 'civstudio-backend-app'
$SERVER_APP  = 'civstudio-server'
$STUDIO_SITE = 'https://civstudio.com'
$SERVER_SITE = 'https://dev.civstudio.com'

function Assert-Tool($name, $hint) {
  if (-not (Get-Command $name -ErrorAction SilentlyContinue)) { throw "$name not found on PATH — $hint" }
}
Assert-Tool az   'install the Azure CLI and run `az login`'
Assert-Tool node 'install Node (tools/verify-world.mjs runs the world invariants)'

# Restart the app's ACTIVE revision. Not `containerapp update` — the image is unchanged; we only want
# the process (and therefore its in-memory cache) replaced.
function Restart-App($app) {
  $rev = az containerapp revision list -g $RG -n $app --query "[?properties.active].name" -o tsv |
    Select-Object -First 1
  if (-not $rev) { throw "no active revision for $app — inspect: az containerapp revision list -g $RG -n $app" }
  Write-Host "==> restarting $app (revision $rev)" -ForegroundColor Cyan
  az containerapp revision restart -g $RG -n $app --revision $rev | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "restart failed for $app revision $rev" }
}

# Poll until the app answers. A restart returns as soon as the platform accepts it, so without this
# the next step races a container that is still booting — and the server must not re-fetch from a
# Strapi that has not come back up, which would just re-cache the stale bundle.
function Wait-Healthy($label, $url, $wantStatus, $tries = 40) {
  Write-Host "==> waiting for $label ($url)" -ForegroundColor Cyan
  for ($i = 1; $i -le $tries; $i++) {
    try {
      $code = (Invoke-WebRequest -Uri $url -TimeoutSec 10 -SkipHttpErrorCheck).StatusCode
      if ($code -eq $wantStatus) { Write-Host "    $label healthy ($code)" -ForegroundColor Green; return }
      Write-Host "    ...$label answering $code, want $wantStatus ($i/$tries)"
    } catch { Write-Host "    ...$label not answering yet ($i/$tries)" }
    Start-Sleep -Seconds 6
  }
  throw "$label did not become healthy at $url after ~$($tries * 6)s"
}

if (-not $SkipStudio) {
  Restart-App $STUDIO_APP
  Wait-Healthy 'studio' "$STUDIO_SITE/_health" 204
} else {
  Write-Host '==> -SkipStudio: leaving the Strapi projection cache alone' -ForegroundColor Yellow
}

if (-not $SkipServer) {
  Restart-App $SERVER_APP
  Wait-Healthy 'server' "$SERVER_SITE/actuator/health" 200
} else {
  Write-Host '==> -SkipServer: leaving the server bundle cache alone' -ForegroundColor Yellow
}

# The point of the whole exercise, in two questions.
#
# 1. Is the world the visitor gets usable at all? (a realm every province can belong to, no empty
#    realm in the picker, the province count over its floor)
Write-Host '==> verifying the served world' -ForegroundColor Cyan
node (Join-Path $PSScriptRoot 'verify-world.mjs') $SERVER_SITE
if ($LASTEXITCODE -ne 0) {
  throw ("WORLD VERIFY FAILED after refreshing the caches — the content itself is wrong, not merely " +
    "stale. Check what the seed actually wrote (the committed world-bundle.json.gz is the source), " +
    "and see the failed invariants above.")
}

# 2. …and is it the world this repo describes? A refresh that leaves prod on OLD content is the exact
#    failure this script exists to prevent, so it must not report success without checking.
#
#    --settle: Container Apps rolls replicas gradually, so the old one can still answer for a few
#    seconds after the new one is healthy. Reading once here gave a false "drift" on 2026-07-27; poll
#    until two readings agree instead.
Write-Host '==> verifying content parity with the committed snapshot' -ForegroundColor Cyan
node (Join-Path $PSScriptRoot 'verify-content-parity.mjs') $SERVER_SITE --settle 90
if ($LASTEXITCODE -ne 0) {
  throw ("CONTENT PARITY FAILED after refreshing the caches — the caches are fresh but the deployed " +
    "content is not what this repo describes. If the SEED has not run yet, run it (Seed Studio) and " +
    "re-run this script; if the SNAPSHOT is the stale one, " +
    "`node tools/verify-content-parity.mjs --restamp` and commit.")
}
Write-Host '==> done — the seeded content is live.' -ForegroundColor Green
