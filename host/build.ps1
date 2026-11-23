$ErrorActionPreference = 'Stop'

$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
$out = Join-Path $PSScriptRoot 'vault-host.exe'

if (-not (Test-Path $csc)) { throw "找不到编译器：$csc" }

# 编译 host 目录下所有 .cs（VaultHost.cs + Crypto.cs + 以后新增的）
$sources = @(Get-ChildItem -LiteralPath $PSScriptRoot -Filter '*.cs' -File | Select-Object -ExpandProperty FullName)
if ($sources.Count -eq 0) { throw "没有找到任何 .cs 源文件" }

# 把同一枚图标嵌进 exe（资源管理器里看到的也不再是默认程序图标）
$icon = Join-Path (Split-Path $PSScriptRoot -Parent) 'installer\localvault.ico'
$iconArgs = @()
if (Test-Path -LiteralPath $icon) { $iconArgs += "/win32icon:$icon" }

$cscOut = & $csc /nologo /target:exe /platform:anycpu /optimize+ /out:$out /r:System.Web.Extensions.dll @iconArgs $sources 2>&1 | Out-String
if ($LASTEXITCODE -ne 0) { Write-Host $cscOut; throw "编译失败，退出码 $LASTEXITCODE" }

Get-Item $out | Select-Object FullName, Length, LastWriteTime | Format-List
