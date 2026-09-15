import { spawn } from "node:child_process";

export type TrayAction = "open" | "relaunch-desktop" | "refresh" | "sync" | "quit";

export type TrayHost = {
  /** Resolves once the tray icon is live; rejects if the host process cannot start. */
  ready: Promise<void>;
  stop: () => void;
};

export type TrayHandlers = {
  onAction: (action: TrayAction) => void;
  onExit?: (() => void) | undefined;
  onDiagnostic?: ((message: string) => void) | undefined;
};

/**
 * The tray is a Windows-only presentation shell: it hosts a NotifyIcon in a
 * separate STA PowerShell process and reports clicks back as action names.
 * `--tray` on other platforms degrades to the plain console, so no platform
 * state leaks into this boundary.
 */
const TRAY_SCRIPT = `$ErrorActionPreference = 'Stop'
[void][System.Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms')
[void][System.Reflection.Assembly]::LoadWithPartialName('System.Drawing')

function Emit([string]$Command) {
  [Console]::Out.WriteLine($Command)
  [Console]::Out.Flush()
}

$bitmap = New-Object System.Drawing.Bitmap 32, 32
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$graphics.Clear([System.Drawing.Color]::FromArgb(24, 33, 49))
$iconBrush = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(91, 140, 255))
$iconFont = [System.Drawing.Font]::new('Segoe UI', 18, [System.Drawing.FontStyle]::Bold)
$graphics.DrawString('C', $iconFont, $iconBrush, 4, 1)
$trayIcon = [System.Drawing.Icon]::FromHandle($bitmap.GetHicon())

$notifyIcon = New-Object System.Windows.Forms.NotifyIcon
$notifyIcon.Icon = $trayIcon
$notifyIcon.Text = 'codexm 控制台'
$notifyIcon.Visible = $true

$menu = New-Object System.Windows.Forms.ContextMenu

$openItem = New-Object System.Windows.Forms.MenuItem '打开控制台'
$openItem.add_Click({ Emit 'open' })
[void]$menu.MenuItems.Add($openItem)

$relaunchItem = New-Object System.Windows.Forms.MenuItem '重启桌面端'
$relaunchItem.add_Click({ Emit 'relaunch-desktop' })
[void]$menu.MenuItems.Add($relaunchItem)

$refreshItem = New-Object System.Windows.Forms.MenuItem '刷新配额'
$refreshItem.add_Click({ Emit 'refresh' })
[void]$menu.MenuItems.Add($refreshItem)

$syncItem = New-Object System.Windows.Forms.MenuItem '同步到 registry'
$syncItem.add_Click({ Emit 'sync' })
[void]$menu.MenuItems.Add($syncItem)

[void]$menu.MenuItems.Add('-')

$quitItem = New-Object System.Windows.Forms.MenuItem '退出 codexm'
$quitItem.add_Click({
  Emit 'quit'
  $notifyIcon.Visible = $false
  $notifyIcon.Dispose()
  [System.Windows.Forms.Application]::Exit()
})
[void]$menu.MenuItems.Add($quitItem)

$notifyIcon.ContextMenu = $menu
$notifyIcon.add_Click({
  param($sender, $eventArgs)
  if ($eventArgs.Button -eq [System.Windows.Forms.MouseButtons]::Left) {
    Emit 'open'
  }
})

# A tray-only start shows no window and no browser tab, so without this the
# launch looks like a no-op. Clicking the bubble is the same as clicking the icon.
$notifyIcon.add_BalloonTipClicked({ Emit 'open' })

Emit 'ready'

$notifyIcon.BalloonTipTitle = 'codexm 控制台已启动'
$notifyIcon.BalloonTipText = '左键单击图标打开控制台，右键查看更多操作。'
$notifyIcon.BalloonTipIcon = [System.Windows.Forms.ToolTipIcon]::Info
$notifyIcon.ShowBalloonTip(8000)

[System.Windows.Forms.Application]::Run()
$notifyIcon.Visible = $false
$notifyIcon.Dispose()
`;

const KNOWN_ACTIONS = new Set<string>(["open", "relaunch-desktop", "refresh", "sync", "quit"]);

export function startWindowsTray(handlers: TrayHandlers): TrayHost {
  let resolveReady: (() => void) | null = null;
  let rejectReady: ((error: Error) => void) | null = null;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  // A rejected promise with no handler would crash the process; the host is
  // optional, so failures are surfaced through the returned promise only.
  ready.catch(() => undefined);

  let stopped = false;

  const child = spawn(
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-STA",
      "-ExecutionPolicy",
      "Bypass",
      "-EncodedCommand",
      Buffer.from(TRAY_SCRIPT, "utf16le").toString("base64"),
    ],
    { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
  );

  function handleLine(line: string): void {
    if (line === "ready") {
      resolveReady?.();
      return;
    }
    if (KNOWN_ACTIONS.has(line)) {
      handlers.onAction(line as TrayAction);
    }
  }

  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim().replace(/\r$/, "");
      buffer = buffer.slice(newline + 1);
      handleLine(line);
      newline = buffer.indexOf("\n");
    }
  });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    const message = chunk.trim();
    if (message.length > 0) {
      handlers.onDiagnostic?.(message);
    }
  });

  child.on("error", (error: Error) => {
    handlers.onDiagnostic?.(error.message);
    rejectReady?.(new Error(`无法启动托盘宿主：${error.message}`));
    if (!stopped) {
      stopped = true;
      handlers.onExit?.();
    }
  });

  child.on("exit", () => {
    if (stopped) {
      return;
    }
    stopped = true;
    rejectReady?.(new Error("托盘宿主已退出。"));
    handlers.onExit?.();
  });

  return {
    ready,
    stop: () => {
      if (stopped) {
        return;
      }
      stopped = true;
      child.kill();
    },
  };
}
