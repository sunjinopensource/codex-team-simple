/**
 * platform-desktop-adapter.ts
 *
 * Platform-aware adapter for CodexDesktopLauncher that adds Linux and WSL
 * support to the macOS-centric codex-desktop-launch.ts module.
 *
 * On macOS: delegates to the original createCodexDesktopLauncher unchanged.
 * On Linux/WSL: provides alternative implementations for process discovery,
 *   app finding, and process management that work without macOS-specific
 *   tools (mdfind, osascript, BSD stat, .app bundles).
 * On Windows: discovers the MSIX package (or a classic install), and drives
 *   processes through PowerShell. Codex Desktop on Windows ignores
 *   --remote-debugging-port, so managed (DevTools) sessions are unsupported
 *   there and callers fall back to relaunching the app with the new auth.
 */

import { access, readdir } from "node:fs/promises";
import { execFile as execFileCallback } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import type { CodexmPlatform } from "./platform.js";
import { getPlatform, isCodexDesktopCommand } from "./platform.js";
import type {
  ExecFileLike,
  RunningCodexDesktop,
  CodexDesktopLauncher,
} from "./desktop/launcher.js";
import { createCodexDesktopLauncher } from "./desktop/launcher.js";

const execFile = promisify(execFileCallback);

// ── Linux/WSL path candidates ──

const LINUX_CODEX_PATHS = [
  "/usr/local/bin/codex",
  "/usr/bin/codex",
  join(homedir(), ".local", "bin", "codex"),
];

const WSL_WINDOWS_CODEX_PATHS_PATTERNS = [
  "/mnt/c/Users/*/AppData/Local/Programs/codex/Codex.exe",
  "/mnt/c/Program Files/Codex/Codex.exe",
  "/mnt/c/Program Files (x86)/Codex/Codex.exe",
];

// ── Helpers ──

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function whichCodex(execFileImpl: ExecFileLike): Promise<string | null> {
  try {
    const { stdout } = await execFileImpl("which", ["codex"]);
    const result = stdout.trim();
    return result !== "" ? result : null;
  } catch {
    return null;
  }
}

async function findWslWindowsCodex(execFileImpl: ExecFileLike): Promise<string | null> {
  // Try to find Codex Desktop on the Windows side via WSL interop
  for (const pattern of WSL_WINDOWS_CODEX_PATHS_PATTERNS) {
    try {
      const { stdout } = await execFileImpl("bash", ["-c", `ls ${pattern} 2>/dev/null | head -1`]);
      const result = stdout.trim();
      if (result !== "") {
        return result;
      }
    } catch {
      // continue
    }
  }

  // Try wslpath + powershell as fallback
  try {
    const { stdout } = await execFileImpl("powershell.exe", [
      "-Command",
      "Get-Command Codex -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Source",
    ]);
    const winPath = stdout.trim();
    if (winPath !== "") {
      // Convert Windows path to WSL path
      const { stdout: wslPath } = await execFileImpl("wslpath", ["-u", winPath]);
      return wslPath.trim() || null;
    }
  } catch {
    // powershell.exe not available — that's fine
  }

  return null;
}

// ── Linux/WSL process listing ──

async function listRunningAppsLinux(
  execFileImpl: ExecFileLike,
): Promise<RunningCodexDesktop[]> {
  const running: RunningCodexDesktop[] = [];

  try {
    const { stdout } = await execFileImpl("ps", ["-Ao", "pid=,command="]);

    for (const line of stdout.split("\n")) {
      const match = line.trim().match(/^(\d+)\s+(.+)$/);
      if (!match) {
        continue;
      }

      const pid = Number(match[1]);
      const command = match[2];

      if (pid === process.pid) {
        continue;
      }

      // Match Codex Desktop processes on Linux
      // Look for electron-based codex or codex with --remote-debugging-port
      if (
        command.includes("--remote-debugging-port") &&
        (command.includes("codex") || command.includes("Codex"))
      ) {
        running.push({ pid, command });
      }
    }
  } catch {
    // ps failed
  }

  return running;
}

async function listRunningAppsWsl(
  execFileImpl: ExecFileLike,
): Promise<RunningCodexDesktop[]> {
  // First check Linux-side processes
  const linuxApps = await listRunningAppsLinux(execFileImpl);

  // Also check Windows-side processes via powershell
  try {
    const { stdout } = await execFileImpl("powershell.exe", [
      "-Command",
      'Get-Process -Name "Codex" -ErrorAction SilentlyContinue | Select-Object Id, Path | ConvertTo-Json',
    ]);

    if (stdout.trim()) {
      let processes: unknown;
      try {
        processes = JSON.parse(stdout.trim());
      } catch {
        processes = null;
      }

      const items = Array.isArray(processes) ? processes : processes ? [processes] : [];

      for (const proc of items) {
        if (
          proc &&
          typeof proc === "object" &&
          typeof (proc as Record<string, unknown>).Id === "number" &&
          typeof (proc as Record<string, unknown>).Path === "string"
        ) {
          const p = proc as { Id: number; Path: string };
          linuxApps.push({
            pid: p.Id,
            command: p.Path,
          });
        }
      }
    }
  } catch {
    // powershell not available
  }

  return linuxApps;
}

// ── Platform-aware find installed app ──

async function findInstalledAppLinux(
  execFileImpl: ExecFileLike,
): Promise<string | null> {
  // Check known paths
  for (const candidate of LINUX_CODEX_PATHS) {
    if (await pathExists(candidate)) {
      return candidate;
    }
  }

  // Try `which`
  return await whichCodex(execFileImpl);
}

async function findInstalledAppWsl(
  execFileImpl: ExecFileLike,
): Promise<string | null> {
  // First check if codex is installed in WSL itself
  const linuxApp = await findInstalledAppLinux(execFileImpl);
  if (linuxApp) {
    return linuxApp;
  }

  // Then check Windows side
  return await findWslWindowsCodex(execFileImpl);
}

// ── Windows discovery / process control ──
//
// Codex Desktop ships on Windows as an MSIX package:
//   C:\Program Files\WindowsApps\OpenAI.Codex_<version>_x64__<publisher>\app\ChatGPT.exe
// The package directory is versioned, so it has to be discovered by scanning
// `WindowsApps` (fast, no subprocess) before falling back to PowerShell.

const WINDOWS_MSIX_ROOT = "C:\\Program Files\\WindowsApps";
const WINDOWS_MSIX_PACKAGE_PREFIX = "OpenAI.Codex_";
const WINDOWS_MSIX_APP_CANDIDATES = [
  ["app", "ChatGPT.exe"],
  ["app", "Codex.exe"],
] as const;

function windowsClassicInstallCandidates(): string[] {
  const localAppData = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
  const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
  const programFilesX86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";

  return [
    join(localAppData, "Programs", "codex", "Codex.exe"),
    join(localAppData, "Programs", "Codex", "Codex.exe"),
    join(programFiles, "Codex", "Codex.exe"),
    join(programFilesX86, "Codex", "Codex.exe"),
  ];
}

function windowsAppCandidatesForPackage(packageDir: string): string[] {
  return WINDOWS_MSIX_APP_CANDIDATES.map((segments) => join(packageDir, ...segments));
}

async function findMsixCodexApp(): Promise<string | null> {
  let entries: string[];
  try {
    entries = await readdir(WINDOWS_MSIX_ROOT);
  } catch {
    return null;
  }

  const packageDirs = entries
    .filter((entry) => entry.startsWith(WINDOWS_MSIX_PACKAGE_PREFIX))
    .sort((left, right) => right.localeCompare(left))
    .map((entry) => join(WINDOWS_MSIX_ROOT, entry));

  for (const packageDir of packageDirs) {
    for (const candidate of windowsAppCandidatesForPackage(packageDir)) {
      if (await pathExists(candidate)) {
        return candidate;
      }
    }
  }

  return null;
}

async function findInstalledAppW32(
  execFileImpl: ExecFileLike,
): Promise<string | null> {
  const msixApp = await findMsixCodexApp();
  if (msixApp) {
    return msixApp;
  }

  for (const candidate of windowsClassicInstallCandidates()) {
    if (await pathExists(candidate)) {
      return candidate;
    }
  }

  // Last resort: ask PowerShell for the MSIX install location.
  try {
    const { stdout } = await execFileImpl("powershell.exe", [
      "-NoProfile",
      "-Command",
      "(Get-AppxPackage -Name 'OpenAI.Codex' -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty InstallLocation)",
    ]);
    const installLocation = stdout.trim().split(/\r?\n/)[0]?.trim() ?? "";
    if (installLocation !== "") {
      for (const candidate of windowsAppCandidatesForPackage(installLocation)) {
        if (await pathExists(candidate)) {
          return candidate;
        }
      }
    }
  } catch {
    // PowerShell unavailable or no MSIX package installed.
  }

  return null;
}

async function listRunningAppsW32(
  execFileImpl: ExecFileLike,
): Promise<RunningCodexDesktop[]> {
  try {
    const { stdout } = await execFileImpl("powershell.exe", [
      "-NoProfile",
      "-Command",
      "Get-Process -Name ChatGPT,Codex -ErrorAction SilentlyContinue | Where-Object { $_.Path } | Select-Object Id,Path | ConvertTo-Json",
    ]);

    return parseWindowsProcessList(stdout);
  } catch {
    return [];
  }
}

function parseWindowsProcessList(stdout: string): RunningCodexDesktop[] {
  const trimmed = stdout.trim();
  if (trimmed === "") {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return [];
  }

  const items = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];
  const running: RunningCodexDesktop[] = [];

  for (const item of items) {
    if (!item || typeof item !== "object") {
      continue;
    }

    const record = item as Record<string, unknown>;
    const pid = record.Id;
    const command = record.Path;
    if (typeof pid !== "number" || typeof command !== "string") {
      continue;
    }

    // `Get-Process -Name ChatGPT` also matches an unrelated ChatGPT desktop
    // app, so keep only processes whose executable looks like Codex Desktop.
    if (!isCodexDesktopCommand(command, "win32")) {
      continue;
    }

    running.push({ pid, command });
  }

  return running;
}

async function quitRunningAppsW32(
  execFileImpl: ExecFileLike,
  options?: { force?: boolean },
): Promise<void> {
  let running = await listRunningAppsW32(execFileImpl);
  if (running.length === 0) {
    return;
  }

  // `taskkill /T` also tears down the Electron child processes.
  for (const app of running) {
    const args = options?.force === true
      ? ["/PID", String(app.pid), "/T", "/F"]
      : ["/PID", String(app.pid), "/T"];
    try {
      await execFileImpl("taskkill", args);
    } catch {
      // Process already gone or not owned by this session.
    }
  }

  for (let attempt = 0; attempt < 20; attempt += 1) {
    running = await listRunningAppsW32(execFileImpl);
    if (running.length === 0) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  if (options?.force !== true) {
    throw new Error("Timed out waiting for Codex Desktop to quit.");
  }

  const remaining = await listRunningAppsW32(execFileImpl);
  if (remaining.length > 0) {
    throw new Error("Timed out waiting for Codex Desktop to terminate.");
  }
}

async function activateDesktopAppW32(
  execFileImpl: ExecFileLike,
  appPath: string,
): Promise<void> {
  if (appPath.trim() === "") {
    throw new Error("App path is required to activate Codex Desktop.");
  }

  const running = await listRunningAppsW32(execFileImpl);
  if (running.length === 0) {
    return;
  }

  const pids = running.map((app) => String(app.pid)).join(",");
  await execFileImpl("powershell.exe", [
    "-NoProfile",
    "-Command",
    `foreach ($processId in @(${pids})) { (New-Object -ComObject WScript.Shell).AppActivate($processId) | Out-Null }`,
  ]);
}

async function isRunningInsideDesktopShellW32(
  execFileImpl: ExecFileLike,
): Promise<boolean> {
  let currentPid = process.ppid;
  const visited = new Set<number>();

  while (currentPid > 4 && !visited.has(currentPid)) {
    visited.add(currentPid);

    try {
      const { stdout } = await execFileImpl("powershell.exe", [
        "-NoProfile",
        "-Command",
        `$process = Get-CimInstance Win32_Process -Filter "ProcessId = ${currentPid}" -ErrorAction SilentlyContinue; if ($process) { Write-Output ($process.ParentProcessId.ToString() + '|' + $process.ExecutablePath) }`,
      ]);
      const line = stdout.trim().split(/\r?\n/)[0]?.trim() ?? "";
      if (line === "") {
        return false;
      }

      const separatorIndex = line.indexOf("|");
      if (separatorIndex <= 0) {
        return false;
      }

      const parentPid = Number(line.slice(0, separatorIndex));
      const executablePath = line.slice(separatorIndex + 1);
      if (executablePath !== "" && isCodexDesktopCommand(executablePath, "win32")) {
        return true;
      }

      if (!Number.isFinite(parentPid) || parentPid <= 0) {
        return false;
      }

      currentPid = parentPid;
    } catch {
      return false;
    }
  }

  return false;
}

// ── Platform-aware quit ──

async function quitRunningAppsLinux(
  execFileImpl: ExecFileLike,
  options?: { force?: boolean },
): Promise<void> {
  const running = await listRunningAppsLinux(execFileImpl);
  if (running.length === 0) {
    return;
  }

  const pids = running.map((app) => String(app.pid));

  // Always use signal-based termination on Linux (no osascript)
  await execFileImpl("kill", ["-TERM", ...pids]);

  for (let attempt = 0; attempt < 10; attempt += 1) {
    const remaining = await listRunningAppsLinux(execFileImpl);
    if (remaining.length === 0) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  if (options?.force === true) {
    const remaining = await listRunningAppsLinux(execFileImpl);
    if (remaining.length > 0) {
      await execFileImpl("kill", ["-KILL", ...remaining.map((app) => String(app.pid))]);
    }
  }
}

// ── Main factory ──

export interface PlatformDesktopAdapterOptions {
  execFileImpl?: ExecFileLike;
  statePath?: string;
  readFileImpl?: (path: string) => Promise<string>;
  writeFileImpl?: (path: string, content: string) => Promise<void>;
  fetchImpl?: (input: string | URL, init?: RequestInit) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
  createWebSocketImpl?: (url: string) => unknown;
  launchProcessImpl?: (options: { appPath: string; binaryPath: string; args: readonly string[] }) => Promise<void>;
  createDirectClientImpl?: () => Promise<unknown>;
  watchReconnectDelayMs?: number;
  watchHealthCheckIntervalMs?: number;
  watchHealthCheckTimeoutMs?: number;
  /** Override platform detection for testing. */
  platform?: CodexmPlatform;
}

/**
 * Create a platform-aware CodexDesktopLauncher.
 *
 * On macOS, delegates entirely to the original implementation.
 * On Linux/WSL, wraps it with platform-appropriate overrides for
 * findInstalledApp, listRunningApps, quitRunningApps, and pathExists.
 */
export async function createPlatformDesktopLauncher(
  options: PlatformDesktopAdapterOptions = {},
): Promise<CodexDesktopLauncher> {
  const platform = options.platform ?? (await getPlatform());

  if (platform === "darwin") {
    // macOS: use original implementation unchanged
    return createCodexDesktopLauncher({
      ...(options as Parameters<typeof createCodexDesktopLauncher>[0]),
      platform,
    });
  }

  // Linux / WSL: create the base launcher, then override platform-specific methods
  const execFileImpl = options.execFileImpl ?? (promisify(execFileCallback) as unknown as ExecFileLike);

  // For Linux/WSL, we override pathExistsViaStat to use Node's fs.access
  // instead of BSD stat. We do this by creating a custom execFileImpl that
  // intercepts "stat" calls.
  const patchedExecFile: ExecFileLike = async (file, args) => {
    if (file === "stat" && args && args.length >= 2 && args[0] === "-f") {
      // BSD stat compatibility: replace with Node fs.access
      const targetPath = args[args.length - 1] as string;
      await access(targetPath);
      return { stdout: targetPath + "\n", stderr: "" };
    }

    if (file === "mdfind") {
      // mdfind is macOS Spotlight — not available on Linux
      throw new Error("mdfind is not available on Linux/WSL");
    }

    if (file === "osascript") {
      // osascript is AppleScript — not available on Linux
      throw new Error("osascript is not available on Linux/WSL");
    }

    return execFileImpl(file, args);
  };

  // Create the base launcher with our patched execFile
  const baseLauncher = createCodexDesktopLauncher({
    ...options,
    execFileImpl: patchedExecFile,
    platform,
  } as Parameters<typeof createCodexDesktopLauncher>[0]);

  // Override platform-specific methods
  const listRunningApps =
    platform === "win32"
      ? () => listRunningAppsW32(execFileImpl)
      : platform === "wsl"
        ? () => listRunningAppsWsl(execFileImpl)
        : () => listRunningAppsLinux(execFileImpl);

  const findInstalledApp =
    platform === "win32"
      ? () => findInstalledAppW32(execFileImpl)
      : platform === "wsl"
        ? () => findInstalledAppWsl(execFileImpl)
        : () => findInstalledAppLinux(execFileImpl);

  const quitRunningApps = (quitOptions?: { force?: boolean }) =>
    platform === "win32"
      ? quitRunningAppsW32(execFileImpl, quitOptions)
      : quitRunningAppsLinux(execFileImpl, quitOptions);

  const activateApp = (appPath: string) =>
    platform === "win32"
      ? activateDesktopAppW32(execFileImpl, appPath)
      : baseLauncher.activateApp(appPath);

  const isRunningInsideDesktopShell = async (): Promise<boolean> => {
    if (platform === "win32") {
      return await isRunningInsideDesktopShellW32(execFileImpl);
    }

    // On Linux/WSL, check parent process chain for codex with --remote-debugging-port
    let currentPid = process.ppid;
    const visited = new Set<number>();

    while (currentPid > 1 && !visited.has(currentPid)) {
      visited.add(currentPid);
      try {
        const { stdout } = await execFileImpl("ps", ["-o", "ppid=,command=", "-p", String(currentPid)]);
        const line = stdout
          .split("\n")
          .map((entry) => entry.trim())
          .find((entry) => entry !== "");
        if (!line) {
          return false;
        }

        const match = line.match(/^(\d+)\s+(.+)$/);
        if (!match) {
          return false;
        }

        const command = match[2];
        if (
          command.includes("codex") &&
          command.includes("--remote-debugging-port")
        ) {
          return true;
        }

        currentPid = Number(match[1]);
      } catch {
        return false;
      }
    }

    return false;
  };

  // Return an enhanced launcher that overrides platform-specific methods
  return {
    ...baseLauncher,
    findInstalledApp,
    listRunningApps,
    isRunningInsideDesktopShell,
    quitRunningApps,
    activateApp,
  };
}
