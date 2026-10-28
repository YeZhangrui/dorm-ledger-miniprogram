# 用微信开发者工具自带的官方编译器校验本工程能否编译通过
#   用法：powershell -ExecutionPolicy Bypass -File .\_tools\compile-check.ps1
#   说明：wcsc.exe 编译 WXSS、wcc.exe 编译 WXML，任何一条失败都会打印行号与原因

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$bin = 'D:\微信web开发者工具\resources\app.asar.unpacked\node_modules\wcc-exec'
$wcsc = Join-Path $bin 'wcsc.exe'
$wcc = Join-Path $bin 'wcc.exe'

if (-not (Test-Path $wcsc)) { Write-Host "找不到 wcsc.exe，请确认开发者工具安装路径：$bin" -ForegroundColor Red; exit 1 }

$tmp = Join-Path $env:TEMP 'mp-compile-check'
New-Item -ItemType Directory -Force -Path $tmp | Out-Null
$fail = 0

Write-Host "=== WXSS ===" -ForegroundColor Cyan
Get-ChildItem -LiteralPath $root -Recurse -File -Filter *.wxss | ForEach-Object {
    $out = Join-Path $tmp ($_.BaseName + '.wxss.js')
    $log = & $wcsc -f $_.FullName -o $out 2>&1
    if ($LASTEXITCODE -ne 0) {
        $fail++
        Write-Host ("[失败] " + $_.FullName.Replace($root, '')) -ForegroundColor Red
        $log | ForEach-Object { Write-Host ("        " + $_) -ForegroundColor Red }
    } else {
        Write-Host ("[ok]   " + $_.FullName.Replace($root, ''))
    }
}

Write-Host "=== WXML ===" -ForegroundColor Cyan
Get-ChildItem -LiteralPath $root -Recurse -File -Filter *.wxml | ForEach-Object {
    $out = Join-Path $tmp ($_.BaseName + '.wxml.js')
    $log = & $wcc -s $_.FullName -o $out 2>&1
    if ($LASTEXITCODE -ne 0) {
        $fail++
        Write-Host ("[失败] " + $_.FullName.Replace($root, '')) -ForegroundColor Red
        $log | ForEach-Object { Write-Host ("        " + $_) -ForegroundColor Red }
    } else {
        Write-Host ("[ok]   " + $_.FullName.Replace($root, ''))
    }
}

Write-Host ""
if ($fail -eq 0) { Write-Host "全部通过：WXSS/WXML 都能编译" -ForegroundColor Green; exit 0 }
Write-Host "$fail 个文件编译失败" -ForegroundColor Red
exit 1
