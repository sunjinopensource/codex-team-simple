import { startWindowsTray, type TrayAction, type TrayHandlers, type TrayHost } from "./windows-tray.js";

export type { TrayAction, TrayHandlers, TrayHost };

/**
 * Tray support is Windows-only for now. Other platforms keep the console
 * usable: `--tray` reports the fallback and the console still serves.
 */
export function isTraySupported(): boolean {
  return process.platform === "win32";
}

export function startTray(handlers: TrayHandlers): TrayHost | null {
  if (!isTraySupported()) {
    return null;
  }
  return startWindowsTray(handlers);
}
