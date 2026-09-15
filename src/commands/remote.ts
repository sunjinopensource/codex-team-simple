import { randomUUID } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ensureAccountName, type AccountStore } from "../account-store/index.js";
import { FILE_MODE } from "../account-store/storage.js";
import { writeJson } from "../cli/output.js";
import { getUsage } from "../cli/spec.js";
import {
  RegistryConflictError,
  addRemote,
  deleteRemoteAccount,
  downloadBundle,
  listRemoteAccounts,
  readRemotesFile,
  removeRemote,
  resolveRemote,
  uploadBundle,
  type RemoteAccount,
} from "../registry/client.js";
import { deriveShareBundleFacts, readShareBundleFile } from "../share-bundle.js";
import { switchAccountPreservingProxyRuntime } from "../switching.js";
import { exportShareBundle, importShareBundle } from "./share-bundle.js";

type DebugLogger = (message: string) => void;

function tempBundlePath(label: string): string {
  return join(tmpdir(), `codexm-remote-${label}-${randomUUID()}.json`);
}

function tokenHint(token: string): string {
  return token.length <= 8 ? "****" : `${token.slice(0, 4)}…${token.slice(-2)}`;
}

function formatAccountLine(account: RemoteAccount): string {
  return `  ${account.name.padEnd(18)}${(account.plan_type ?? "-").padEnd(10)}${account.updated_at ?? "-"}`;
}

function resolveToken(explicit: string | undefined | null): string | null {
  const value = explicit ?? process.env.CODEXM_REMOTE_TOKEN ?? null;
  return value && value.trim() !== "" ? value.trim() : null;
}

function decodeJwtExp(token: unknown): number | null {
  if (typeof token !== "string") {
    return null;
  }
  const parts = token.split(".");
  if (parts.length < 2) {
    return null;
  }
  try {
    const claims = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as {
      exp?: unknown;
    };
    return typeof claims.exp === "number" ? claims.exp : null;
  } catch {
    return null;
  }
}

async function readLocalTokenExpiry(authPath: string): Promise<number | null> {
  try {
    const parsed = JSON.parse(await readFile(authPath, "utf8")) as {
      tokens?: { id_token?: unknown; access_token?: unknown };
    };
    return (
      decodeJwtExp(parsed.tokens?.id_token) ?? decodeJwtExp(parsed.tokens?.access_token)
    );
  } catch {
    return null;
  }
}

function parseIsoTimestamp(value: string | null | undefined): number | null {
  if (!value) {
    return null;
  }
  const millis = Date.parse(value);
  return Number.isNaN(millis) ? null : Math.floor(millis / 1000);
}

export async function handleRemoteCommand(options: {
  positionals: string[];
  optionValues: Map<string, string | undefined>;
  flags: Set<string>;
  json: boolean;
  store: AccountStore;
  stdout: NodeJS.WriteStream;
  debugLog?: DebugLogger;
}): Promise<number> {
  const { positionals, optionValues, flags, json, store, stdout, debugLog } = options;
  const [subcommand, ...rest] = positionals;
  const remoteFlag = optionValues.get("--remote") ?? null;
  const asName = optionValues.get("--as") ?? null;
  const force = flags.has("--force");

  const usage = (key?: string) => {
    throw new Error(`Usage: ${getUsage("remote", key)}`);
  };

  if (!subcommand) {
    usage();
  }

  debugLog?.(`remote: subcommand=${subcommand} remote=${remoteFlag ?? "default"} as=${asName ?? "-"}`);

  let payload: Record<string, unknown> = { ok: true };
  let humanLines: string[] = [];

  switch (subcommand) {
    case "add": {
      if (rest.length !== 2) {
        usage("add");
      }
      const [name, url] = rest;
      const token = resolveToken(optionValues.get("--token"));
      if (!token) {
        usage("add");
      }
      await addRemote(store, { name, url, token: token as string });
      payload = { ok: true, action: "remote.add", remote: name, url };
      humanLines = [`Added registry remote "${name}" -> ${url}`];
      break;
    }

    case "remove": {
      if (rest.length !== 1) {
        usage();
      }
      const removed = await removeRemote(store, rest[0]);
      payload = { ok: true, action: "remote.remove", remote: rest[0], removed };
      humanLines = [
        removed
          ? `Removed registry remote "${rest[0]}".`
          : `Registry remote "${rest[0]}" was not configured.`,
      ];
      break;
    }

    case "list": {
      const data = await readRemotesFile(store);
      payload = {
        ok: true,
        action: "remote.list",
        default_remote: data.default_remote,
        remotes: Object.entries(data.remotes).map(([name, config]) => ({
          name,
          url: config.url,
          default: name === data.default_remote,
          token_hint: tokenHint(config.token),
        })),
      };
      humanLines = Object.keys(data.remotes).length === 0
        ? ['No registry remotes configured. Use "codexm remote add <name> <url> --token <token>".']
        : Object.entries(data.remotes).map(
            ([name, config]) =>
              `  ${name === data.default_remote ? "*" : " "} ${name.padEnd(16)}${config.url}  (token ${tokenHint(config.token)})`,
          );
      break;
    }

    case "accounts": {
      const { name, config } = await resolveRemote(store, remoteFlag);
      const accounts = await listRemoteAccounts(config);
      payload = { ok: true, action: "remote.accounts", remote: name, accounts };
      humanLines = accounts.length === 0
        ? [`Registry "${name}" has no accounts yet.`]
        : [`Registry "${name}":`, ...accounts.map(formatAccountLine)];
      break;
    }

    case "push": {
      const sourceName = rest[0] ?? null;
      const targetName = asName ?? sourceName;
      if (!targetName) {
        usage("push");
      }
      ensureAccountName(targetName);

      const { name, config } = await resolveRemote(store, remoteFlag);
      const bundlePath = tempBundlePath(targetName);
      try {
        const { bundle } = await exportShareBundle({
          store,
          sourceName,
          outputPath: bundlePath,
          force: true,
        });
        await uploadBundle(config, targetName, bundle, { force });
      } catch (error) {
        if (error instanceof RegistryConflictError) {
          throw new Error(
            `Registry "${name}" holds a newer copy of "${targetName}" (${
              error.reason ?? "stale"
            }). Run \`codexm remote pull ${targetName}\` first, or re-run with --force to overwrite.`,
          );
        }
        throw error;
      } finally {
        await rm(bundlePath, { force: true }).catch(() => {});
      }

      payload = {
        ok: true,
        action: "remote.push",
        remote: name,
        account: targetName,
        source: sourceName ?? "current",
      };
      humanLines = [`Pushed "${targetName}" to registry "${name}".`];
      break;
    }

    case "sync": {
      const result = await syncAccountsToRemote({ store, remoteName: remoteFlag, force });
      payload = {
        ok: result.failed === 0,
        action: "remote.sync",
        remote: result.remote,
        pushed: result.pushed,
        skipped: result.skipped,
        failed: result.failed,
        results: result.results,
      };
      humanLines =
        result.results.length === 0
          ? ["No managed accounts on this machine to sync."]
          : [
              `Sync to registry "${result.remote}": ${result.pushed} pushed, ${result.skipped} skipped, ${result.failed} failed.`,
              ...result.results
                .filter((entry) => entry.status !== "pushed")
                .map(
                  (entry) =>
                    `  ${entry.status.padEnd(8)}${entry.name} — ${entry.reason ?? entry.error}`,
                ),
            ];
      break;
    }

    case "pull": {
      const remoteAccountName = rest[0];
      if (!remoteAccountName) {
        usage("pull");
      }
      const localName = asName ?? remoteAccountName;
      ensureAccountName(localName);

      const { name, config } = await resolveRemote(store, remoteFlag);
      const downloaded = await downloadBundle(config, remoteAccountName);
      const bundlePath = tempBundlePath(remoteAccountName);
      let importedAccount;
      let switchResult;
      let reusedExisting = false;
      try {
        await writeFile(bundlePath, `${JSON.stringify(downloaded, null, 2)}\n`, {
          mode: FILE_MODE,
        });
        const bundle = await readShareBundleFile(bundlePath);
        const facts = deriveShareBundleFacts(bundle.auth.auth_json);

        // If this machine already manages that identity under another name,
        // switching to it is what "pull" means — importing a second copy would
        // just trip the duplicate-identity guard.
        const { accounts } = await store.listAccounts();
        const existing = accounts.find((account) => account.identity === facts.identity);
        if (existing) {
          reusedExisting = true;
          importedAccount = existing;
          switchResult = await switchAccountPreservingProxyRuntime({
            store,
            name: existing.name,
          });
        } else {
          ({ account: importedAccount } = await importShareBundle({
            store,
            bundlePath,
            localName,
            force,
          }));
          switchResult = await switchAccountPreservingProxyRuntime({ store, name: localName });
        }
      } finally {
        await rm(bundlePath, { force: true }).catch(() => {});
      }

      payload = {
        ok: true,
        action: "remote.pull",
        remote: name,
        account: {
          name: importedAccount.name,
          account_id: importedAccount.account_id,
          identity: importedAccount.identity,
          auth_mode: importedAccount.auth_mode,
        },
        reused_existing: reusedExisting,
        switched: true,
        proxy_retained: switchResult.proxyRetained,
        warnings: switchResult.result.warnings,
      };
      humanLines = [
        reusedExisting
          ? `This identity is already saved locally as "${importedAccount.name}"; switched to it without re-importing.`
          : `Pulled "${remoteAccountName}" from registry "${name}" and switched to it.`,
        ...(reusedExisting && asName && asName !== importedAccount.name
          ? [`Ignored --as "${asName}": codexm keeps exactly one saved copy per identity.`]
          : []),
        ...(switchResult.proxyRetained
          ? ["Proxy runtime stays active: the proxy upstream was updated instead of local auth."]
          : []),
      ];
      break;
    }

    case "delete": {
      if (rest.length !== 1) {
        usage();
      }
      const { name, config } = await resolveRemote(store, remoteFlag);
      await deleteRemoteAccount(config, rest[0]);
      payload = { ok: true, action: "remote.delete", remote: name, account: rest[0] };
      humanLines = [`Deleted "${rest[0]}" from registry "${name}".`];
      break;
    }

    default:
      usage();
  }

  if (json) {
    writeJson(stdout, payload);
  } else {
    for (const line of humanLines) {
      stdout.write(`${line}\n`);
    }
  }

  return payload.ok === false ? 1 : 0;
}

export type SyncResult = {
  name: string;
  status: "pushed" | "skipped" | "failed";
  reason?: string;
  error?: string;
};

export type SyncSummary = {
  remote: string;
  pushed: number;
  skipped: number;
  failed: number;
  results: SyncResult[];
};

/**
 * Push every local managed account to a registry, skipping accounts whose
 * registry copy already carries a token that expires at least as late.
 * Shared by `codexm remote sync` and the web console.
 */
export async function syncAccountsToRemote(options: {
  store: AccountStore;
  remoteName?: string | null;
  force?: boolean;
}): Promise<SyncSummary> {
  const { store, force } = options;
  const { name, config } = await resolveRemote(store, options.remoteName ?? null);
  const { accounts } = await store.listAccounts();
  const remoteAccounts = await listRemoteAccounts(config);
  const remoteByName = new Map(remoteAccounts.map((account) => [account.name, account]));

  const results: SyncResult[] = [];

  for (const account of accounts) {
    const remoteAccount = remoteByName.get(account.name);
    // A blind upload could rewind a token another machine already refreshed,
    // so keep whichever copy carries the later expiry claim.
    if (remoteAccount && force !== true) {
      const localExpiry = await readLocalTokenExpiry(account.authPath);
      const remoteExpiry = parseIsoTimestamp(remoteAccount.token_expires_at);
      if (localExpiry !== null && remoteExpiry !== null && localExpiry <= remoteExpiry) {
        results.push({
          name: account.name,
          status: "skipped",
          reason: "registry already holds a token that expires later or equally late",
        });
        continue;
      }
    }

    const bundlePath = tempBundlePath(account.name);
    try {
      const { bundle } = await exportShareBundle({
        store,
        sourceName: account.name,
        outputPath: bundlePath,
        force: true,
      });
      await uploadBundle(config, account.name, bundle, { force: force === true });
      results.push({ name: account.name, status: "pushed" });
    } catch (error) {
      if (error instanceof RegistryConflictError) {
        // Lost a race with another machine: adopting its copy on the next
        // pass is the right move, so this is a skip, not a failure.
        results.push({
          name: account.name,
          status: "skipped",
          reason: error.reason ?? "registry holds a newer token",
        });
        continue;
      }
      results.push({
        name: account.name,
        status: "failed",
        error: (error as Error).message,
      });
    } finally {
      await rm(bundlePath, { force: true }).catch(() => {});
    }
  }

  return {
    remote: name,
    pushed: results.filter((entry) => entry.status === "pushed").length,
    skipped: results.filter((entry) => entry.status === "skipped").length,
    failed: results.filter((entry) => entry.status === "failed").length,
    results,
  };
}
