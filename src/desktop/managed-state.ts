import { copyFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";

import { getSnapshotEmail, readAuthSnapshotFile } from "../auth-snapshot.js";
import type { AccountStore } from "../account-store/index.js";
import {
  DEFAULT_CODEX_REMOTE_DEBUGGING_PORT,
  type CodexDesktopLauncher,
  type ManagedCodexDesktopState,
  type RunningCodexDesktop,
} from "../desktop/launcher.js";
import { isCodexDesktopCommand, type CodexmPlatform } from "../platform.js";

interface CliStreams {
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT") {
      return false;
    }

    throw error;
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function confirmDesktopRelaunch(
  streams: CliStreams,
  prompt: string,
): Promise<boolean> {
  if (!streams.stdin.isTTY) {
    throw new Error("Refusing to relaunch Codex Desktop in a non-interactive terminal.");
  }

  streams.stdout.write(prompt);

  return await new Promise<boolean>((resolve) => {
    const cleanup = () => {
      streams.stdin.off("data", onData);
      streams.stdin.pause();
    };

    const onData = (buffer: Buffer) => {
      const answer = buffer.toString("utf8").trim().toLowerCase();
      cleanup();
      streams.stdout.write("\n");
      resolve(answer === "y" || answer === "yes");
    };

    streams.stdin.resume();
    streams.stdin.on("data", onData);
  });
}

export function isRunningDesktopFromApp(
  app: RunningCodexDesktop,
  appPath: string,
  platform: CodexmPlatform = "darwin",
): boolean {
  if (platform === "darwin") {
    return app.command.includes(`${appPath}/Contents/MacOS/Codex`);
  }

  return isCodexDesktopCommand(app.command, platform);
}

export function isOnlyManagedDesktopInstanceRunning(
  runningApps: RunningCodexDesktop[],
  managedState: ManagedCodexDesktopState | null,
  platform: CodexmPlatform = "darwin",
): boolean {
  if (!managedState || runningApps.length === 0) {
    return false;
  }

  return (
    runningApps.length === 1 &&
    runningApps[0].pid === managedState.pid &&
    isRunningDesktopFromApp(runningApps[0], managedState.app_path, platform)
  );
}

/**
 * Whether the Desktop that codexm started is still running.
 *
 * Codex Desktop is an Electron app: one "instance" shows up as several same-named
 * processes (main, renderers, helpers). Counting processes is therefore wrong —
 * what matters is whether the pid codexm recorded is among them. The remote
 * debugging port is deliberately not part of the check because Windows launches
 * do not carry it.
 */
export function isManagedDesktopInstanceRunning(
  runningApps: RunningCodexDesktop[],
  managedState: ManagedCodexDesktopState | null,
  platform: CodexmPlatform = "darwin",
): boolean {
  if (!managedState) {
    return false;
  }

  return runningApps.some(
    (app) =>
      app.pid === managedState.pid &&
      isRunningDesktopFromApp(app, managedState.app_path, platform),
  );
}

export async function resolveManagedDesktopState(
  desktopLauncher: CodexDesktopLauncher,
  appPath: string,
  existingApps: RunningCodexDesktop[],
  platform: CodexmPlatform,
  options: {
    desktopApiBaseUrl?: string | null;
  } = {},
): Promise<ManagedCodexDesktopState | null> {
  const existingPids = new Set(existingApps.map((app) => app.pid));

  for (let attempt = 0; attempt < 10; attempt += 1) {
    const runningApps = await desktopLauncher.listRunningApps();
    const launchedApp =
      runningApps
        .filter(
          (app) =>
            isRunningDesktopFromApp(app, appPath, platform) && !existingPids.has(app.pid),
        )
        .sort((left, right) => right.pid - left.pid)[0] ??
      runningApps
        .filter((app) => isRunningDesktopFromApp(app, appPath, platform))
        .sort((left, right) => right.pid - left.pid)[0] ??
      null;

    if (launchedApp) {
      const state: ManagedCodexDesktopState = {
        pid: launchedApp.pid,
        app_path: appPath,
        remote_debugging_port: DEFAULT_CODEX_REMOTE_DEBUGGING_PORT,
        managed_by_codexm: true,
        started_at: new Date().toISOString(),
      };
      if (Object.prototype.hasOwnProperty.call(options, "desktopApiBaseUrl")) {
        state.desktop_api_base_url = options.desktopApiBaseUrl ?? null;
      }
      return state;
    }

    await sleep(300);
  }

  return null;
}

export const WINDOWS_DESKTOP_NO_DEVTOOLS_WARNING =
  "Codex Desktop on Windows ignores --remote-debugging-port, so codexm could not track the new session; account switches may not apply to it automatically.";
export const DESKTOP_SURFACE_REFRESH_FAILED_WARNING =
  "Codex Desktop launched, but codexm could not refresh the in-app account surface yet.";

export type ManagedDesktopRestartOutcome =
  | "relaunched"
  | "started"
  | "other-running"
  | "not-installed"
  | "unsupported-platform"
  | "inside-desktop";

/**
 * Quits a codexm-managed Desktop and starts it again so the app picks up the
 * current auth snapshot. This is the "restart the app" path for surfaces that
 * cannot ask for confirmation (console, tray): a Desktop codexm did not start
 * is never killed, because that could discard unsaved work.
 */
export const DESKTOP_FORCE_QUIT_WARNING =
  "Codex Desktop did not respond to a graceful quit; it was force-closed.";

export async function restartManagedDesktopSession(options: {
  desktopLauncher: CodexDesktopLauncher;
  platform: CodexmPlatform;
  desktopApiBaseUrl?: string | null;
  /**
   * Allow quitting a Desktop codexm did not start. Callers must confirm first:
   * closing an app the operator launched by hand can discard unsaved work.
   */
  allowNonManaged?: boolean;
}): Promise<{
  outcome: ManagedDesktopRestartOutcome;
  warnings: string[];
  requiresConfirmation: boolean;
}> {
  const { desktopLauncher, platform } = options;
  const warnings: string[] = [];

  if (platform === "wsl" || platform === "linux") {
    return { outcome: "unsupported-platform", warnings, requiresConfirmation: false };
  }

  // Restarting from inside the app would terminate the surface driving it.
  if (await desktopLauncher.isRunningInsideDesktopShell()) {
    return { outcome: "inside-desktop", warnings, requiresConfirmation: false };
  }

  const appPath = await desktopLauncher.findInstalledApp();
  if (!appPath) {
    return { outcome: "not-installed", warnings, requiresConfirmation: false };
  }

  const runningApps = await desktopLauncher.listRunningApps();
  if (runningApps.length > 0) {
    const managedState = await desktopLauncher.readManagedState();
    if (
      !isManagedDesktopInstanceRunning(runningApps, managedState, platform) &&
      options.allowNonManaged !== true
    ) {
      return { outcome: "other-running", warnings, requiresConfirmation: true };
    }

    try {
      await desktopLauncher.quitRunningApps({ force: false });
    } catch {
      // The operator already agreed to close it. A Desktop that ignores the
      // graceful close (unsaved-session prompt, modal dialog) must not leave
      // the restart half-done: closed, but never launched again.
      await desktopLauncher.quitRunningApps({ force: true });
      warnings.push(DESKTOP_FORCE_QUIT_WARNING);
    }
  }

  if (platform === "win32") {
    await desktopLauncher.launch(appPath, { apiBaseUrl: options.desktopApiBaseUrl });
    // Windows Desktop ignores --remote-debugging-port, so there is no DevTools
    // session to hand over. Track the new process by pid so later switches and
    // restarts can tell it apart from a Desktop the operator started by hand.
    const managedState = await resolveManagedDesktopState(
      desktopLauncher,
      appPath,
      runningApps,
      platform,
      { desktopApiBaseUrl: options.desktopApiBaseUrl },
    );
    if (managedState) {
      await desktopLauncher.writeManagedState(managedState);
    } else {
      await desktopLauncher.clearManagedState().catch(() => undefined);
      warnings.push(WINDOWS_DESKTOP_NO_DEVTOOLS_WARNING);
    }
    return {
      outcome: runningApps.length > 0 ? "relaunched" : "started",
      warnings,
      requiresConfirmation: false,
    };
  }

  const { refreshedAccountSurface } = await launchManagedDesktopSession({
    desktopLauncher,
    appPath,
    existingApps: runningApps,
    platform,
    desktopApiBaseUrl: options.desktopApiBaseUrl,
  });
  if (!refreshedAccountSurface) {
    warnings.push(DESKTOP_SURFACE_REFRESH_FAILED_WARNING);
  }

  return {
    outcome: runningApps.length > 0 ? "relaunched" : "started",
    warnings,
    requiresConfirmation: false,
  };
}

export async function launchManagedDesktopSession(options: {
  desktopLauncher: CodexDesktopLauncher;
  appPath: string;
  existingApps: RunningCodexDesktop[];
  platform: CodexmPlatform;
  desktopApiBaseUrl?: string | null;
}): Promise<{
  managedState: ManagedCodexDesktopState;
  refreshedAccountSurface: boolean;
}> {
  await options.desktopLauncher.launch(options.appPath, {
    apiBaseUrl: options.desktopApiBaseUrl,
  });

  const managedState = await resolveManagedDesktopState(
    options.desktopLauncher,
    options.appPath,
    options.existingApps,
    options.platform,
    {
      desktopApiBaseUrl: options.desktopApiBaseUrl,
    },
  );
  if (!managedState) {
    await options.desktopLauncher.clearManagedState().catch(() => undefined);
    throw new Error(
      "Failed to confirm the newly launched Codex Desktop process for managed-session tracking.",
    );
  }

  await options.desktopLauncher.writeManagedState(managedState);
  const refreshedAccountSurface = await options.desktopLauncher
    .refreshManagedAccountSurface()
    .catch(() => false);

  return {
    managedState,
    refreshedAccountSurface,
  };
}

export async function restoreLaunchBackup(
  store: AccountStore,
  backupPath: string | null,
): Promise<void> {
  if (backupPath && await pathExists(backupPath)) {
    await copyFile(backupPath, store.paths.currentAuthPath);
  } else {
    await rm(store.paths.currentAuthPath, { force: true });
  }

  const configBackupPath = join(store.paths.backupsDir, "last-active-config.toml");
  if (await pathExists(configBackupPath)) {
    await copyFile(configBackupPath, store.paths.currentConfigPath);
  } else {
    await rm(store.paths.currentConfigPath, { force: true });
  }
}

export async function shouldSkipManagedDesktopRefresh(
  store: AccountStore,
  desktopLauncher: CodexDesktopLauncher,
  debugLog?: (message: string) => void,
): Promise<boolean> {
  try {
    const runtimeAccount = await desktopLauncher.readManagedCurrentAccount();
    if (!runtimeAccount?.email || !runtimeAccount.auth_mode) {
      debugLog?.("switch: managed Desktop runtime identity unavailable");
      return false;
    }

    const currentSnapshot = await readAuthSnapshotFile(store.paths.currentAuthPath);
    const currentEmail = getSnapshotEmail(currentSnapshot);
    if (!currentEmail) {
      debugLog?.("switch: current auth email unavailable");
      return false;
    }

    const sameAuthMode = runtimeAccount.auth_mode === currentSnapshot.auth_mode;
    const sameEmail = runtimeAccount.email.trim().toLowerCase() === currentEmail.trim().toLowerCase();
    if (!sameAuthMode || !sameEmail) {
      debugLog?.("switch: managed Desktop runtime differs from target auth");
      return false;
    }

    const { accounts } = await store.listAccounts();
    let managedMatches = 0;
    for (const account of accounts) {
      if (account.auth_mode !== currentSnapshot.auth_mode) {
        continue;
      }

      try {
        const accountSnapshot = await readAuthSnapshotFile(account.authPath);
        const accountEmail = getSnapshotEmail(accountSnapshot);
        if (
          accountEmail &&
          accountEmail.trim().toLowerCase() === currentEmail.trim().toLowerCase()
        ) {
          managedMatches += 1;
        }
      } catch {
        // Ignore unreadable managed snapshots and fall back to refreshing Desktop.
      }
    }

    if (managedMatches !== 1) {
      debugLog?.(
        `switch: managed Desktop runtime identity is ambiguous across ${managedMatches} saved snapshot(s)`,
      );
      return false;
    }

    debugLog?.("switch: skipping managed Desktop refresh because runtime already matches target auth");
    return true;
  } catch (error) {
    debugLog?.(`switch: managed Desktop refresh skip check failed: ${(error as Error).message}`);
    return false;
  }
}
