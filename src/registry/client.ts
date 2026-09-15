import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { AccountStore } from "../account-store/index.js";
import { FILE_MODE, atomicWriteFile } from "../account-store/storage.js";
import {
  decodeJwtPayload,
  readAuthSnapshotFile,
  type AuthSnapshot,
} from "../auth-snapshot.js";

const REMOTES_FILE_NAME = "remotes.json";

/**
 * How long a refresh lease stays valid — long enough for a single OAuth
 * round-trip, short enough that an abandoned one disappears on its own.
 */
export const REFRESH_LEASE_TTL_MS = 120_000;

export interface RemoteConfig {
  url: string;
  token: string;
}

export interface RemotesFile {
  remotes: Record<string, RemoteConfig>;
  default_remote: string | null;
}

export interface RemoteAccount {
  name: string;
  kind: string | null;
  plan_type: string | null;
  account_id: string | null;
  token_expires_at: string | null;
  updated_at: string | null;
  last_downloaded_at: string | null;
  size: number | null;
  /** Monotonic write counter stamped by the server; absent on older servers. */
  version: number | null;
}

export interface RefreshLease {
  granted: boolean;
  lease_id: string | null;
  expires_at: string | null;
  holder: string | null;
  /** Server predates leases: refresh unguarded rather than not at all. */
  unsupported?: boolean;
}

export interface UploadReceipt {
  version: number | null;
  token_expires_at: string | null;
}

/**
 * The server refused an upload because the registry already holds a newer
 * copy (or the supplied lease is not the live one). Not an error to retry —
 * the caller should adopt the server's copy instead.
 */
export class RegistryConflictError extends Error {
  readonly status = 409;
  readonly reason: string | null;
  readonly current: RemoteAccount | null;

  constructor(message: string, options: { reason?: unknown; current?: unknown } = {}) {
    super(message);
    this.name = "RegistryConflictError";
    this.reason = typeof options.reason === "string" ? options.reason : null;
    this.current =
      typeof options.current === "object" && options.current !== null
        ? (options.current as RemoteAccount)
        : null;
  }
}

function remotesFilePath(store: AccountStore): string {
  return join(store.paths.codexTeamDir, REMOTES_FILE_NAME);
}

export async function readRemotesFile(store: AccountStore): Promise<RemotesFile> {
  try {
    const raw = await readFile(remotesFilePath(store), "utf8");
    const parsed = JSON.parse(raw) as Partial<RemotesFile>;
    return {
      remotes: parsed.remotes ?? {},
      default_remote: parsed.default_remote ?? null,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { remotes: {}, default_remote: null };
    }
    throw error;
  }
}

async function writeRemotesFile(store: AccountStore, data: RemotesFile): Promise<void> {
  await atomicWriteFile(
    remotesFilePath(store),
    `${JSON.stringify(data, null, 2)}\n`,
    FILE_MODE,
  );
}

export async function addRemote(
  store: AccountStore,
  options: { name: string; url: string; token: string; setDefault?: boolean },
): Promise<void> {
  const data = await readRemotesFile(store);
  data.remotes[options.name] = {
    url: options.url.replace(/\/+$/u, ""),
    token: options.token,
  };
  if (options.setDefault === true || !data.default_remote) {
    data.default_remote = options.name;
  }
  await writeRemotesFile(store, data);
}

export async function removeRemote(store: AccountStore, name: string): Promise<boolean> {
  const data = await readRemotesFile(store);
  if (!data.remotes[name]) {
    return false;
  }
  delete data.remotes[name];
  if (data.default_remote === name) {
    data.default_remote = Object.keys(data.remotes)[0] ?? null;
  }
  await writeRemotesFile(store, data);
  return true;
}

export async function resolveRemote(
  store: AccountStore,
  name?: string | null,
): Promise<{ name: string; config: RemoteConfig }> {
  const data = await readRemotesFile(store);
  const resolvedName = name ?? data.default_remote;
  if (!resolvedName) {
    throw new Error(
      'No registry remote configured. Add one with: codexm remote add <name> <url> --token <token>',
    );
  }
  const config = data.remotes[resolvedName];
  if (!config) {
    const known = Object.keys(data.remotes).join(", ") || "(none)";
    throw new Error(`Unknown registry remote "${resolvedName}". Configured remotes: ${known}`);
  }
  return { name: resolvedName, config };
}

async function request(
  remote: RemoteConfig,
  path: string,
  init: { method?: string; body?: string; headers?: Record<string, string> } = {},
): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(`${remote.url}${path}`, {
      method: init.method ?? "GET",
      headers: {
        authorization: `Bearer ${remote.token}`,
        ...(init.headers ?? {}),
      },
      body: init.body,
    });
  } catch (cause) {
    throw new Error(
      `Cannot reach registry ${remote.url}: ${(cause as Error).message}. Is the server running?`,
    );
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    if (response.status === 409) {
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(detail) as Record<string, unknown>;
      } catch {
        parsed = {};
      }
      if (parsed.error === "stale") {
        throw new RegistryConflictError(
          `Registry ${remote.url} rejected the upload for ${path}: ${
            typeof parsed.reason === "string" ? parsed.reason : "stale"
          }`,
          { reason: parsed.reason, current: parsed.current },
        );
      }
    }
    const suffix = detail.trim() === "" ? "" : `: ${detail.trim().slice(0, 200)}`;
    const error = new Error(
      `Registry ${remote.url} returned ${response.status} for ${path}${suffix}`,
    ) as Error & { status?: number };
    error.status = response.status;
    throw error;
  }
  return response;
}

export async function listRemoteAccounts(remote: RemoteConfig): Promise<RemoteAccount[]> {
  const response = await request(remote, "/v1/accounts");
  const payload = (await response.json()) as { accounts?: RemoteAccount[] };
  return payload.accounts ?? [];
}

export async function downloadBundle(remote: RemoteConfig, name: string): Promise<unknown> {
  const response = await request(remote, `/v1/accounts/${encodeURIComponent(name)}`);
  return await response.json();
}

export async function uploadBundle(
  remote: RemoteConfig,
  name: string,
  bundle: unknown,
  options: { leaseId?: string | null; force?: boolean } = {},
): Promise<UploadReceipt> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (options.leaseId) {
    headers["x-lease-id"] = options.leaseId;
  }
  if (options.force === true) {
    headers["x-registry-force"] = "1";
  }

  const response = await request(remote, `/v1/accounts/${encodeURIComponent(name)}`, {
    method: "PUT",
    body: JSON.stringify(bundle),
    headers,
  });
  const payload = (await response.json()) as Partial<UploadReceipt>;
  return {
    version: typeof payload.version === "number" ? payload.version : null,
    token_expires_at:
      typeof payload.token_expires_at === "string" ? payload.token_expires_at : null,
  };
}

export async function acquireRefreshLease(
  remote: RemoteConfig,
  name: string,
  options: { clientId: string; ttlMs?: number },
): Promise<RefreshLease> {
  let response: Response;
  try {
    response = await request(remote, `/v1/accounts/${encodeURIComponent(name)}/lease`, {
      method: "POST",
      body: JSON.stringify({
        client_id: options.clientId,
        action: "acquire",
        ttl_ms: options.ttlMs ?? REFRESH_LEASE_TTL_MS,
      }),
      headers: { "content-type": "application/json" },
    });
  } catch (error) {
    // A registry deployed before leases existed answers 404/405/501. Guarding
    // refreshes is an optimisation, so fall back to the old unguarded path
    // instead of never refreshing at all.
    const status = (error as { status?: number }).status;
    if (status === 404 || status === 405 || status === 501) {
      return {
        granted: true,
        lease_id: null,
        expires_at: null,
        holder: null,
        unsupported: true,
      };
    }
    throw error;
  }

  const payload = (await response.json()) as {
    granted?: boolean;
    lease_id?: string | null;
    expires_at?: string | null;
    holder?: string | null;
  };
  return {
    granted: payload.granted === true,
    lease_id: payload.lease_id ?? null,
    expires_at: payload.expires_at ?? null,
    holder: payload.holder ?? null,
  };
}

export async function releaseRefreshLease(
  remote: RemoteConfig,
  name: string,
  options: { clientId: string },
): Promise<boolean> {
  const response = await request(remote, `/v1/accounts/${encodeURIComponent(name)}/lease`, {
    method: "POST",
    body: JSON.stringify({ client_id: options.clientId, action: "release" }),
    headers: { "content-type": "application/json" },
  });
  const payload = (await response.json()) as { released?: boolean };
  return payload.released === true;
}

export async function deleteRemoteAccount(remote: RemoteConfig, name: string): Promise<void> {
  await request(remote, `/v1/accounts/${encodeURIComponent(name)}`, { method: "DELETE" });
}

/**
 * The expiry signal the registry indexes: `id_token` first, then
 * `access_token`. This must stay in lockstep with `summarize()` in
 * server-python/server.py — a different token preference would make clients
 * and the server disagree about which copy is fresher.
 */
export function snapshotRegistryExpiry(snapshot: AuthSnapshot): string | null {
  for (const tokenName of ["id_token", "access_token"] as const) {
    const token = snapshot.tokens?.[tokenName];
    if (typeof token !== "string" || token.trim() === "") {
      continue;
    }
    try {
      const exp = decodeJwtPayload(token).exp;
      if (typeof exp === "number" && Number.isFinite(exp) && exp > 0) {
        return new Date(exp * 1_000).toISOString();
      }
    } catch {
      // Try the next token; an unparsable JWT is not fatal here.
    }
  }
  return null;
}

export async function readLocalRegistryExpiry(authPath: string): Promise<string | null> {
  try {
    return snapshotRegistryExpiry(await readAuthSnapshotFile(authPath));
  } catch {
    return null;
  }
}

/** True only when `candidate` is strictly newer; unknown expiry never wins. */
export function isNewerExpiry(candidate: string | null, current: string | null): boolean {
  if (!candidate || !current) {
    return false;
  }
  const candidateMs = Date.parse(candidate);
  const currentMs = Date.parse(current);
  if (!Number.isFinite(candidateMs) || !Number.isFinite(currentMs)) {
    return false;
  }
  return candidateMs > currentMs;
}
