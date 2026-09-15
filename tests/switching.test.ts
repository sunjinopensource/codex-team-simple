import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, test } from "@rstest/core";

import { createAccountStore } from "../src/account-store/index.js";
import type { ManagedCodexDesktopState } from "../src/desktop/launcher.js";
import {
  NON_MANAGED_DESKTOP_WARNING_PREFIX,
  refreshManagedDesktopAfterSwitch,
  tryAcquireSwitchLock,
} from "../src/switching.js";
import { createDesktopLauncherStub } from "./cli-fixtures.js";
import { cleanupTempHome, createTempHome } from "./test-helpers.js";

describe("switching lock", () => {
  test("does not steal an existing switch lock when owner metadata is missing", async () => {
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir);
      const lockPath = join(store.paths.codexTeamDir, "locks", "switch.lock");
      await mkdir(lockPath, { recursive: true });

      const result = await tryAcquireSwitchLock(store, "switch target");

      expect(result).toEqual({
        acquired: false,
        lockPath,
        owner: null,
      });
      await expect(stat(lockPath)).resolves.toBeDefined();
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("does not steal an existing switch lock when owner metadata is malformed", async () => {
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir);
      const lockPath = join(store.paths.codexTeamDir, "locks", "switch.lock");
      await mkdir(lockPath, { recursive: true });
      await writeFile(join(lockPath, "owner.json"), "{not-json}\n");

      const result = await tryAcquireSwitchLock(store, "switch target");

      expect(result).toEqual({
        acquired: false,
        lockPath,
        owner: null,
      });
      await expect(stat(lockPath)).resolves.toBeDefined();
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("reports managed Desktop wait progress through the status callback", async () => {
    const messages: string[] = [];

    const outcome = await refreshManagedDesktopAfterSwitch(
      [],
      createDesktopLauncherStub({
        isManagedDesktopRunning: async () => true,
        applyManagedSwitch: async () => {
          await new Promise((resolve) => setTimeout(resolve, 20));
          return true;
        },
      }),
      {
        statusDelayMs: 1,
        statusIntervalMs: 5,
        onStatusMessage: (message) => {
          messages.push(message);
        },
        platform: "darwin",
      },
    );

    expect(outcome).toBe("applied");
    expect(messages).toContain(
      "Waiting for the current Codex Desktop thread to finish before applying the switch...",
    );
    expect(messages.some((message) => message.startsWith(
      "Still waiting for the current Codex Desktop thread to finish (",
    ))).toBe(true);
    expect(messages).toContain("Applied the switch to the managed Codex Desktop session.");
  });

  test("warns instead of hot-refreshing when the managed Desktop base URL differs from the desired proxy route", async () => {
    const warnings: string[] = [];
    let applyManagedSwitchCalls = 0;

    const outcome = await refreshManagedDesktopAfterSwitch(
      warnings,
      createDesktopLauncherStub({
        readManagedState: async () => ({
          pid: 123,
          app_path: "/Applications/Codex.app",
          remote_debugging_port: 39223,
          managed_by_codexm: true,
          started_at: "2026-04-22T00:00:00.000Z",
          desktop_api_base_url: null,
        }),
        applyManagedSwitch: async () => {
          applyManagedSwitchCalls += 1;
          return true;
        },
      }),
      {
        desiredDesktopApiBaseUrl: "http://127.0.0.1:14555/backend-api",
        platform: "darwin",
      },
    );

    expect(outcome).toBe("failed");
    expect(applyManagedSwitchCalls).toBe(0);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("Relaunch Codex Desktop via \"codexm launch\"");
    expect(warnings[0]).toContain("http://127.0.0.1:14555/backend-api");
  });

  test("uses the running Desktop launch env before falling back to saved managed state", async () => {
    const warnings: string[] = [];
    let applyManagedSwitchCalls = 0;

    const outcome = await refreshManagedDesktopAfterSwitch(
      warnings,
      createDesktopLauncherStub({
        readManagedState: async () => ({
          pid: 123,
          app_path: "/Applications/Codex.app",
          remote_debugging_port: 39223,
          managed_by_codexm: true,
          started_at: "2026-04-22T00:00:00.000Z",
          desktop_api_base_url: "http://127.0.0.1:14555/backend-api",
        }),
        readManagedLaunchApiBaseUrl: async () => null,
        applyManagedSwitch: async () => {
          applyManagedSwitchCalls += 1;
          return true;
        },
      }),
      {
        desiredDesktopApiBaseUrl: null,
        platform: "darwin",
      },
    );

    expect(outcome).toBe("applied");
    expect(applyManagedSwitchCalls).toBe(1);
    expect(warnings).toHaveLength(0);
  });
});

describe("switching on Windows", () => {
  const windowsAppPath = "C:\\Program Files\\WindowsApps\\OpenAI.Codex_1.2.3_x64__pub\\app";
  const windowsManagedState: ManagedCodexDesktopState = {
    pid: 4242,
    app_path: windowsAppPath,
    remote_debugging_port: 9223,
    managed_by_codexm: true,
    started_at: "2026-01-01T00:00:00.000Z",
  };

  function createWindowsLauncherStub(calls: {
    quit: number;
    launch: number;
    writeState: number;
    apply: number;
  }) {
    return createDesktopLauncherStub({
      supportsManagedSwitchHotApply: false,
      listRunningApps: async () => [
        { pid: 4242, command: `${windowsAppPath}\\ChatGPT.exe` },
      ],
      readManagedState: async () => windowsManagedState,
      isRunningInsideDesktopShell: async () => false,
      quitRunningApps: async () => {
        calls.quit += 1;
      },
      launch: async () => {
        calls.launch += 1;
      },
      writeManagedState: async () => {
        calls.writeState += 1;
      },
      applyManagedSwitch: async () => {
        calls.apply += 1;
        return false;
      },
    });
  }

  test("restarts a codexm-managed Windows Desktop because DevTools hot-refresh is unavailable there", async () => {
    const calls = { quit: 0, launch: 0, writeState: 0, apply: 0 };

    const outcome = await refreshManagedDesktopAfterSwitch(
      [],
      createWindowsLauncherStub(calls),
      { platform: "win32" },
    );

    expect(outcome).toBe("restarted");
    expect(calls.quit).toBe(1);
    expect(calls.launch).toBe(1);
    expect(calls.writeState).toBe(1);
    expect(calls.apply).toBe(0);
  });

  test("warns instead of restarting a Windows Desktop codexm did not start", async () => {
    const warnings: string[] = [];
    const calls = { quit: 0, launch: 0, writeState: 0, apply: 0 };
    const launcher = createDesktopLauncherStub({
      supportsManagedSwitchHotApply: false,
      listRunningApps: async () => [
        { pid: 4242, command: `${windowsAppPath}\\ChatGPT.exe` },
      ],
      readManagedState: async () => null,
      isRunningInsideDesktopShell: async () => false,
      quitRunningApps: async () => {
        calls.quit += 1;
      },
      launch: async () => {
        calls.launch += 1;
      },
    });

    const outcome = await refreshManagedDesktopAfterSwitch(warnings, launcher, {
      platform: "win32",
    });

    expect(outcome).toBe("other-running");
    expect(calls.quit).toBe(0);
    expect(calls.launch).toBe(0);
    expect(warnings).toContain(NON_MANAGED_DESKTOP_WARNING_PREFIX);
  });

  test("reports none when no Windows Desktop is running", async () => {
    const calls = { quit: 0, launch: 0, writeState: 0, apply: 0 };
    const launcher = createDesktopLauncherStub({
      supportsManagedSwitchHotApply: false,
      listRunningApps: async () => [],
      readManagedState: async () => windowsManagedState,
      applyManagedSwitch: async () => {
        calls.apply += 1;
        return false;
      },
    });

    const outcome = await refreshManagedDesktopAfterSwitch([], launcher, {
      platform: "win32",
    });

    expect(outcome).toBe("none");
    expect(calls.apply).toBe(0);
  });
});
