import { describe, expect, test } from "@rstest/core";

import type { CodexDesktopLauncher } from "../src/desktop/launcher.js";
import {
  DESKTOP_FORCE_QUIT_WARNING,
  DESKTOP_SURFACE_REFRESH_FAILED_WARNING,
  restartManagedDesktopSession,
} from "../src/desktop/managed-state.js";

const APP_PATH = "/Applications/Codex.app";

interface FakeLauncherState {
  quitCalls: Array<{ force?: boolean }>;
  launchCalls: number;
  runningApps: Array<{ pid: number; command: string }>;
  managedState: { pid: number; app_path: string } | null;
  installed: boolean;
  insideDesktopShell: boolean;
  refreshSurface: boolean;
  /** "graceful" refuses the polite close (like an ignored WM_CLOSE); "always" refuses both. */
  quitFailMode: "none" | "graceful" | "always";
}

function createFakeLauncher(state: FakeLauncherState): CodexDesktopLauncher {
  return {
    isRunningInsideDesktopShell: async () => state.insideDesktopShell,
    findInstalledApp: async () => (state.installed ? APP_PATH : null),
    listRunningApps: async () => state.runningApps,
    readManagedState: async () => state.managedState,
    quitRunningApps: async (options?: { force?: boolean }) => {
      state.quitCalls.push(options ?? {});
      const refuses =
        state.quitFailMode === "always" ||
        (state.quitFailMode === "graceful" && options?.force !== true);
      if (refuses) {
        throw new Error("Timed out waiting for Codex Desktop to quit.");
      }

      state.runningApps = [];
    },
    launch: async () => {
      state.launchCalls += 1;
      state.runningApps = [{ pid: 4242, command: `${APP_PATH}/Contents/MacOS/Codex` }];
    },
    writeManagedState: async () => undefined,
    clearManagedState: async () => undefined,
    refreshManagedAccountSurface: async () => state.refreshSurface,
  } as unknown as CodexDesktopLauncher;
}

function baseState(): FakeLauncherState {
  return {
    quitCalls: [],
    launchCalls: 0,
    runningApps: [],
    managedState: null,
    installed: true,
    insideDesktopShell: false,
    refreshSurface: true,
    quitFailMode: "none",
  };
}

describe("managed Desktop restart", () => {
  test("quits the managed instance before starting it again", async () => {
    const state = baseState();
    state.runningApps = [{ pid: 100, command: `${APP_PATH}/Contents/MacOS/Codex` }];
    state.managedState = { pid: 100, app_path: APP_PATH };

    const result = await restartManagedDesktopSession({
      desktopLauncher: createFakeLauncher(state),
      platform: "darwin",
    });

    expect(result.outcome).toBe("relaunched");
    expect(state.quitCalls).toEqual([{ force: false }]);
    expect(state.launchCalls).toBe(1);
    expect(result.warnings).toEqual([]);
  });

  test("leaves a Desktop that codexm did not start alone", async () => {
    const state = baseState();
    state.runningApps = [{ pid: 900, command: `${APP_PATH}/Contents/MacOS/Codex` }];
    state.managedState = { pid: 100, app_path: APP_PATH };

    const result = await restartManagedDesktopSession({
      desktopLauncher: createFakeLauncher(state),
      platform: "darwin",
    });

    expect(result.outcome).toBe("other-running");
    expect(result.requiresConfirmation).toBe(true);
    expect(state.quitCalls).toEqual([]);
    expect(state.launchCalls).toBe(0);
  });

  test("accepts a confirmed restart of a Desktop codexm did not start", async () => {
    const state = baseState();
    state.runningApps = [{ pid: 900, command: `${APP_PATH}/Contents/MacOS/Codex` }];

    const result = await restartManagedDesktopSession({
      desktopLauncher: createFakeLauncher(state),
      platform: "darwin",
      allowNonManaged: true,
    });

    expect(result.outcome).toBe("relaunched");
    expect(state.quitCalls).toEqual([{ force: false }]);
    expect(state.launchCalls).toBe(1);
  });

  test("restarts a managed Desktop that runs as several Electron processes", async () => {
    const state = baseState();
    state.runningApps = [
      { pid: 100, command: `${APP_PATH}/Contents/MacOS/Codex` },
      { pid: 101, command: `${APP_PATH}/Contents/MacOS/Codex` },
      { pid: 102, command: `${APP_PATH}/Contents/MacOS/Codex` },
    ];
    state.managedState = { pid: 100, app_path: APP_PATH };

    const result = await restartManagedDesktopSession({
      desktopLauncher: createFakeLauncher(state),
      platform: "darwin",
    });

    expect(result.outcome).toBe("relaunched");
    expect(result.requiresConfirmation).toBe(false);
    expect(state.quitCalls).toEqual([{ force: false }]);
    expect(state.launchCalls).toBe(1);
  });

  test("starts Desktop when nothing is running and reports a stale account surface", async () => {
    const state = baseState();
    state.refreshSurface = false;

    const result = await restartManagedDesktopSession({
      desktopLauncher: createFakeLauncher(state),
      platform: "darwin",
    });

    expect(result.outcome).toBe("started");
    expect(state.quitCalls).toEqual([]);
    expect(state.launchCalls).toBe(1);
    expect(result.warnings).toContain(DESKTOP_SURFACE_REFRESH_FAILED_WARNING);
  });

  test("reports a missing install instead of launching", async () => {
    const state = baseState();
    state.installed = false;

    const result = await restartManagedDesktopSession({
      desktopLauncher: createFakeLauncher(state),
      platform: "darwin",
    });

    expect(result.outcome).toBe("not-installed");
    expect(state.launchCalls).toBe(0);
  });

  test("refuses to restart while the controller runs inside Desktop", async () => {
    const state = baseState();
    state.insideDesktopShell = true;

    const result = await restartManagedDesktopSession({
      desktopLauncher: createFakeLauncher(state),
      platform: "darwin",
    });

    expect(result.outcome).toBe("inside-desktop");
    expect(state.launchCalls).toBe(0);
  });

  test("force-closes a Desktop that ignores the graceful quit", async () => {
    const state = baseState();
    state.runningApps = [{ pid: 100, command: `${APP_PATH}/Contents/MacOS/Codex` }];
    state.managedState = { pid: 100, app_path: APP_PATH };
    state.quitFailMode = "graceful";

    const result = await restartManagedDesktopSession({
      desktopLauncher: createFakeLauncher(state),
      platform: "darwin",
    });

    expect(result.outcome).toBe("relaunched");
    expect(state.quitCalls).toEqual([{ force: false }, { force: true }]);
    expect(state.launchCalls).toBe(1);
    expect(result.warnings).toEqual([DESKTOP_FORCE_QUIT_WARNING]);
  });

  test("reports failure when the Desktop cannot be closed at all", async () => {
    const state = baseState();
    state.runningApps = [{ pid: 100, command: `${APP_PATH}/Contents/MacOS/Codex` }];
    state.managedState = { pid: 100, app_path: APP_PATH };
    state.quitFailMode = "always";

    await expect(
      restartManagedDesktopSession({
        desktopLauncher: createFakeLauncher(state),
        platform: "darwin",
      }),
    ).rejects.toThrow("Timed out waiting for Codex Desktop to quit.");

    expect(state.quitCalls).toEqual([{ force: false }, { force: true }]);
    expect(state.launchCalls).toBe(0);
  });
});
