#Requires -Version 5.1
<#
    tools\ci.ps1 -- run every check of this mini-program project in one command.

    Steps (any failure -> exit code 1):
      1/4  unit tests       node --test tests\
      2/4  compile check    miniprogram\_tools\compile-check.ps1   (needs WeChat DevTools)
      3/4  static audit     miniprogram\_tools\static-audit.js     (fails on critical findings)
      4/4  contrast audit   miniprogram\_tools\contrast-audit.js   (WCAG 2.1 report)

    Usage (from the repo root D:\...):
      powershell -ExecutionPolicy Bypass -File .\tools\ci.ps1
      pwsh -File .\tools\ci.ps1
      .\tools\ci.ps1 -SkipCompile      # skip WXSS/WXML compile (box without the toolchain)
      .\tools\ci.ps1 -RequireCompile   # treat a missing toolchain as a failure

    Exit code: 0 = all steps passed (a SKIP is not a failure), 1 = something failed.

    Compatibility / encoding notes:
      * Windows PowerShell 5.1 and PowerShell 7 both run this file; only 5.1-era syntax is
        used (no ?? / ternary / && / || / $IsWindows / PSStyle).
      * The file is UTF-8 WITHOUT BOM and deliberately 100% ASCII.
        Windows PowerShell 5.1 decodes a BOM-less script with the system ANSI code page; on
        a GBK system (chcp 936) a non-ASCII comment line can swallow the following line feed
        and turn the rest of the block into part of the comment. Keeping the script ASCII
        makes it parse identically on 5.1 and 7. Chinese explanations live in the delivery
        report, not here.
      * Zero third-party dependencies: only node plus the scripts that already live in the
        repo are executed.
      * The two audit scripts write generated reports into miniprogram\_audit\ -- that is
        their own behaviour (they already did before this script existed), not something
        ci.ps1 writes.
#>
[CmdletBinding()]
param(
    # Skip the WXSS/WXML compile check (it needs wcsc.exe/wcc.exe from WeChat DevTools).
    [switch]$SkipCompile,

    # Fail instead of SKIP when the WeChat DevTools toolchain is missing.
    [switch]$RequireCompile
)

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$results = @()
$allWatch = [System.Diagnostics.Stopwatch]::StartNew()

# Same location as $bin inside miniprogram\_tools\compile-check.ps1.
# Used only to tell "toolchain not installed" apart from "compilation failed".
# The DevTools folder name is Chinese; it is assembled from code points so that this file
# stays ASCII (see the encoding note above: a literal here would be corrupted by 5.1).
$devtoolsDir = 'D:\' +
    [char]0x5FAE + [char]0x4FE1 + 'web' +
    [char]0x5F00 + [char]0x53D1 + [char]0x8005 + [char]0x5DE5 + [char]0x5177
$wcsc = Join-Path $devtoolsDir 'resources\app.asar.unpacked\node_modules\wcc-exec\wcsc.exe'

function Write-Section {
    param([string]$Title)
    Write-Host ''
    Write-Host ('=' * 74) -ForegroundColor DarkGray
    Write-Host ('  ' + $Title) -ForegroundColor Cyan
    Write-Host ('=' * 74) -ForegroundColor DarkGray
}

function Start-Step {
    param([string]$Title)
    Write-Section $Title
    return [System.Diagnostics.Stopwatch]::StartNew()
}

function Format-Elapsed {
    param([double]$Seconds)
    return ([string]::Format('{0,6:N1}s', $Seconds))
}

function Complete-Step {
    param(
        [string]$Name,
        [int]$Code,
        [double]$Seconds,
        [switch]$Skipped,
        [string]$Note
    )

    $status = 'pass'
    if ($Skipped) {
        $status = 'skip'
    } elseif ($Code -ne 0) {
        $status = 'fail'
    }

    $line = '  [' + $status.ToUpper() + '] ' + $Name + '  ' + (Format-Elapsed $Seconds)
    if ($Note) { $line = $line + '  ' + $Note }

    if ($status -eq 'fail') {
        Write-Host $line -ForegroundColor Red
    } elseif ($status -eq 'skip') {
        Write-Host $line -ForegroundColor Yellow
    } else {
        Write-Host $line -ForegroundColor Green
    }

    $script:results += [pscustomobject]@{
        Name    = $Name
        Status  = $status
        Seconds = $Seconds
    }
}

function Show-Summary {
    Write-Host ''
    Write-Host ('-' * 74) -ForegroundColor DarkGray
    Write-Host '  SUMMARY' -ForegroundColor Cyan
    Write-Host ('-' * 74) -ForegroundColor DarkGray

    foreach ($r in $script:results) {
        $row = '  ' + ('[' + $r.Status.ToUpper() + ']').PadRight(8) + $r.Name.PadRight(50) + (Format-Elapsed $r.Seconds)
        if ($r.Status -eq 'fail') {
            Write-Host $row -ForegroundColor Red
        } elseif ($r.Status -eq 'skip') {
            Write-Host $row -ForegroundColor Yellow
        } else {
            Write-Host $row -ForegroundColor Green
        }
    }

    $passed = @($script:results | Where-Object { $_.Status -eq 'pass' }).Count
    $failed = @($script:results | Where-Object { $_.Status -eq 'fail' }).Count
    $skipped = @($script:results | Where-Object { $_.Status -eq 'skip' }).Count
    $allWatch.Stop()

    Write-Host ('-' * 74) -ForegroundColor DarkGray
    $summary = '  steps: ' + $script:results.Count + ' total, ' + $passed + ' passed, ' +
        $failed + ' failed, ' + $skipped + ' skipped; wall time ' +
        (Format-Elapsed $allWatch.Elapsed.TotalSeconds).Trim()
    if ($failed -gt 0) {
        Write-Host $summary -ForegroundColor Red
        Write-Host '  RESULT: FAIL' -ForegroundColor Red
    } else {
        Write-Host $summary -ForegroundColor Green
        Write-Host '  RESULT: PASS' -ForegroundColor Green
    }
    Write-Host ''
    return $failed
}

# --------------------------------------------------------------------------
# environment
# --------------------------------------------------------------------------

Write-Host ''
Write-Host '  ci.ps1 -- dorm public expense ledger: full check run' -ForegroundColor Cyan
Write-Host ('  repo       : ' + $root)
Write-Host ('  powershell : ' + $PSVersionTable.PSVersion.ToString())

$node = Get-Command node -ErrorAction SilentlyContinue
if ($null -eq $node) {
    Write-Host '  [FAIL] node not found in PATH; install Node 20+ first.' -ForegroundColor Red
    exit 1
}
$nodeVersion = (& node --version)
Write-Host ('  node       : ' + $nodeVersion)
Write-Host ''

# --------------------------------------------------------------------------
# 1/4 unit tests
# --------------------------------------------------------------------------

$step = Start-Step 'step 1/4  unit tests      node --test tests\'
Push-Location -LiteralPath $root
try {
    & node --test tests\
    $code = $LASTEXITCODE
} catch {
    Write-Host ('  [ERROR] ' + $_.Exception.Message) -ForegroundColor Red
    $code = 1
} finally {
    Pop-Location
    $step.Stop()
}
Complete-Step -Name 'node --test tests\' -Code $code -Seconds $step.Elapsed.TotalSeconds -Note ('exit=' + $code)

# --------------------------------------------------------------------------
# 2/4 compile check (WXSS / WXML via WeChat DevTools)
# --------------------------------------------------------------------------

$compileScript = Join-Path $root 'miniprogram\_tools\compile-check.ps1'
$step = Start-Step 'step 2/4  compile check   miniprogram\_tools\compile-check.ps1  (WeChat DevTools)'

if ($SkipCompile) {
    $step.Stop()
    Complete-Step -Name 'compile-check.ps1' -Code 0 -Seconds $step.Elapsed.TotalSeconds -Skipped `
        -Note 'skipped by -SkipCompile'
} elseif (-not (Test-Path -LiteralPath $compileScript)) {
    $step.Stop()
    Write-Host ('  script not found: ' + $compileScript) -ForegroundColor Red
    Complete-Step -Name 'compile-check.ps1' -Code 1 -Seconds $step.Elapsed.TotalSeconds -Note 'script not found'
} elseif (-not (Test-Path -LiteralPath $wcsc)) {
    $step.Stop()
    Write-Host ('  wcsc.exe not found: ' + $wcsc) -ForegroundColor Yellow
    Write-Host '  WeChat DevTools is not installed here, so WXSS/WXML cannot be compiled.' -ForegroundColor Yellow
    if ($RequireCompile) {
        Write-Host '  -RequireCompile given: counted as FAILURE.' -ForegroundColor Red
        Complete-Step -Name 'compile-check.ps1' -Code 1 -Seconds $step.Elapsed.TotalSeconds `
            -Note 'WeChat DevTools toolchain missing'
    } else {
        Write-Host '  Counted as SKIP (pass -RequireCompile to make it fail).' -ForegroundColor Yellow
        Complete-Step -Name 'compile-check.ps1' -Code 0 -Seconds $step.Elapsed.TotalSeconds -Skipped `
            -Note 'WeChat DevTools toolchain missing'
    }
} else {
    # Run it in a child process: the script ends with exit 0 / exit 1, and an in-process
    # `exit` would take this script down with it.
    if ($PSVersionTable.PSVersion.Major -ge 6) {
        $psExe = Join-Path $PSHOME 'pwsh.exe'
    } else {
        $psExe = Join-Path $PSHOME 'powershell.exe'
    }
    try {
        & $psExe -NoProfile -ExecutionPolicy Bypass -File $compileScript
        $code = $LASTEXITCODE
    } catch {
        Write-Host ('  [ERROR] ' + $_.Exception.Message) -ForegroundColor Red
        $code = 1
    } finally {
        $step.Stop()
    }
    Complete-Step -Name 'compile-check.ps1' -Code $code -Seconds $step.Elapsed.TotalSeconds -Note ('exit=' + $code)
}

# --------------------------------------------------------------------------
# 3/4 static audit (exits 1 only on critical findings)
# --------------------------------------------------------------------------

$staticAudit = Join-Path $root 'miniprogram\_tools\static-audit.js'
$step = Start-Step 'step 3/4  static audit    miniprogram\_tools\static-audit.js  (critical bug scan)'
Push-Location -LiteralPath $root
try {
    & node $staticAudit
    $code = $LASTEXITCODE
} catch {
    Write-Host ('  [ERROR] ' + $_.Exception.Message) -ForegroundColor Red
    $code = 1
} finally {
    Pop-Location
    $step.Stop()
}
Complete-Step -Name 'static-audit.js' -Code $code -Seconds $step.Elapsed.TotalSeconds -Note ('exit=' + $code)

# --------------------------------------------------------------------------
# 4/4 contrast audit (WCAG 2.1 report; exits 1 only when it cannot parse WXSS)
# --------------------------------------------------------------------------

$contrastAudit = Join-Path $root 'miniprogram\_tools\contrast-audit.js'
$step = Start-Step 'step 4/4  contrast audit  miniprogram\_tools\contrast-audit.js  (WCAG 2.1)'
Push-Location -LiteralPath $root
try {
    & node $contrastAudit
    $code = $LASTEXITCODE
} catch {
    Write-Host ('  [ERROR] ' + $_.Exception.Message) -ForegroundColor Red
    $code = 1
} finally {
    Pop-Location
    $step.Stop()
}
Complete-Step -Name 'contrast-audit.js' -Code $code -Seconds $step.Elapsed.TotalSeconds -Note ('exit=' + $code)

# --------------------------------------------------------------------------
# summary
# --------------------------------------------------------------------------

$failedSteps = Show-Summary
if ($failedSteps -gt 0) {
    exit 1
}
exit 0
