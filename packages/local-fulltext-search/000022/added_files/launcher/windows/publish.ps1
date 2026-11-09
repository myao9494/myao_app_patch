# WPF ランチャーを launcher/windows/publish/ へ発行する（配布先に .NET SDK が無いため、発行物をコミットする）。
#
# 【仕様】
# - 実行中のランチャーがあると発行物を置き換えられないため、既定では止めずにエラーで終える。
#   -StopRunningLauncher を付けたときだけ実行中のランチャーを終了してから発行する
#   （未保存の常時保持メモは最大 0.6 秒分失われることがある）。
# - 削除・発行・置き換えのどれかに失敗したら、古い発行物を残したまま成功扱いにせずエラーで終える。
param(
  [ValidateSet("all", "folder", "single-file")][string]$Mode = "all",
  [switch]$StopRunningLauncher
)
$ErrorActionPreference = "Stop"
$project = Join-Path $PSScriptRoot "LocalSearchLauncher\LocalSearchLauncher.csproj"
$output = Join-Path $PSScriptRoot "publish"
$dotnetCommand = Get-Command dotnet -ErrorAction SilentlyContinue
$dotnet = if ($dotnetCommand) { $dotnetCommand.Source } else { Join-Path $env:LOCALAPPDATA "Microsoft\dotnet\dotnet.exe" }
if (-not (Test-Path $dotnet)) {
  throw ".NET 8 SDK が見つかりません。launcher/windows/README.md の手順でSDKを導入してください。"
}

$running = @(Get-Process LocalSearchLauncher -ErrorAction SilentlyContinue)
if ($running.Count -gt 0) {
  if (-not $StopRunningLauncher) {
    throw "LocalSearchLauncher が実行中です。終了してから実行するか、-StopRunningLauncher を付けて実行してください。"
  }
  $running | Stop-Process -Force
  $running | Wait-Process -Timeout 10
}

function Reset-PublishDirectory([string]$Path) {
  $root = [IO.Path]::GetFullPath($output).TrimEnd([IO.Path]::DirectorySeparatorChar)
  $target = [IO.Path]::GetFullPath($Path)
  if (-not $target.StartsWith($root + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw "発行先が launcher/windows/publish の外にあります: $target"
  }
  if (Test-Path $target) { Remove-Item -LiteralPath $target -Recurse -Force }
  New-Item -ItemType Directory -Path $target -Force | Out-Null
}

function Invoke-Publish([string[]]$Arguments) {
  & $dotnet publish $project -c Release -r win-x64 --self-contained true -p:DebugType=None -p:DebugSymbols=false @Arguments
  if ($LASTEXITCODE -ne 0) { throw "dotnet publish が失敗しました（終了コード $LASTEXITCODE）" }
}

if ($Mode -in @("all", "folder")) {
  $folderOutput = Join-Path $output "folder"
  Reset-PublishDirectory $folderOutput
  Invoke-Publish @("-p:PublishSingleFile=false", "-o", $folderOutput)
}
if ($Mode -in @("all", "single-file")) {
  $singleFileOutput = Join-Path $output "single-file"
  $stagingOutput = Join-Path $output "single-file-staging"
  Reset-PublishDirectory $stagingOutput
  Invoke-Publish @("-p:PublishSingleFile=true", "-p:IncludeNativeLibrariesForSelfExtract=true", "-o", $stagingOutput)
  New-Item -ItemType Directory -Path $singleFileOutput -Force | Out-Null
  # Windows PowerShell 5.1（.NET Framework）には上書き指定付きの File.Move が無いため Move-Item -Force を使う
  Move-Item -LiteralPath (Join-Path $stagingOutput "LocalSearchLauncher.exe") -Destination (Join-Path $singleFileOutput "LocalSearchLauncher.exe") -Force
  Remove-Item -LiteralPath $stagingOutput -Recurse -Force
}
