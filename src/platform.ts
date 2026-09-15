import { readFile } from "node:fs/promises";

export type CodexmPlatform = "darwin" | "linux" | "wsl" | "win32";

let cachedPlatform: CodexmPlatform | null = null;

/**
 * Detect the current platform, distinguishing between macOS, native Linux,
 * and Windows Subsystem for Linux (WSL).
 *
 * WSL is detected by reading /proc/version and looking for "microsoft" or
 * "WSL" in the kernel version string — a technique endorsed by Microsoft's
 * own documentation.
 */
export async function getPlatform(): Promise<CodexmPlatform> {
  if (cachedPlatform !== null) {
    return cachedPlatform;
  }

  const detected = await detectPlatform();
  cachedPlatform = detected;
  return detected;
}

async function detectPlatform(): Promise<CodexmPlatform> {
  if (process.platform === "darwin") {
    return "darwin";
  }

  if (process.platform === "win32") {
    return "win32";
  }

  if (process.platform !== "linux") {
    // Treat all other platforms (e.g. freebsd) as linux for now.
    return "linux";
  }

  // On Linux, distinguish native Linux from WSL.
  try {
    const procVersion = await readFile("/proc/version", "utf-8");
    if (/microsoft|wsl/i.test(procVersion)) {
      return "wsl";
    }
  } catch {
    // /proc/version unreadable — assume native Linux.
  }

  return "linux";
}

/**
 * Reset the cached platform. Useful for testing.
 */
export function resetPlatformCache(): void {
  cachedPlatform = null;
}

/**
 * Override the platform for testing. Returns a cleanup function.
 */
export function setPlatformForTesting(platform: CodexmPlatform): () => void {
  const previous = cachedPlatform;
  cachedPlatform = platform;
  return () => {
    cachedPlatform = previous;
  };
}

// ── Codex binary resolution ──

const CODEX_BINARY_NAME_DARWIN = "/Contents/MacOS/Codex";
const CODEX_BINARY_NAME_LINUX = "codex";
/**
 * On Windows the resolved app path already points at the executable
 * (`...\app\ChatGPT.exe`), so there is no bundle-relative suffix to append.
 */
const CODEX_BINARY_NAME_WIN32 = "";

/**
 * Return the binary path suffix used to identify a Codex process on the
 * current platform.
 */
export function getCodexBinarySuffix(platform: CodexmPlatform): string {
  if (platform === "darwin") {
    return CODEX_BINARY_NAME_DARWIN;
  }

  if (platform === "win32") {
    return CODEX_BINARY_NAME_WIN32;
  }

  return CODEX_BINARY_NAME_LINUX;
}

/**
 * Check whether a Windows command string points at the Codex Desktop
 * executable (MSIX package or a classic per-user install).
 */
export function isCodexDesktopCommandWindows(command: string): boolean {
  const normalized = command.replace(/"/g, "").replace(/\//g, "\\").toLowerCase();
  const base = normalized.split("\\").pop() ?? "";
  if (base !== "chatgpt.exe" && base !== "codex.exe") {
    return false;
  }

  // MSIX package (the Store build ships as OpenAI.Codex_<version>_<arch>__<publisher>).
  if (normalized.includes("openai.codex_")) {
    return true;
  }

  // Classic per-user / per-machine install. Deliberately not a generic
  // "\codex\" match: the CLI lives under %LOCALAPPDATA%\OpenAI\Codex\bin and
  // must never be treated as (or terminated as) Codex Desktop.
  return normalized.includes("\\programs\\codex\\") || normalized.includes("\\program files\\codex\\");
}

/**
 * Check whether a process command string looks like a Codex Desktop process
 * on the given platform.
 */
export function isCodexDesktopCommand(command: string, platform: CodexmPlatform): boolean {
  if (platform === "darwin") {
    return command.includes(CODEX_BINARY_NAME_DARWIN);
  }

  if (platform === "win32") {
    return isCodexDesktopCommandWindows(command);
  }
  // On Linux/WSL, the Electron binary is typically just called "codex"
  // and launched from an installed path.
  const basename = command.split("/").pop()?.split(" ")[0] ?? "";
  return basename === CODEX_BINARY_NAME_LINUX || command.includes("/codex ");
}

/**
 * Check whether a process command string looks like a Codex CLI process
 * (non-Desktop, terminal-based).
 */
export function isCodexCliCommand(command: string): boolean {
  const parts = command.trim().split(/\s+/);
  const binary = parts[0]?.split("/").pop() ?? "";
  // "codex" without "--remote-debugging-port" is likely CLI mode
  return (
    binary === "codex" &&
    !command.includes("--remote-debugging-port")
  );
}
