#Requires -Version 5.1
<#
.SYNOPSIS
以常驻托盘方式启动 codexm 控制台。

.DESCRIPTION
在独立的隐藏控制台里启动 `codexm ui --tray`，关闭启动它的窗口不会影响托盘进程。
启动前做单实例与端口检查，启动后等待端口就绪并打印控制台地址。

.EXAMPLE
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\start-tray.ps1

.EXAMPLE
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\start-tray.ps1 -Port 9000 -Force
#>
[CmdletBinding()]
param(
    [int]$Port = 8756,
    [string]$Cli = '',
    [string]$Node = '',
    [switch]$Force
)

$ErrorActionPreference = 'Stop'

<#
The VBS entry point runs this script with a hidden window, so Write-Host goes
nowhere and a failed start looks exactly like a successful one. Anything the
operator has to see comes back as a popup instead.
#>
function Show-Popup {
    param(
        [string]$Message,
        [string]$Title = 'codexm 托盘',
        [int]$Seconds = 0,
        [int]$Icon = 16
    )

    try {
        $shell = New-Object -ComObject WScript.Shell
        [void]$shell.Popup($Message, $Seconds, $Title, $Icon)
    } catch {
        # A popup is a courtesy; never let it mask the reason it was shown.
    }
}

trap {
    Show-Popup -Message "codexm 托盘启动失败：$($_.Exception.Message)" -Icon 16
    exit 1
}

function Resolve-CliPath {
    param([string]$Explicit)

    if ($Explicit) {
        return (Resolve-Path -LiteralPath $Explicit).Path
    }

    $projectRoot = Split-Path -Parent $PSScriptRoot
    $candidates = @((Join-Path $projectRoot 'dist\cli.js'))

    $shim = Get-Command codexm -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($shim) {
        $candidates += (Join-Path (Split-Path -Parent $shim.Source) 'node_modules\codex-team\dist\cli.js')
    }

    foreach ($candidate in $candidates) {
        if ($candidate -and (Test-Path -LiteralPath $candidate)) {
            return (Resolve-Path -LiteralPath $candidate).Path
        }
    }

    throw '找不到 cli.js，请用 -Cli 显式指定，例如 -Cli "C:\path\to\codex-team\dist\cli.js"'
}

function Resolve-NodePath {
    param([string]$Explicit)

    if ($Explicit) {
        return (Resolve-Path -LiteralPath $Explicit).Path
    }

    $cmd = Get-Command node -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($cmd) {
        return $cmd.Source
    }

    $fallback = Join-Path $env:ProgramFiles 'nodejs\node.exe'
    if (Test-Path -LiteralPath $fallback) {
        return $fallback
    }

    throw '找不到 node.exe，请用 -Node 显式指定，例如 -Node "C:\Program Files\nodejs\node.exe"'
}

if (-not $Force) {
    $existing = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -match 'codex-team' -and $_.CommandLine -match 'ui' -and $_.CommandLine -match '--tray' })

    if ($existing.Count -gt 0) {
        $message = "已有 codexm 托盘实例在运行（pid：$($existing.ProcessId -join '、')）。加 -Force 可以再起一个。"
        Write-Host $message -ForegroundColor Yellow
        # The running instance does not re-announce itself, so the double-click
        # would be silent. It is already up: just say so.
        Show-Popup -Message $message -Seconds 8 -Icon 64
        exit 0
    }

    $busy = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($busy) {
        throw "端口 $Port 已被占用（pid $($busy.OwningProcess)）。换个 -Port，或加 -Force 强制启动。"
    }
}

# The VBS entry point hides this window, so up to here a double-click showed
# nothing. Say what is happening (this file is UTF-8 with BOM, so the Chinese
# survives); it auto-closes instead of delaying the actual start.
Show-Popup -Message "正在启动 codexm 控制台，托盘区稍后会出现蓝色 C 图标，左键单击即可打开控制台。" -Seconds 3 -Icon 64

$cliPath = Resolve-CliPath $Cli
$nodePath = Resolve-NodePath $Node
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$outLog = Join-Path $env:TEMP "codexm-tray-$stamp.out.log"
$errLog = Join-Path $env:TEMP "codexm-tray-$stamp.err.log"

Write-Host "启动托盘：$nodePath $cliPath ui --tray --port $Port"

$proc = Start-Process -FilePath $nodePath `
    -ArgumentList @($cliPath, 'ui', '--tray', '--port', "$Port") `
    -WindowStyle Hidden `
    -RedirectStandardOutput $outLog `
    -RedirectStandardError $errLog `
    -PassThru

$listener = $null
$deadline = (Get-Date).AddSeconds(20)
while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 400
    $listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($listener) { break }
    if ($proc.HasExited) { break }
}

if (-not $listener -and $proc.HasExited) {
    $detail = "托盘启动失败，日志：$errLog"
    Write-Host $detail -ForegroundColor Red
    if (Test-Path -LiteralPath $errLog) { Get-Content -LiteralPath $errLog -Tail 20 }
    if (Test-Path -LiteralPath $outLog) { Get-Content -LiteralPath $outLog -Tail 20 }
    Show-Popup -Message $detail -Icon 16
    exit 1
}

if (-not $listener) {
    # Still running but never answered on the port: say so instead of claiming
    # a start that the operator cannot see.
    $detail = "等待端口 $Port 就绪超时（20 秒），控制台可能仍在启动。日志：$outLog"
    Write-Host $detail -ForegroundColor Yellow
    Show-Popup -Message $detail -Seconds 10 -Icon 48
}

$url = ''
if (Test-Path -LiteralPath $outLog) {
    $match = Select-String -LiteralPath $outLog -Pattern 'http://127\.0\.0\.1:\d+/\?token=[A-Za-z0-9_\-]+' -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($match) { $url = $match.Matches[0].Value }
}

Write-Host "codexm 托盘已启动：pid $($proc.Id)，端口 $Port" -ForegroundColor Green
if ($url) {
    Write-Host "控制台地址：$url" -ForegroundColor Cyan
}
Write-Host "日志：$outLog"
Write-Host '关闭本窗口不影响托盘；右键托盘图标 -> 退出 codexm 可停止服务。'
