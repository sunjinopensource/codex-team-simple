import { spawn as spawnCallback } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { CodexmPlatform } from "../platform.js";
import { getCodexBinarySuffix } from "../platform.js";
import type {
  ExecFileLike,
  ManagedCodexDesktopState,
  RunningCodexDesktop,
} from "./types.js";

export type LaunchProcessLike = (options: {
  appPath: string;
  binaryPath: string;
  args: readonly string[];
  env?: Record<string, string>;
}) => Promise<void>;

type SpawnLike = typeof spawnCallback;

export async function pathExistsViaStat(
  execFileImpl: ExecFileLike,
  path: string,
): Promise<boolean> {
  try {
    await execFileImpl("stat", ["-f", "%N", path]);
    return true;
  } catch {
    return false;
  }
}

export async function readProcessParentAndCommand(
  execFileImpl: ExecFileLike,
  pid: number,
): Promise<{ ppid: number; command: string } | null> {
  try {
    const { stdout } = await execFileImpl("ps", ["-o", "ppid=,command=", "-p", String(pid)]);
    const line = stdout
      .split("\n")
      .map((entry) => entry.trim())
      .find((entry) => entry !== "");
    if (!line) {
      return null;
    }

    const match = line.match(/^(\d+)\s+(.+)$/);
    if (!match) {
      return null;
    }

    return {
      ppid: Number(match[1]),
      command: match[2],
    };
  } catch {
    return null;
  }
}

export async function readProcessEnvironmentVariable(
  execFileImpl: ExecFileLike,
  pid: number,
  name: string,
): Promise<string | null | undefined> {
  try {
    const { stdout } = await execFileImpl("ps", ["eww", "-p", String(pid)]);
    const line = stdout
      .split("\n")
      .map((entry) => entry.trim())
      .find((entry) => entry !== "" && !entry.startsWith("PID "));
    if (!line) {
      return null;
    }

    const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = line.match(new RegExp(`(?:^|\\s)${escapedName}=([^\\s]*)`, "u"));
    if (!match) {
      return null;
    }

    return match[1] === "" ? null : match[1];
  } catch {
    return undefined;
  }
}

const WINDOWS_APPS_DIRECTORY = "windowsapps";
const DEFAULT_MSIX_APPLICATION_ID = "App";

/**
 * Split `...\WindowsApps\OpenAI.Codex_26.908.4834.0_x64__2p2nqsd0c76g0\app\…`
 * into the package family name (`OpenAI.Codex_2p2nqsd0c76g0`) and the package
 * directory, or null when the path is not an MSIX install.
 */
function parseWindowsPackageIdentity(binaryPath: string): {
  familyName: string;
  packageDirectory: string;
} | null {
  const segments = binaryPath.split("\\");
  const index = segments.findIndex(
    (segment) => segment.toLowerCase() === WINDOWS_APPS_DIRECTORY,
  );
  const packageFullName = index >= 0 ? segments[index + 1] : undefined;
  if (!packageFullName) {
    return null;
  }

  // Full package name: Name_Version_Architecture_ResourceId_PublisherId.
  const parts = packageFullName.split("_");
  if (parts.length < 3) {
    return null;
  }

  return {
    familyName: `${parts[0]}_${parts[parts.length - 1]}`,
    packageDirectory: segments.slice(0, index + 2).join("\\"),
  };
}

async function readMsixApplicationId(packageDirectory: string): Promise<string> {
  try {
    const manifest = await readFile(join(packageDirectory, "AppxManifest.xml"), "utf8");
    const applicationId = manifest.match(/<Application\b[^>]*\bId="([^"]+)"/iu)?.[1];
    if (applicationId) {
      return applicationId;
    }
  } catch {
    // Unreadable manifest: fall back to the conventional id below.
  }

  return DEFAULT_MSIX_APPLICATION_ID;
}

/**
 * MSIX packages cannot be started with `CreateProcess`: the executables under
 * `C:\Program Files\WindowsApps` are activation-only (spawn fails with EPERM),
 * and the app only runs once the shell activates it by its application user
 * model id — the same thing the Start menu does. Anything else (a classic
 * install under `%LOCALAPPDATA%\Programs\codex`) stays a plain spawn.
 */
async function resolveWindowsActivationTarget(binaryPath: string): Promise<string | null> {
  const identity = parseWindowsPackageIdentity(binaryPath);
  if (!identity) {
    return null;
  }

  const applicationId = await readMsixApplicationId(identity.packageDirectory);
  return `shell:AppsFolder\\${identity.familyName}!${applicationId}`;
}

export async function launchManagedDesktopProcess(options: {
  appPath: string;
  binaryPath: string;
  args: readonly string[];
  env?: Record<string, string>;
  platform?: CodexmPlatform;
}, spawnImpl: SpawnLike = spawnCallback): Promise<void> {
  const isWindows = (options.platform ?? "darwin") === "win32";
  const activationTarget = isWindows
    ? await resolveWindowsActivationTarget(options.binaryPath)
    : null;

  await new Promise<void>((resolve, reject) => {
    // Launch through LaunchServices so Electron's own update/restart flow can
    // quit and relaunch the app cleanly. Spawning the inner binary directly
    // makes the Desktop behave like an unmanaged executable and can wedge the
    // official "restart to update" path on macOS.
    const envArgs = Object.entries(options.env ?? {}).flatMap(([key, value]) => [
      "--env",
      `${key}=${value}`,
    ]);

    // On Windows there is no LaunchServices, and an MSIX install (the usual
    // one) cannot be spawned directly, so hand the activation to the shell.
    // `start` returns as soon as the activation is requested, and it carries
    // neither command-line flags nor environment overrides — Windows Desktop
    // ignores --remote-debugging-port anyway, and an api base URL has to be
    // applied through the app's own settings.
    const child =
      activationTarget
        ? spawnImpl("cmd", ["/c", "start", "", activationTarget], {
            detached: true,
            stdio: "ignore",
          })
        : isWindows
          ? spawnImpl(options.binaryPath, [...options.args], {
              detached: true,
              stdio: "ignore",
              env: { ...process.env, ...(options.env ?? {}) },
            })
          : spawnImpl("open", [...envArgs, "-na", options.appPath, "--args", ...options.args], {
              detached: true,
              stdio: "ignore",
            });

    let settled = false;

    const settle = (callback: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      callback();
    };

    child.once("error", (error) => {
      settle(() => reject(error));
    });

    child.once("spawn", () => {
      child.unref();
      settle(resolve);
    });
  });
}

export function isManagedDesktopProcess(
  runningApps: RunningCodexDesktop[],
  state: ManagedCodexDesktopState,
  platform: CodexmPlatform = "darwin",
): boolean {
  const expectedBinaryPath = `${state.app_path}${getCodexBinarySuffix(platform)}`;
  const expectedPort = `--remote-debugging-port=${state.remote_debugging_port}`;

  return runningApps.some(
    (entry) =>
      entry.pid === state.pid &&
      entry.command.includes(expectedBinaryPath) &&
      entry.command.includes(expectedPort),
  );
}
