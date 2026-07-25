#requires -Version 7
<#
.SYNOPSIS
    Run any engine main class with arguments, offline, against the committed world fixture.

.DESCRIPTION
    `mvn exec:exec` cannot pass program arguments: civstudio-engine/pom.xml hardcodes the JVM
    argument list and it ends at `${sim.main}`, so a dev tool that takes arguments
    (TerrainPreviewExporter, the geo/export exporters, …) has no way in. The workaround was to run
    `mvn dependency:build-classpath` by hand and invoke `java` with the world-source flags —
    every time, for every tool. This is that, as one command.

    Resolves the classpath once and CACHES it (target/dev-classpath.txt), reusing it while it is
    newer than every pom. Passes the same world-source flags `mvn test` and tools/dev-local.ps1 use,
    and enables assertions (-ea) like exec:exec does — the code uses `assert` as real invariant checks.

.PARAMETER MainClass
    Fully-qualified main class. A short name is resolved against com.civstudio.geo.export first,
    so `TerrainPreviewExporter` works.

.PARAMETER Args
    Everything after the class name is passed to the program verbatim.

.EXAMPLE
    pwsh tools/run.ps1 TerrainPreviewExporter lencenor_region out.png 3
    pwsh tools/run.ps1 com.civstudio.geo.export.WorldPlotGenerator -Region western_cannor_superregion
    pwsh tools/run.ps1 -Refresh WorldPlotGenerator          # force a classpath rebuild
    pwsh tools/run.ps1 -Heap 6g TerrainPreviewExporter forbidden_lands_superregion big.png
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory, Position = 0)]
    [string]   $MainClass,
    [Parameter(Position = 1, ValueFromRemainingArguments)]
    [string[]] $Arguments = @(),
    # Max heap. The whole-world raster + overlays are a few hundred MB; 3g suits every current tool.
    [string]   $Heap = '3g',
    # Where invariant world data comes from — same contract as tools/dev-local.ps1.
    [ValidateSet('fixture', 'strapi', 'classpath')]
    [string]   $WorldSource = 'fixture',
    [string]   $WorldBundle = 'civstudio-engine/src/test/resources/world-bundle.json.gz',
    # Rebuild the cached classpath even if it looks current.
    [switch]   $Refresh,
    # Skip the incremental compile (the classes are already current).
    [switch]   $SkipCompile
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
Push-Location $repoRoot
try {
    # short name -> the package dev tools actually live in
    if ($MainClass -notmatch '\.') { $MainClass = "com.civstudio.geo.export.$MainClass" }

    if (-not $SkipCompile) {
        Write-Host "==> compiling civstudio-engine" -ForegroundColor Cyan
        mvn -o -q -pl civstudio-engine compile
        if ($LASTEXITCODE -ne 0) { throw "compile failed" }
    }

    # The classpath only changes when a pom does, and resolving it costs several seconds — so cache
    # it and reuse while it is newer than every pom in the reactor.
    $cpFile = Join-Path $repoRoot 'civstudio-engine/target/dev-classpath.txt'
    $poms   = Get-ChildItem $repoRoot -Filter pom.xml -Depth 1
    $stale  = $Refresh -or -not (Test-Path $cpFile) -or
              ($poms | Where-Object { $_.LastWriteTime -gt (Get-Item $cpFile).LastWriteTime })
    if ($stale) {
        Write-Host "==> resolving the dependency classpath" -ForegroundColor Cyan
        mvn -o -q -pl civstudio-engine dependency:build-classpath "-Dmdep.outputFile=$cpFile"
        if ($LASTEXITCODE -ne 0) { throw "classpath resolution failed" }
    }
    $classpath = "$repoRoot/civstudio-engine/target/classes;$(Get-Content $cpFile -Raw)".Trim()

    $jvmArgs = @(
        "-Xmx$Heap"
        '-ea'                                                   # assertions ARE the invariant checks
        "-Dcivstudio.world-source.mode=$WorldSource"
        "-Dcivstudio.world-source.fixture=$WorldBundle"
        '-classpath', $classpath
        $MainClass
    ) + $Arguments

    Write-Host "==> $MainClass $($Arguments -join ' ')" -ForegroundColor Cyan
    & java @jvmArgs
    if ($LASTEXITCODE -ne 0) { throw "$MainClass exited $LASTEXITCODE" }
}
finally {
    Pop-Location
}
