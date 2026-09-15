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
 * The server is the single source of truth: after a pass, this machine holds
 * exactly what the server holds — same accounts, same tokens.
 *
 *   1. mirror  — every account the server lists is created or overwritten
 *                locally, and every account it does not list is deleted, so
 *                the local roster cannot drift from the server (accounts in
 *                `freshLocalNames` are spared: they were just added here and
 *                are uploaded by step 3 in the same pass)
 *   2. refresh — refresh what is due, but only under a server-issued lease so
 *                two machines never rotate the same refresh token
 *   3. push    — upload the copies that are newer locally (a refresh from step
 *                2, or an account only this machine has), so both sides match
 *
 * Step 1 runs first on purpose: refreshing a token another machine already
 * rotated would fail and would waste the lease.
 */

export const AUTO_SYNC_INTERVAL_MS = 5 * 60 * 1_000;
export const AUTO_SYNC_JITTER_MS = 60 * 1_000;

const CLIENT_ID_FILE_NAME = "registry-client-id.json";

export type AutoSyncAction =
  | "pulled"
  | "removed"
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
  /**
   * Accounts this machine just created. The mirror step reads "absent on the
   * server" as local drift and deletes, which would throw away an account that
   * was added a second ago and has not been uploaded yet (step 3 does that).
   */
  freshLocalNames?: readonly string[];
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
  const localByName = new Map(accounts.map((account) => [account.name, account]));
  const currentStatus = await options.store.getCurrentStatus();
  const activeNames = new Set(currentStatus.matched_accounts);

  const results: AutoSyncAccountResult[] = [];
  const adopted = new Set<string>();
  const removed = new Set<string>();
  const freshLocalNames = new Set(options.freshLocalNames ?? []);

  // Mirror, part one: take the server's copy of everything it knows about.
  // A local copy only survives when it is newer — and step 3 uploads it, so
  // the two sides still end up identical.
  for (const remoteAccount of remoteAccounts) {
    const localAccount = localByName.get(remoteAccount.name);

    if (localAccount) {
      const localExpiry = await readLocalRegistryExpiry(localAccount.authPath);
      // Ours stays only when it is provably fresher — step 3 uploads it, so
      // both sides still end up identical. An unreadable local expiry means
      // there is nothing to compare, so the server's copy wins.
      if (localExpiry && !isNewerExpiry(remoteAccount.token_expires_at, localExpiry)) {
        continue;
      }
    }

    try {
      await adoptRemoteAccount({
        store: options.store,
        config,
        name: remoteAccount.name,
        activeNames,
      });
      adopted.add(remoteAccount.name);
      options.debugLog?.(`autosync: pulled ${remoteAccount.name} from registry`);
      results.push({
        name: remoteAccount.name,
        action: "pulled",
        reason: localAccount ? "已用服务器数据覆盖本地" : "服务器新增的账号",
      });
    } catch (error) {
      results.push({ name: remoteAccount.name, action: "failed", error: describeError(error) });
    }
  }

  // Mirror, part two: whatever the server does not list is local drift and is
  // deleted. The account in active use is spared — deleting the auth file
  // under a running Codex session would break it.
  for (const account of accounts) {
    if (remoteByName.has(account.name)) {
      continue;
    }

    if (freshLocalNames.has(account.name)) {
      // Added here moments ago: step 3 uploads it, so the server learns about
      // it in this very pass. Deleting it now would drop the only copy.
      continue;
    }

    if (activeNames.has(account.name)) {
      results.push({
        name: account.name,
        action: "skipped",
        reason: "服务器上已没有此账号，但它正在使用中，未删除",
      });
      continue;
    }

    try {
      await options.store.removeAccount(account.name);
      removed.add(account.name);
      options.debugLog?.(`autosync: removed ${account.name}: no longer on the registry`);
      results.push({ name: account.name, action: "removed", reason: "服务器上已没有此账号" });
    } catch (error) {
      results.push({ name: account.name, action: "failed", error: describeError(error) });
    }
  }

  for (const account of accounts) {
    if (adopted.has(account.name) || removed.has(account.name)) {
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
    /** A pass that never reached the server (offline, bad url/token). */
    onError?: (error: unknown) => void | Promise<void>;
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
      await options.onError?.(error);
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
  name: string;
  activeNames: Set<string>;
}): Promise<void> {
  const raw = await downloadBundle(options.config, options.name);
  const bundle = parseShareBundle(JSON.stringify(raw));
  await options.store.addAccountSnapshot(options.name, bundle.auth.auth_json, {
    force: true,
    rawConfig: bundle.auth.config_toml ?? null,
  });

  if (options.activeNames.has(options.name)) {
    // Same account, new token: re-apply so a running Codex session picks it
    // up, without changing which account is selected.
    await switchAccountPreservingProxyRuntime({
      store: options.store,
      name: options.name,
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
