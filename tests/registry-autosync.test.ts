import { writeFile } from "node:fs/promises";

import { describe, expect, test } from "@rstest/core";

import { createAccountStore } from "../src/account-store/index.js";
import {
  createSnapshotMeta,
  readAuthSnapshotFile,
  type AuthSnapshot,
} from "../src/auth-snapshot.js";
import { runAutoSyncOnce } from "../src/commands/autosync.js";
import { addRemote } from "../src/registry/client.js";
import type { ShareBundle } from "../src/share-bundle.js";
import {
  cleanupTempHome,
  createTempHome,
  installFetchMock,
  jsonResponse,
} from "./test-helpers.js";

/**
 * The registry side is faked in-process, mirroring the semantics verified
 * against the real Flask server in server-python/test_server.py: id_token
 * expiry decides freshness, uploads rewind nothing, and only the live lease
 * holder may upload a refresh.
 */

const REMOTE_URL = "http://registry.test";
const REMOTE_TOKEN = "remote-token";
const ISSUER = "https://auth.openai.com";

function jwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" }), "utf8").toString(
    "base64url",
  );
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${header}.${body}.sig`;
}

function authClaim(accountId: string): Record<string, unknown> {
  return {
    chatgpt_account_id: accountId,
    chatgpt_plan_type: "plus",
  };
}

function accountAuth(accountId: string, idTokenExpSeconds: number): AuthSnapshot {
  return {
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: {
      account_id: accountId,
      access_token: jwt({
        iss: ISSUER,
        exp: idTokenExpSeconds + 86_400,
        "https://api.openai.com/auth": authClaim(accountId),
      }),
      refresh_token: `refresh-${accountId}`,
      id_token: jwt({
        iss: ISSUER,
        exp: idTokenExpSeconds,
        email: `${accountId}@example.com`,
        "https://api.openai.com/auth": authClaim(accountId),
      }),
    },
    last_refresh: "2026-03-18T00:00:00.000Z",
  };
}

function accountBundle(accountId: string, idTokenExpSeconds: number): ShareBundle {
  return {
    kind: "auth_bundle",
    version: 1,
    exported_at: "2026-03-18T00:00:00.000Z",
    auth: {
      kind: "chatgpt",
      auth_json: accountAuth(accountId, idTokenExpSeconds),
      profile: { account_id: accountId, plan: "plus" },
    },
  };
}

/** Same rule as the server's `summarize()`: id_token first, then access_token. */
function bundleExpiry(bundle: ShareBundle): string | null {
  const tokens = bundle.auth.auth_json.tokens ?? {};
  for (const tokenName of ["id_token", "access_token"] as const) {
    const token = tokens[tokenName];
    if (typeof token !== "string") {
      continue;
    }
    const payload = JSON.parse(
      Buffer.from(token.split(".")[1]!, "base64url").toString("utf8"),
    ) as { exp?: unknown };
    if (typeof payload.exp === "number") {
      return new Date(payload.exp * 1_000).toISOString();
    }
  }
  return null;
}

interface StoredBundle {
  bundle: ShareBundle;
  expiresAt: string | null;
  version: number;
}

interface FakeRegistryState {
  bundles: Map<string, StoredBundle>;
  leases: Map<string, { clientId: string; leaseId: string; expiresAtEpoch: number }>;
  uploads: Array<{ name: string; leaseId: string | null }>;
  refreshCount: number;
  failUploadsFor: Set<string>;
  conflictFor: Set<string>;
  leasesUnsupported: boolean;
}

function createRegistryState(): FakeRegistryState {
  return {
    bundles: new Map(),
    leases: new Map(),
    uploads: [],
    refreshCount: 0,
    failUploadsFor: new Set(),
    conflictFor: new Set(),
    leasesUnsupported: false,
  };
}

function seedRemote(state: FakeRegistryState, name: string, bundle: ShareBundle): void {
  state.bundles.set(name, {
    bundle,
    expiresAt: bundleExpiry(bundle),
    version: 1,
  });
}

function handleRegistry(state: FakeRegistryState, url: string, init?: RequestInit): Response {
  const headers = (init?.headers ?? {}) as Record<string, string>;
  if (headers.authorization !== `Bearer ${REMOTE_TOKEN}`) {
    return jsonResponse({ error: "invalid token" }, 403);
  }

  const { pathname } = new URL(url);
  const method = (init?.method ?? "GET").toUpperCase();
  const match = /^\/v1\/accounts\/([^/]+)(\/lease)?$/u.exec(pathname);

  if (method === "GET" && pathname === "/v1/accounts") {
    return jsonResponse({
      accounts: [...state.bundles.entries()].map(([name, stored]) => ({
        name,
        kind: "chatgpt",
        plan_type: "plus",
        account_id: name,
        token_expires_at: stored.expiresAt,
        updated_at: "2026-03-18T00:00:00Z",
        last_downloaded_at: null,
        size: 100,
        version: stored.version,
      })),
    });
  }

  if (!match) {
    return jsonResponse({ error: "not found" }, 404);
  }

  const name = decodeURIComponent(match[1]!);
  const isLeaseRoute = match[2] === "/lease";

  // Mimics a registry deployed before leases existed.
  if (isLeaseRoute && state.leasesUnsupported) {
    return jsonResponse({ error: "not found" }, 404);
  }

  if (isLeaseRoute && method === "POST") {
    const body = JSON.parse(String(init?.body ?? "{}")) as {
      client_id?: string;
      action?: string;
      ttl_ms?: number;
    };
    const lease = state.leases.get(name);
    const live = lease && lease.expiresAtEpoch > Date.now() ? lease : undefined;
    if (!live) {
      state.leases.delete(name);
    }

    if (body.action === "release") {
      if (live && live.clientId === body.client_id) {
        state.leases.delete(name);
        return jsonResponse({ ok: true, released: true });
      }
      return jsonResponse({ ok: true, released: false });
    }

    if (!live || live.clientId === body.client_id) {
      const leaseId = live?.leaseId ?? `lease-${state.leases.size}-${Date.now()}`;
      const expiresAtEpoch = Date.now() + (body.ttl_ms ?? 120_000);
      state.leases.set(name, {
        clientId: body.client_id ?? "",
        leaseId,
        expiresAtEpoch,
      });
      return jsonResponse({
        ok: true,
        granted: true,
        lease_id: leaseId,
        expires_at: new Date(expiresAtEpoch).toISOString(),
      });
    }

    return jsonResponse({
      ok: true,
      granted: false,
      holder: live.clientId,
      expires_at: new Date(live.expiresAtEpoch).toISOString(),
    });
  }

  if (isLeaseRoute) {
    return jsonResponse({ error: "method not allowed" }, 405);
  }

  if (method === "GET") {
    const stored = state.bundles.get(name);
    if (!stored) {
      return jsonResponse({ error: "not found" }, 404);
    }
    return jsonResponse(stored.bundle);
  }

  if (method === "PUT") {
    const bundle = JSON.parse(String(init?.body ?? "{}")) as ShareBundle;
    const incomingExp = bundleExpiry(bundle);
    const current = state.bundles.get(name);
    const leaseId = headers["x-lease-id"] ?? null;
    const forced = headers["x-registry-force"] === "1";

    if (state.conflictFor.has(name)) {
      return jsonResponse(
        { error: "stale", reason: "registry holds a newer token", current: current ?? null },
        409,
      );
    }
    if (state.failUploadsFor.has(name)) {
      return jsonResponse({ error: "boom" }, 500);
    }

    const liveLease = state.leases.get(name);
    const leaseOk =
      leaseId !== null &&
      liveLease !== undefined &&
      liveLease.leaseId === leaseId &&
      liveLease.expiresAtEpoch > Date.now();

    if (leaseId !== null && !leaseOk) {
      return jsonResponse({ error: "stale", reason: "lease_invalid" }, 409);
    }

    const incomingMs = incomingExp ? Date.parse(incomingExp) : Number.NaN;
    const currentMs = current?.expiresAt ? Date.parse(current.expiresAt) : Number.NaN;
    if (
      current &&
      !forced &&
      !leaseOk &&
      Number.isFinite(incomingMs) &&
      Number.isFinite(currentMs) &&
      incomingMs < currentMs
    ) {
      return jsonResponse(
        { error: "stale", reason: "registry holds a newer token", current },
        409,
      );
    }

    const version = (current?.version ?? 0) + 1;
    state.bundles.set(name, { bundle, expiresAt: incomingExp, version });
    state.uploads.push({ name, leaseId });
    if (leaseOk) {
      state.leases.delete(name);
    }
    return jsonResponse({ ok: true, name, version, token_expires_at: incomingExp });
  }

  return jsonResponse({ error: "method not allowed" }, 405);
}

function handleTokenRefresh(state: FakeRegistryState): Response {
  state.refreshCount += 1;
  const exp = Math.floor(Date.now() / 1_000) + 30 * 24 * 3_600;
  const claim = { "https://api.openai.com/auth": authClaim("acct-1") };
  return jsonResponse({
    access_token: jwt({ iss: ISSUER, exp: exp + 86_400, ...claim }),
    id_token: jwt({ iss: ISSUER, exp, email: "acct-1@example.com", ...claim }),
    refresh_token: `refresh-rotated-${state.refreshCount}`,
  });
}

async function setup(options: { idTokenExpSeconds: number }) {
  const homeDir = await createTempHome();
  const store = createAccountStore(homeDir);
  await addRemote(store, { name: "test", url: REMOTE_URL, token: REMOTE_TOKEN });
  await store.addAccountSnapshot("one", accountAuth("acct-1", options.idTokenExpSeconds), {
    force: true,
  });

  return { homeDir, store };
}

async function installRegistryMock(state: FakeRegistryState): Promise<() => void> {
  return installFetchMock((async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.startsWith(REMOTE_URL)) {
      return handleRegistry(state, url, init);
    }
    if (url.includes("/oauth/token")) {
      return handleTokenRefresh(state);
    }
    return jsonResponse({ error: `unexpected request: ${url}` }, 500);
  }) as typeof fetch);
}

describe("registry auto-sync", () => {
  test("adopts a newer registry token and re-applies the active account", async () => {
    const nowSeconds = Math.floor(Date.now() / 1_000);
    const { homeDir, store } = await setup({ idTokenExpSeconds: nowSeconds + 3_600 });
    const state = createRegistryState();
    const remoteBundle = accountBundle("acct-1", nowSeconds + 20 * 24 * 3_600);
    remoteBundle.auth.auth_json.tokens!.refresh_token = "refresh-from-remote";
    seedRemote(state, "one", remoteBundle);
    const restore = await installRegistryMock(state);

    try {
      const result = await runAutoSyncOnce({ store, clientId: "machine-a", now: new Date() });
      const entry = result.accounts.find((item) => item.name === "one");

      expect(entry?.action).toBe("pulled");
      expect(state.refreshCount).toBe(0);

      const adopted = await store.getManagedAccount("one");
      const snapshot = await readAuthSnapshotFile(adopted.authPath);
      expect(snapshot.tokens?.refresh_token).toBe("refresh-from-remote");
      expect(state.uploads).toHaveLength(0);
    } finally {
      restore();
      await cleanupTempHome(homeDir);
    }
  });

  test("refreshes under a lease and releases it after uploading", async () => {
    const nowSeconds = Math.floor(Date.now() / 1_000);
    const { homeDir, store } = await setup({ idTokenExpSeconds: nowSeconds + 3_600 });
    const state = createRegistryState();
    seedRemote(state, "one", accountBundle("acct-1", nowSeconds + 3_600));
    const restore = await installRegistryMock(state);

    try {
      const result = await runAutoSyncOnce({ store, clientId: "machine-a", now: new Date() });
      const entry = result.accounts.find((item) => item.name === "one");

      expect(entry?.action).toBe("refreshed");
      expect(state.refreshCount).toBe(1);
      // The upload must carry the lease it just acquired.
      expect(state.uploads[0]?.leaseId).toBeTruthy();
      // ...and the lease is gone once the refreshed bundle is stored.
      expect(state.leases.size).toBe(0);

      const stored = state.bundles.get("one");
      expect(stored?.version).toBe(2);
    } finally {
      restore();
      await cleanupTempHome(homeDir);
    }
  });

  test("skips the refresh when another machine holds the lease", async () => {
    const nowSeconds = Math.floor(Date.now() / 1_000);
    const { homeDir, store } = await setup({ idTokenExpSeconds: nowSeconds + 3_600 });
    const state = createRegistryState();
    seedRemote(state, "one", accountBundle("acct-1", nowSeconds + 3_600));
    state.leases.set("one", {
      clientId: "machine-b",
      leaseId: "lease-b",
      expiresAtEpoch: Date.now() + 60_000,
    });
    const restore = await installRegistryMock(state);

    try {
      const result = await runAutoSyncOnce({ store, clientId: "machine-a", now: new Date() });
      const entry = result.accounts.find((item) => item.name === "one");

      expect(entry?.action).toBe("skipped");
      expect(entry?.reason).toContain("machine-b");
      // Losing the race must not burn the refresh token.
      expect(state.refreshCount).toBe(0);
      expect(state.uploads).toHaveLength(0);
    } finally {
      restore();
      await cleanupTempHome(homeDir);
    }
  });

  test("pushes local-only changes when nothing is due", async () => {
    const now = new Date();
    const nowSeconds = Math.floor(now.getTime() / 1_000);
    const { homeDir, store } = await setup({ idTokenExpSeconds: nowSeconds + 10 * 24 * 3_600 });
    const state = createRegistryState();
    seedRemote(state, "one", accountBundle("acct-1", nowSeconds + 2 * 24 * 3_600));

    const [account] = (await store.listAccounts()).accounts;
    const meta = createSnapshotMeta(account!.name, accountAuth("acct-1", nowSeconds), now);
    meta.last_auth_refresh_at = now.toISOString();
    meta.last_auth_refresh_status = "ok";
    await writeFile(account!.metaPath, `${JSON.stringify(meta, null, 2)}\n`, "utf8");

    const restore = await installRegistryMock(state);
    try {
      const result = await runAutoSyncOnce({ store, clientId: "machine-a", now });
      const entry = result.accounts.find((item) => item.name === "one");

      expect(entry?.action).toBe("pushed");
      expect(state.refreshCount).toBe(0);
      expect(state.uploads).toHaveLength(1);
    } finally {
      restore();
      await cleanupTempHome(homeDir);
    }
  });

  test("treats a 409 as skipped instead of a failure", async () => {
    const now = new Date();
    const nowSeconds = Math.floor(now.getTime() / 1_000);
    const { homeDir, store } = await setup({ idTokenExpSeconds: nowSeconds + 10 * 24 * 3_600 });
    const state = createRegistryState();
    seedRemote(state, "one", accountBundle("acct-1", nowSeconds + 2 * 24 * 3_600));
    state.conflictFor.add("one");

    const [account] = (await store.listAccounts()).accounts;
    const meta = createSnapshotMeta(account!.name, accountAuth("acct-1", nowSeconds), now);
    meta.last_auth_refresh_at = now.toISOString();
    meta.last_auth_refresh_status = "ok";
    await writeFile(account!.metaPath, `${JSON.stringify(meta, null, 2)}\n`, "utf8");

    const restore = await installRegistryMock(state);
    try {
      const result = await runAutoSyncOnce({ store, clientId: "machine-a", now });
      const entry = result.accounts.find((item) => item.name === "one");

      expect(entry?.action).toBe("skipped");
      expect(entry?.reason).toContain("newer");
      expect(entry?.error).toBeUndefined();
    } finally {
      restore();
      await cleanupTempHome(homeDir);
    }
  });

  test("still refreshes against a registry that has no lease route", async () => {
    const nowSeconds = Math.floor(Date.now() / 1_000);
    const { homeDir, store } = await setup({ idTokenExpSeconds: nowSeconds + 3_600 });
    const state = createRegistryState();
    state.leasesUnsupported = true;
    seedRemote(state, "one", accountBundle("acct-1", nowSeconds + 3_600));
    const restore = await installRegistryMock(state);

    try {
      const result = await runAutoSyncOnce({ store, clientId: "machine-a", now: new Date() });
      const entry = result.accounts.find((item) => item.name === "one");

      // Guarding refreshes is an optimisation, never a precondition.
      expect(entry?.action).toBe("refreshed");
      expect(state.refreshCount).toBe(1);
      expect(state.uploads[0]?.leaseId).toBeNull();
    } finally {
      restore();
      await cleanupTempHome(homeDir);
    }
  });

  test("keeps the refreshed token locally when the upload fails", async () => {
    const nowSeconds = Math.floor(Date.now() / 1_000);
    const { homeDir, store } = await setup({ idTokenExpSeconds: nowSeconds + 3_600 });
    const state = createRegistryState();
    seedRemote(state, "one", accountBundle("acct-1", nowSeconds + 3_600));
    state.failUploadsFor.add("one");
    const restore = await installRegistryMock(state);

    try {
      const result = await runAutoSyncOnce({ store, clientId: "machine-a", now: new Date() });
      const entry = result.accounts.find((item) => item.name === "one");

      expect(entry?.action).toBe("failed");
      // The refresh already landed on disk, so the next pass can push it:
      // losing the upload must not lose the rotated token.
      const [account] = (await store.listAccounts()).accounts;
      const snapshot = await readAuthSnapshotFile(account!.authPath);
      expect(snapshot.tokens?.refresh_token).toBe("refresh-rotated-1");
    } finally {
      restore();
      await cleanupTempHome(homeDir);
    }
  });
});
