import { hostname, userInfo } from "node:os";

import type { AccountStore } from "../account-store/index.js";
import {
  PRESENCE_TTL_MS,
  clearPresence,
  reportPresence,
  resolveRemote,
  type PresenceIdentity,
} from "./client.js";

/**
 * Tell the registry which managed account this machine is logged into, so the
 * server can answer "who is using this account right now?".
 *
 * The console is a loopback app, so presence is per machine: it heartbeats the
 * accounts currently matched in ~/.codex/auth.json under this machine's client
 * id, and clears an entry when the account is no longer in use or the console
 * stops. Expiry on the server side is the backstop for a hard crash.
 */

export const PRESENCE_INTERVAL_MS = 60_000;

export interface PresenceHeartbeatOptions {
  store: AccountStore;
  remoteName?: string | null;
  clientId: string;
  /**
   * Asked on every beat: the OA user behind the console is only known once a
   * request carried a session cookie, which can be later than startup.
   */
  getUser?: () => PresenceIdentity | null;
  intervalMs?: number;
  ttlMs?: number;
  debugLog?: (message: string) => void;
}

export interface PresenceHeartbeat {
  stop: () => Promise<void>;
  /** Accounts this machine last reported itself as using. */
  reported: () => string[];
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Without TOF the best identity available is the OS account running the console. */
function fallbackIdentity(): PresenceIdentity {
  let username = "";
  try {
    username = userInfo().username;
  } catch {
    username = "";
  }
  return { login_name: username, chinese_name: "" };
}

let safeHost = "";
try {
  safeHost = hostname();
} catch {
  safeHost = "";
}

export function startPresenceHeartbeat(options: PresenceHeartbeatOptions): PresenceHeartbeat {
  const intervalMs = options.intervalMs ?? PRESENCE_INTERVAL_MS;
  const ttlMs = options.ttlMs ?? PRESENCE_TTL_MS;
  const controller = new AbortController();
  let announced = new Set<string>();
  let stopped = false;

  async function beat(): Promise<void> {
    const { config } = await resolveRemote(options.store, options.remoteName ?? null);
    const status = await options.store.getCurrentStatus();
    const active = new Set(status.matched_accounts ?? []);
    const user = options.getUser?.() ?? null;
    const identity = user ?? fallbackIdentity();

    for (const name of active) {
      await reportPresence(config, name, {
        clientId: options.clientId,
        user: identity,
        host: safeHost,
        ttlMs,
      });
      announced.add(name);
    }

    // Switched away (or the account stopped matching): say so now instead of
    // waiting for the entry to age out.
    for (const name of [...announced]) {
      if (active.has(name)) {
        continue;
      }
      await clearPresence(config, name, { clientId: options.clientId });
      announced.delete(name);
    }
  }

  void (async () => {
    while (!controller.signal.aborted) {
      try {
        await beat();
      } catch (error) {
        // Offline server, bad token, unsupported endpoint: presence is a
        // convenience, so it must never take the console down with it.
        options.debugLog?.(`presence: ${describeError(error)}`);
      }
      if (controller.signal.aborted) {
        return;
      }
      await delay(intervalMs, controller.signal);
    }
  })();

  return {
    reported: () => [...announced],
    async stop(): Promise<void> {
      if (stopped) {
        return;
      }
      stopped = true;
      controller.abort();
      const leaving = [...announced];
      announced = new Set();
      if (leaving.length === 0) {
        return;
      }
      try {
        const { config } = await resolveRemote(options.store, options.remoteName ?? null);
        for (const name of leaving) {
          await clearPresence(config, name, { clientId: options.clientId });
        }
        options.debugLog?.(`presence: cleared ${leaving.join(", ")}`);
      } catch (error) {
        // Shutting down: the server expires the entry anyway.
        options.debugLog?.(`presence: leave failed: ${describeError(error)}`);
      }
    },
  };
}
