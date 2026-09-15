import { stderr as defaultStderr, stdout as defaultStdout } from "node:process";
import packageJson from "../package.json";

import { AccountStore, createAccountStore } from "./account-store/index.js";
import type { CodexLoginProvider } from "./codex-login.js";
import { createCodexLoginProvider } from "./codex-login.js";
import { handleUiCommand } from "./commands/ui.js";
import type { CodexDesktopLauncher } from "./desktop/launcher.js";
import { createPlatformDesktopLauncher } from "./platform-desktop-adapter.js";

const HELP_TEXT = `codexm — local web console for Codex ChatGPT accounts

Usage:
  codexm ui [--port <1-65535>] [--no-open] [--tray] [--debug]

Options:
  --port <port>  serve the console on a fixed port instead of a random one
  --no-open      start the server without opening a browser tab
  --tray         keep the console resident in the system tray (Windows)
  --debug        log background activity to stderr
  -h, --help     show this help
  -v, --version  show the version
`;

interface CliStreams {
  stdout: NodeJS.WriteStream;
  stderr: NodeJS.WriteStream;
}

export interface RunCliOptions extends Partial<CliStreams> {
  store?: AccountStore;
  desktopLauncher?: CodexDesktopLauncher;
  authLogin?: CodexLoginProvider;
}

interface ParsedArgs {
  port: string | null;
  noOpen: boolean;
  tray: boolean;
  debug: boolean;
}

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = { port: null, noOpen: false, tray: false, debug: false };
  let expectPort = false;

  for (const arg of argv) {
    if (expectPort) {
      parsed.port = arg;
      expectPort = false;
      continue;
    }

    if (arg === "--port") {
      expectPort = true;
      continue;
    }

    if (arg.startsWith("--port=")) {
      parsed.port = arg.slice("--port=".length);
      continue;
    }

    if (arg === "--no-open") {
      parsed.noOpen = true;
      continue;
    }

    if (arg === "--tray") {
      parsed.tray = true;
      continue;
    }

    if (arg === "--debug") {
      parsed.debug = true;
    }
  }

  if (expectPort) {
    throw new Error("Missing value for --port.");
  }

  return parsed;
}

function createDebugLogger(
  stream: NodeJS.WriteStream,
  enabled: boolean,
): (message: string) => void {
  if (!enabled) {
    return () => undefined;
  }

  return (message: string) => {
    stream.write(`[debug] ${message}\n`);
  };
}

export async function runCli(argv: string[], options: RunCliOptions = {}): Promise<number> {
  const streams: CliStreams = {
    stdout: options.stdout ?? defaultStdout,
    stderr: options.stderr ?? defaultStderr,
  };

  if (argv.includes("--help") || argv.includes("-h")) {
    streams.stdout.write(HELP_TEXT);
    return 0;
  }

  if (argv.includes("--version") || argv.includes("-v")) {
    streams.stdout.write(`${packageJson.version}\n`);
    return 0;
  }

  const rest = argv[0] === "ui" ? argv.slice(1) : argv;
  const parsed = parseArgs(rest);
  const debugLog = createDebugLogger(streams.stderr, parsed.debug);
  const store = options.store ?? createAccountStore();
  const desktopLauncher =
    options.desktopLauncher ?? (await createPlatformDesktopLauncher());
  const authLogin = options.authLogin ?? createCodexLoginProvider();

  return await handleUiCommand({
    store,
    stdout: streams.stdout,
    desktopLauncher,
    authLogin,
    portOption: parsed.port,
    noOpen: parsed.noOpen,
    tray: parsed.tray,
    debugLog,
  });
}
