<#
.SYNOPSIS
  Build, push, and deploy the CivStudio spectator server to Azure Container Apps.

.DESCRIPTION
  The streamlined local-Docker path (needs Rancher Desktop / Docker Desktop with dockerd +
  an authenticated `az` session). Pushes the image to GitHub Container Registry
  (ghcr.io/betaphreak/civstudio-server) and rolls the Container App. The GHCR package is PUBLIC, so
  the Container App pulls it with no registry credentials (one-time: after the first push, set the
  package to Public in the repo's Packages settings, or the pull 401s).

  Always redeploy after a change that affects what the live server serves (engine resources,
  the web-asset manifest / plotIndex, the bundle, or server code) — the static site and server
  drift apart otherwise and the plot layer silently breaks. See docs/client-server.md §Deployment.

  Steps: verify docker + az → docker login ghcr.io → docker build (multi-stage, bakes the engine jar
  + build-info) → docker push → az containerapp update → poll /actuator until the new version serves →
  prune old local images (only on a verified-live deploy; the registry keeps them for rollback).

  Auth for the push: `$env:GHCR_TOKEN` (a PAT with write:packages) if set, else the gh CLI token
  (`gh auth token`; needs the write:packages scope — `gh auth refresh -h github.com -s write:packages`).

.PARAMETER Tag
  Image tag. Defaults to the current git commit SHA (the deploy convention). A dirty tree gets
  a "-dirty" suffix so an uncommitted build is never mistaken for a commit.

.PARAMETER SkipBuild
  Skip build+push and just roll the Container App to an image tag already in GHCR.

.PARAMETER ForceBuild
  Force a local build+push even when the tag already exists on GHCR (the default auto-skips it).

.EXAMPLE
  pwsh tools/deploy-server.ps1
  pwsh tools/deploy-server.ps1 -Tag 90db0ac... -SkipBuild
#>
[CmdletBinding()]
param(
  [string]$Tag,
  [switch]$SkipBuild,
  [switch]$ForceBuild,
  # Skip the pre-roll plot-cache check. Only for a deploy that genuinely does not depend on the
  # map cache, or when the storage check itself is broken — see Assert-PlotCacheBaked.
  [switch]$SkipCacheCheck,
  # Skip the post-roll WORLD check (tools/verify-world.mjs). For a box with no node, or to push a
  # deploy through while the world is knowingly broken and the fix is the next deploy.
  [switch]$SkipWorldCheck
)
$ErrorActionPreference = 'Stop'

$RG       = 'civstudio'
$APP      = 'civstudio-server'
$LOGIN    = 'ghcr.io'                          # registry login server
$OWNER    = 'betaphreak'                       # ghcr namespace (GitHub owner, lowercase)
$REPO     = 'civstudio-server'
$SITE     = 'https://dev.civstudio.com'                 # the deployed server
$HEALTH   = "$SITE/actuator/info"                       # where we confirm the roll landed
# The Azure Files share the Container App mounts at /mnt/anbennar (PLOT_CACHE_DIR=/mnt/anbennar/map),
# i.e. where the regenerate-map workflow uploads the baked plot cache. Kept as constants alongside
# $RG/$APP; they are verifiable with
#   az containerapp env storage show -g civstudio -n <env> --storage-name anbennar
$STORAGE  = 'civstudiostore'
$SHARE    = 'anbennar-cache'
$CACHEDIR = 'map'                              # subdir of the share; v<MAP_VERSION> lives under it

# ── Pre-roll guard: never roll an image onto a MAP_VERSION whose cache was never baked ────────────
# The release has three legs and only two are automated: deploy-web ships web/ in ~1 min, the
# regenerate-map workflow bakes + uploads the cache in ~4, and THIS script is a manual local step
# with no ordering constraint at all. Roll a v<N> image at a share with no map/v<N>/ and the server
# does not fail — it silently regenerates every province on demand (slow) and writes into the share,
# racing whatever azcopy is still uploading. That is the exact failure regenerate-map.yml's own
# MAP_VERSION guard exists to prevent on the other side; this is the matching half.
#
# Fails CLOSED, including when the check cannot be *determined* (no az permission, CLI error): a
# deploy that cannot prove the cache is there stops and names -SkipCacheCheck as the way past. A
# credential hiccup blocking a deploy is far cheaper than prod regenerating 5268 provinces live.
function Assert-PlotCacheBaked {
  param([string]$RepoRoot)

  $store = Join-Path $RepoRoot 'civstudio-engine/src/main/java/com/civstudio/settlement/ProvincePlotStore.java'
  $line  = Select-String -Path $store -Pattern 'MAP_VERSION\s*=\s*(\d+)' | Select-Object -First 1
  if (-not $line) { throw "could not read MAP_VERSION from $store" }
  $version = $line.Matches[0].Groups[1].Value
  $dir = "$CACHEDIR/v$version"
  Write-Host "==> checking the plot cache for MAP_VERSION $version ($SHARE/$dir)" -ForegroundColor Cyan

  $key = az storage account keys list -n $STORAGE -g $RG --query "[0].value" -o tsv 2>$null
  if ($LASTEXITCODE -ne 0 -or -not $key) {
    throw ("cannot read the storage key for $STORAGE (az storage account keys list failed), so the " +
      "plot cache for MAP_VERSION $version cannot be verified. Fix the az session, or pass " +
      "-SkipCacheCheck if you are certain map/v$version is baked.")
  }

  # one cheap listing of the cache root: are the version dirs there at all?
  $versions = @(az storage file list --account-name $STORAGE --account-key $key `
      --share-name $SHARE --path $CACHEDIR --query "[].name" -o tsv 2>$null)
  if ($LASTEXITCODE -ne 0) {
    throw ("cannot list $SHARE/$CACHEDIR, so the plot cache for MAP_VERSION $version cannot be " +
      "verified. Pass -SkipCacheCheck to override.")
  }
  if ($versions -notcontains "v$version") {
    throw ("PLOT CACHE MISSING: $SHARE/$dir does not exist, but this build serves MAP_VERSION " +
      "$version. Rolling now would make prod regenerate every province on demand and write into " +
      "the share. Bake it first:`n" +
      "    gh workflow run 'Regenerate map'      # or push the MAP_VERSION bump`n" +
      "  present on the share: $($versions -join ', ')")
  }

  # present — but an interrupted upload leaves a thin dir, so confirm it holds a real world.
  # --num-results caps the listing (5000+ files); we only need "is this plausibly complete".
  $sample = @(az storage file list --account-name $STORAGE --account-key $key `
      --share-name $SHARE --path $dir --num-results 4000 --query "[].name" -o tsv 2>$null)
  if ($sample.Count -lt 4000) {
    throw ("PLOT CACHE INCOMPLETE: $SHARE/$dir holds only $($sample.Count) files (a full world is " +
      "~5000). An upload was probably interrupted. Re-run the bake:`n" +
      "    gh workflow run 'Regenerate map'`n" +
      "  or pass -SkipCacheCheck to roll anyway.")
  }
  Write-Host "    ok: $SHARE/$dir is baked (>= $($sample.Count) province files)" -ForegroundColor Green
}

# Does OWNER/REPO:TAG already exist on GHCR? `docker manifest inspect` queries the registry directly
# using Docker's stored credential (incl. helpers like wincred) and — verified — needs NO running
# daemon (works with a dead DOCKER_HOST), so a clean-HEAD deploy can roll without starting Docker.
# Exit 0 = present; any failure (absent / docker CLI missing / no cred) → $false, so we fall back to
# building. Uses Docker's own auth (no packages scope needed). CI (deploy-server.yml) bakes the same
# BUILD_COMMIT/BUILD_NUMBER, so the CI image passes the build-info post-roll verify.
function Test-GhcrTagExists {
  param([string]$Owner, [string]$Repo, [string]$ImageTag)
  docker manifest inspect "$LOGIN/$Owner/$Repo`:$ImageTag" 2>$null | Out-Null
  return ($LASTEXITCODE -eq 0)
}

$repoRoot = Split-Path -Parent $PSScriptRoot  # tools/ -> repo root
Push-Location $repoRoot
try {
  if (-not $Tag) {
    # string-coerce: a clean tree makes `git status --porcelain` emit nothing → $null, and .Trim()
    # on $null throws. "$(...)" flattens null/multi-line output to a single string first.
    $sha   = "$(git rev-parse HEAD)".Trim()
    $dirty = "$(git status --porcelain)".Trim()
    $Tag   = if ($dirty) { "$sha-dirty" } else { $sha }
  }
  $image = "$LOGIN/$OWNER/$REPO`:$Tag"
  # build identity baked into /actuator/info (the .git is not in the image context, so pass it in) —
  # computed ALWAYS (not just when building) so the post-roll verify can assert the served commit.
  $buildNumber = "$(git rev-list --count HEAD)".Trim()   # auto-incrementing monotonic build number
  $buildCommit = "$(git rev-parse --short HEAD)".Trim()
  Write-Host "==> Deploying image: $image (build #$buildNumber, commit $buildCommit)" -ForegroundColor Cyan

  if ($SkipBuild -and $ForceBuild) { throw "Pass at most one of -SkipBuild / -ForceBuild." }

  # AUTO-SKIP THE LOCAL BUILD when the tag is already on GHCR — CI (deploy-server.yml) builds+pushes
  # every committed SHA in a few min (baking the same BUILD_COMMIT/BUILD_NUMBER), so a clean-HEAD
  # deploy is normally just a roll (no Docker needed). A dirty tree tags "<sha>-dirty" (never on GHCR)
  # so it always builds. -ForceBuild overrides.
  if (-not $SkipBuild -and -not $ForceBuild) {
    Write-Host "==> checking GHCR for $Tag" -ForegroundColor Cyan
    if (Test-GhcrTagExists $OWNER $REPO $Tag) {
      Write-Host "    already on GHCR (CI built it) — roll only; skipping local build. Use -ForceBuild to rebuild." -ForegroundColor Green
      $SkipBuild = $true
    } else {
      Write-Host "    not on GHCR — will build locally." -ForegroundColor Yellow
    }
  }

  # sanity: the roll always needs an authed az session; Docker only matters when we actually build.
  az account show --query name -o tsv | Out-Null

  # …and the cache this build's MAP_VERSION will read must already be on the share (see the function).
  # Checked BEFORE the build so a missing bake costs seconds, not a full image build.
  if ($SkipCacheCheck) {
    Write-Warning "-SkipCacheCheck: NOT verifying the plot cache for this build's MAP_VERSION."
  } else {
    Assert-PlotCacheBaked -RepoRoot $repoRoot
  }

  if (-not $SkipBuild) {
    docker info --format '{{.ServerVersion}}' | Out-Null
    Write-Host "==> docker login ghcr.io" -ForegroundColor Cyan
    # a PAT with write:packages (env GHCR_TOKEN) wins; else fall back to the gh CLI token, which
    # needs that scope too (`gh auth refresh -h github.com -s write:packages`).
    $ghcrToken = if ($env:GHCR_TOKEN) { $env:GHCR_TOKEN } else { (gh auth token 2>$null) }
    if (-not $ghcrToken) { throw "No GHCR token: set `$env:GHCR_TOKEN (PAT w/ write:packages) or sign in with `gh auth login`." }
    $ghcrToken | docker login $LOGIN --username $OWNER --password-stdin | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "docker login $LOGIN failed (token needs write:packages: gh auth refresh -h github.com -s write:packages)" }

    Write-Host "==> docker build (build #$buildNumber, commit $buildCommit)" -ForegroundColor Cyan
    docker build -t $image `
      --build-arg BUILD_NUMBER=$buildNumber `
      --build-arg BUILD_COMMIT=$buildCommit `
      -f Dockerfile .
    if ($LASTEXITCODE -ne 0) { throw "docker build failed" }

    Write-Host "==> docker push" -ForegroundColor Cyan
    docker push $image
    if ($LASTEXITCODE -ne 0) { throw "docker push failed" }
  }

  # capture what's serving NOW, so the post-roll verify can confirm a genuinely new build takes over.
  # build.time is stamped at package time (advances on a real rebuild); build.commit is the SHA baked
  # from BUILD_COMMIT. Read before the roll; empty on a cold/first deploy.
  $beforeTime = $null
  try { $beforeTime = (Invoke-RestMethod -Uri $HEALTH -TimeoutSec 10).build.time } catch { }

  Write-Host "==> az containerapp update" -ForegroundColor Cyan
  $state = az containerapp update -n $APP -g $RG --image $image `
    --query "properties.provisioningState" -o tsv
  Write-Host "    provisioningState = $state"

  # POST-ROLL VERIFY — provisioningState is NOT enough (it goes Succeeded while the OLD revision keeps
  # serving; the version string is a static SNAPSHOT). Poll until the served build.commit matches THIS
  # build AND build.time advanced past what was serving before — so a stale image, a roll that didn't
  # take, or the old revision still on traffic FAILS the deploy loudly instead of looking green.
  Write-Host "==> verifying the new build is live at $HEALTH (want commit $buildCommit)" -ForegroundColor Cyan
  $ok = $false
  for ($i = 1; $i -le 30; $i++) {
    try {
      $info = Invoke-RestMethod -Uri $HEALTH -TimeoutSec 10
      if ($info.build.commit -eq $buildCommit -and $info.build.time -ne $beforeTime) {
        Write-Host "    live: commit $($info.build.commit), build #$($info.build.number), built $($info.build.time)" -ForegroundColor Green
        $ok = $true; break
      }
      Write-Host "    ...serving commit $($info.build.commit) built $($info.build.time) — want $buildCommit w/ a newer build ($i/30)"
    } catch { Write-Host "    ...not answering yet ($i/30)" }
    Start-Sleep -Seconds 10
  }
  if (-not $ok) {
    throw ("POST-ROLL VERIFY FAILED: $HEALTH is not serving this build (commit $buildCommit) after ~5 min — " +
      "the new revision did not take over (stale image, unhealthy revision, or traffic still on the old one). " +
      "Inspect: az containerapp revision list -n $APP -g $RG")
  }

  # WORLD VERIFY — the check above proves the right BITS are serving; it says nothing about whether
  # they serve a usable world. On 2026-07-27 it passed green while 3,609 provinces sat stranded under
  # the retired `halcann` realm key, so the live realm picker read "Cannor: 0 provinces" and the demo
  # could not be reached. Identity is not health. See tools/world-invariants.mjs.
  if (-not $SkipWorldCheck) {
    Write-Host "==> verifying the served WORLD ($SITE/api/bundle)" -ForegroundColor Cyan
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
      throw ("node is required for the post-roll world check (tools/verify-world.mjs). " +
        "Install node, or re-run with -SkipWorldCheck to deploy without it.")
    }
    node (Join-Path $PSScriptRoot 'verify-world.mjs') $SITE
    if ($LASTEXITCODE -ne 0) {
      throw ("WORLD VERIFY FAILED: $SITE serves build $buildCommit, but the world it serves is broken " +
        "(see the failed invariants above). The deploy landed; the map is not usable. " +
        "Roll back with: pwsh tools/deploy-server.ps1 -SkipBuild -Tag <previous-tag>")
    }

    # …and is it the world this repo describes? A usable world can still be the WRONG one — the
    # deployed content store drifts from the committed snapshot independently of any code change,
    # and nothing else in the pipeline compares them. Reported as a WARNING, not a failure: content
    # lives outside this deploy (it is reseeded separately), so a mismatch means "reseed next", not
    # "this roll was bad".
    node (Join-Path $PSScriptRoot 'verify-content-parity.mjs') $SITE --settle 90
    if ($LASTEXITCODE -ne 0) {
      Write-Warning ("CONTENT PARITY: $SITE is not serving the content in this repo (see above). " +
        "The server roll itself is fine. To bring content into line: run the Seed Studio workflow, " +
        "then `pwsh tools/refresh-content.ps1`.")
    }
  }

  # HOUSEKEEPING — only now that the new build is verified live: drop old LOCAL images. The registry
  # keeps every tag, so rollback (`-SkipBuild -Tag <old>`) still pulls old images from GHCR; locally we
  # only need the one just deployed. Removes the other civstudio-server tags + any dangling images (not
  # the build cache — that stays, to keep the next rebuild fast). Best-effort: the deploy already
  # succeeded, so a cleanup hiccup must never fail it.
  # Only when we built locally — a roll-only deploy has no local images (and no Docker daemon needed).
  if (-not $SkipBuild) {
    Write-Host "==> cleaning up old local images (keeping $Tag)" -ForegroundColor Cyan
    $prevEAP = $ErrorActionPreference
    try {
      $ErrorActionPreference = 'Continue'   # a single rmi failure must not abort the loop
      $old = @(docker images "$LOGIN/$OWNER/$REPO" --format '{{.Tag}}' | Where-Object { $_ -and $_ -ne $Tag })
      foreach ($t in $old) { docker rmi "$LOGIN/$OWNER/$REPO`:$t" 2>$null | Out-Null }
      docker image prune -f 2>$null | Out-Null   # dangling (untagged) images
      Write-Host "    removed $($old.Count) old local tag(s) + dangling images; kept $Tag" -ForegroundColor Green
    } catch {
      Write-Warning "image cleanup skipped (deploy already succeeded): $_"
    } finally {
      $ErrorActionPreference = $prevEAP
    }
  }

  Write-Host "==> done." -ForegroundColor Cyan
}
finally {
  Pop-Location
}
