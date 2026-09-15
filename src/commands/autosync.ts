import { randomBytes } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";

import type { AccountStore, ManagedAccount } from "../account-store/index.js";
import { inspectManagedAccountAuthRefreshNeed } from "../auth-refresh.js";
import { readAuthSnapshotFile } from "../auth-snapshot.js";
import {
  REFRESH_LEASE_TTL_MS,
  RegistryConflictError,
  acquireRefreshLease,
  downloadBundle,
  isNewerExpiry,
  listRemoteAccounts,
  readLocalRegistryExpiry,
  releaseRefreshLease,
  resolveRemote,
  uploadBundle,
  type RemoteConfig,
} from "../registry/client.js";
import { parseShareBundle, type ShareBundle } from "../share-bundle.js";
import { switchAccountPreservingProxyRuntime } from "../switching.js";
import { exportShareBundle } from "./share-bundle.js";

/**
 * Unattended registry convergence.
 *
 * Every machine using an account runs the same three steps, so tokens stay in
 * sync with no manual action:
 *
 *   1. adopt  — take the registry copy when it holds a newer token
 *   2. refresh — refresh what is due, but only under a server-issued lease so
 *                two machines never rotate the same refresh token
 *   3. push   — offer local-only changes (manual replace/import) upstream
 *
 * Step 1 runs first on purpose: refreshing a token another machine already
 * rotated would fail and would waste the lease.
 */

export const AUTO_SYNC_INTERVAL_MS = 5 * 60 * 1_000;
export const AUTO_SYNC_JITTER_MS = 60 * 1_000;

const CLIENT_ID_FILE_NAME = "registry-client-id.json";

export type AutoSyncAction =
  | "pulled"
  | "refreshed"
  | "pushed"
  | "unchanged"
  | "skipped"
  | "failed";

export interface AutoSyncAccountResult {
  name: string;
  action: AutoSyncAction;
  reason?: string;
  error?: string;
}

export interface AutoSyncRunResult {
  remote: string;
  started_at: string;
  finished_at: string;
  accounts: AutoSyncAccountResult[];
}

export interface AutoSyncOptions {
  store: AccountStore;
  remoteName?: string | null;
  clientId: string;
  now?: Date;
  debugLog?: (message: string) => void;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const clientIdCache = new Map<string, string>();

/**
 * A stable identity for this machine, so a lease can be renewed by whoever
 * holds it and denied to everyone else.
 */
export async function resolveRegistryClientId(codexTeamDir: string): Promise<string> {
  const cached = clientIdCache.get(codexTeamDir);
  if (cached) {
    return cached;
  }

  const filePath = join(codexTeamDir, CLIENT_ID_FILE_NAME);
  try {
    const parsed = JSON.parse(await readFile(filePath, "utf8")) as { client_id?: unknown };
    if (typeof parsed.client_id === "string" && parsed.client_id.trim() !== "") {
      clientIdCache.set(codexTeamDir, parsed.client_id);
      return parsed.client_id;
    }
  } catch {
    // Missing or unreadable: mint a fresh id below.
  }

  const safeHost = hostname().replace(/[^A-Za-z0-9._-]/gu, "") || "codexm";
  const clientId = `${safeHost}-${randomBytes(3).toString("hex")}`;
  clientIdCache.set(codexTeamDir, clientId);
  try {
    await writeFile(filePath, `${JSON.stringify({ client_id: clientId }, null, 2)}\n`, "utf8");
  } catch {
    // Keep going: the in-memory id is stable for this process either way.
  }
  return clientId;
}

export async function runAutoSyncOnce(options: AutoSyncOptions): Promise<AutoSyncRunResult> {
  const now = options.now ?? new Date();
  const startedAt = now.toISOString();
  const { name: remoteName, config } = await resolveRemote(
    options.store,
    options.remoteName ?? null,
  );

  const { accounts } = await options.store.listAccounts();
  const remoteAccounts = await listRemoteAccounts(config);
  const remoteByName = new Map(remoteAccounts.map((entry) => [entry.name, entry]));
  const currentStatus = await options.store.getCurrentStatus();
  const activeNames = new Set(currentStatus.matched_accounts);

  const results: AutoSyncAccountResult[] = [];
  const adopted = new Set<string>();

  for (const account of accounts) {
    const remoteAccount = remoteByName.get(account.name);
    if (!remoteAccount) {
      continue;
    }
    const localExpiry = await readLocalRegistryExpiry(account.authPath);
    if (!isNewerExpiry(remoteAccount.token_expires_at, localExpiry)) {
      continue;
    }

    try {
      await adoptRemoteAccount({ store: options.store, config, account, activeNames });
      adopted.add(account.name);
      options.debugLog?.(`autosync: adopted newer registry token for ${account.name}`);
      results.push({
        name: account.name,
        action: "pulled",
        reason: "registry holds a newer token",
      });
    } catch (error) {
      results.push({ name: account.name, action: "failed", error: describeError(error) });
    }
  }

  for (const account of accounts) {
    if (adopted.has(account.name)) {
      continue;
    }

    let snapshot;
    try {
      snapshot = await readAuthSnapshotFile(account.authPath);
    } catch (error) {
      results.push({ name: account.name, action: "failed", error: describeError(error) });
      continue;
    }

    const decision = inspectManagedAccountAuthRefreshNeed(account, snapshot, now);
    if (decision.due) {
      results.push(
        await refreshUnderLease({
          store: options.store,
          config,
          account,
          clientId: options.clientId,
          now,
          reason: decision.reason,
          debugLog: options.debugLog,
        }),
      );
      continue;
    }

    const remoteAccount = remoteByName.get(account.name);
    const localExpiry = await readLocalRegistryExpiry(account.authPath);
    if (remoteAccount && !isNewerExpiry(localExpiry, remoteAccount.token_expires_at)) {
      results.push({ name: account.name, action: "unchanged" });
      continue;
    }

    results.push(
      await pushLocalBundle({
        store: options.store,
        config,
        account,
        debugLog: options.debugLog,
      }),
    );
  }

  return {
    remote: remoteName,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    accounts: results,
  };
}

export async function runAutoSyncLoop(
  options: AutoSyncOptions & {
    signal?: AbortSignal;
    intervalMs?: number;
    jitterMs?: number;
    onRun?: (result: AutoSyncRunResult) => void | Promise<void>;
  },
): Promise<void> {
  const intervalMs = options.intervalMs ?? AUTO_SYNC_INTERVAL_MS;
  const jitterMs = options.jitterMs ?? AUTO_SYNC_JITTER_MS;

  while (!options.signal?.aborted) {
    try {
      const result = await runAutoSyncOnce(options);
      await options.onRun?.(result);
    } catch (error) {
      // A failed pass (server down, bad token) must not kill the loop.
      options.debugLog?.(`autosync: run failed: ${describeError(error)}`);
    }

    if (options.signal?.aborted) {
      return;
    }
    // Spread machines across the interval so they do not all arrive at once.
    await delay(intervalMs + Math.floor(Math.random() * jitterMs), options.signal);
  }
}

async function adoptRemoteAccount(options: {
  store: AccountStore;
  config: RemoteConfig;
  account: ManagedAccount;
  activeNames: Set<string>;
}): Promise<void> {
  const raw = await downloadBundle(options.config, options.account.name);
  const bundle = parseShareBundle(JSON.stringify(raw));
  await options.store.addAccountSnapshot(options.account.name, bundle.auth.auth_json, {
    force: true,
    rawConfig: bundle.auth.config_toml ?? null,
  });

  if (options.activeNames.has(options.account.name)) {
    // Same account, new token: re-apply so a running Codex session picks it
    // up, without changing which account is selected.
    await switchAccountPreservingProxyRuntime({
      store: options.store,
      name: options.account.name,
    });
  }
}

async function refreshUnderLease(options: {
  store: AccountStore;
  config: RemoteConfig;
  account: ManagedAccount;
  clientId: string;
  now: Date;
  reason: string;
  debugLog?: (message: string) => void;
}): Promise<AutoSyncAccountResult> {
  const { store, config, account, clientId } = options;

  let lease;
  try {
    lease = await acquireRefreshLease(config, account.name, {
      clientId,
      ttlMs: REFRESH_LEASE_TTL_MS,
    });
  } catch (error) {
    return {
      name: account.name,
      action: "failed",
      error: `lease request failed: ${describeError(error)}`,
    };
  }

  if (!lease.granted) {
    return {
      name: account.name,
      action: "skipped",
      reason: `another machine (${lease.holder ?? "unknown"}) is refreshing this account`,
    };
  }

  try {
    await store.refreshAuthForAccount(account.name, { now: options.now });
    const bundle = await exportAccountBundle(store, account.name);
    await uploadBundle(config, account.name, bundle, { leaseId: lease.lease_id });
    options.debugLog?.(`autosync: refreshed and uploaded ${account.name}`);
    return { name: account.name, action: "refreshed", reason: options.reason };
  } catch (error) {
    // The refreshed token is already on disk, so the next pass pushes it even
    // if this upload failed; nothing is lost by not retrying here.
    return { name: account.name, action: "failed", error: describeError(error) };
  } finally {
    await releaseRefreshLease(config, account.name, { clientId }).catch(() => false);
  }
}

async function pushLocalBundle(options: {
  store: AccountStore;
  config: RemoteConfig;
  account: ManagedAccount;
  debugLog?: (message: string) => void;
}): Promise<AutoSyncAccountResult> {
  try {
    const bundle = await exportAccountBundle(options.store, options.account.name);
    await uploadBundle(options.config, options.account.name, bundle);
    options.debugLog?.(`autosync: pushed local copy of ${options.account.name}`);
    return { name: options.account.name, action: "pushed" };
  } catch (error) {
    if (error instanceof RegistryConflictError) {
      return {
        name: options.account.name,
        action: "skipped",
        reason: error.reason ?? "registry holds a newer token",
      };
    }
    return { name: options.account.name, action: "failed", error: describeError(error) };
  }
}

async function exportAccountBundle(store: AccountStore, name: string): Promise<ShareBundle> {
  const bundlePath = join(
    tmpdir(),
    `codexm-autosync-${name}-${randomBytes(6).toString("hex")}.json`,
  );
  try {
    const { bundle } = await exportShareBundle({
      store,
      sourceName: name,
      outputPath: bundlePath,
      force: true,
    });
    return bundle;
  } finally {
    await rm(bundlePath, { force: true }).catch(() => {});
  }
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }

    const onAbort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
