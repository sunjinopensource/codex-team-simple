import { existsSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "@rstest/core";

import { createAccountStore } from "../src/account-store/index.js";
import type { AuthSnapshot } from "../src/auth-snapshot.js";
import { createAccountAddFlows, performUiAddAccount, performUiRemoveAccount } from "../src/commands/ui.js";
import type { CodexLoginProvider } from "../src/codex-login.js";
import { addRemote } from "../src/registry/client.js";
import {
  cleanupTempHome,
  createAuthPayload,
  createTempHome,
  installFetchMock,
  jsonResponse,
} from "./test-helpers.js";

/**
 * The console's add/remove is a registry operation too: a deleted account must
 * stop being served to other machines, and a new one must go up without waiting
 * for the next auto-sync pass.
 */

const REMOTE_URL = "http://registry.test";
const REMOTE_TOKEN = "remote-token";

type RegistryCall = { kind: "list" | "put" | "get" | "delete"; name?: string };

function encodeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" }), "utf8").toString(
    "base64url",
  );
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${header}.${body}.sig`;
}

interface FakeRegistry {
  calls: RegistryCall[];
  seed(name: string): void;
  has(name: string): boolean;
  onDelete(callback: (name: string) => void): void;
  restore(): void;
}

function createFakeRegistry(): FakeRegistry {
  const stored = new Map<string, unknown>();
  const calls: RegistryCall[] = [];
  let deleteObserver: ((name: string) => void) | null = null;

  const restore = installFetchMock((async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const rawUrl =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;

    if (rawUrl.includes("/oauth/token")) {
      const exp = Math.floor(Date.now() / 1_000) + 30 * 24 * 3_600;
      return jsonResponse({
        access_token: encodeJwt({ exp: exp + 86_400 }),
        id_token: encodeJwt({ exp, email: "acct-fresh@example.com" }),
        refresh_token: "refresh-rotated",
      });
    }

    if (!rawUrl.startsWith(REMOTE_URL)) {
      return jsonResponse({ error: "unexpected host" }, 500);
    }

    const pathname = new URL(rawUrl).pathname;
    const method = (init?.method ?? "GET").toUpperCase();

    if (method === "GET" && pathname === "/v1/accounts") {
      calls.push({ kind: "list" });
      return jsonResponse({
        accounts: [...stored.keys()].map((name) => ({
          name,
          kind: "chatgpt",
          plan_type: "plus",
          account_id: name,
          token_expires_at: null,
          updated_at: "2026-03-18T00:00:00Z",
          last_downloaded_at: null,
          size: 100,
          version: 1,
        })),
      });
    }

    const name = decodeURIComponent(pathname.replace("/v1/accounts/", ""));

    if (method === "PUT") {
      calls.push({ kind: "put", name });
      stored.set(name, JSON.parse(String(init?.body ?? "{}")));
      return jsonResponse({ ok: true, name });
    }

    if (method === "DELETE") {
      calls.push({ kind: "delete", name });
      deleteObserver?.(name);
      stored.delete(name);
      return jsonResponse({ ok: true, deleted: true });
    }

    if (method === "GET") {
      calls.push({ kind: "get", name });
      const bundle = stored.get(name);
      return bundle ? jsonResponse(bundle) : jsonResponse({ error: "not found" }, 404);
    }

    return jsonResponse({ error: "not found" }, 404);
  }) as typeof fetch);

  return {
    calls,
    seed(bundleName: string) {
      stored.set(bundleName, {
        kind: "auth_bundle",
        version: 1,
        exported_at: "2026-03-18T00:00:00Z",
        auth: { kind: "chatgpt", auth_json: createAuthPayload(bundleName) },
      });
    },
    has(bundleName: string) {
      return stored.has(bundleName);
    },
    onDelete(callback: (name: string) => void) {
      deleteObserver = callback;
    },
    restore,
  };
}

function accountDir(homeDir: string, name: string): string {
  return join(homeDir, ".codex-team", "accounts", name);
}

/** Stands in for the browser callback login; approves with the given snapshot. */
function createFakeBrowserLogin(snapshot: AuthSnapshot): CodexLoginProvider {
  return {
    startBrowserLogin: async () => ({
      authorizeUrl: "https://auth.openai.com/oauth/authorize",
      redirectUri: "http://localhost:1455/auth/callback",
      wait: async () => snapshot,
      cancel: () => {},
    }),
  } as CodexLoginProvider;
}

describe("console keeps the registry in step", () => {
  test("removing an account deletes it from the registry first, then syncs", async () => {
    const homeDir = await createTempHome();
    const registry = createFakeRegistry();

    try {
      const store = createAccountStore(homeDir);
      await addRemote(store, { name: "test", url: REMOTE_URL, token: REMOTE_TOKEN, setDefault: true });
      await store.addAccountSnapshot("work", createAuthPayload("acct-work"));
      registry.seed("work");

      // Proves the ordering: the registry record goes away while the local copy
      // is still on disk, so a failed local delete cannot leave an orphan.
      let localStillPresentAtDelete: boolean | null = null;
      registry.onDelete(() => {
        localStillPresentAtDelete = existsSync(accountDir(homeDir, "work"));
      });

      const result = await performUiRemoveAccount({ store, name: "work" });

      expect(localStillPresentAtDelete).toBe(true);
      expect(registry.has("work")).toBe(false);
      expect(existsSync(accountDir(homeDir, "work"))).toBe(false);
      expect(result.message).toContain("registry");

      const kinds = registry.calls.map((call) => call.kind);
      const deleteAt = kinds.indexOf("delete");
      expect(deleteAt).toBeGreaterThanOrEqual(0);
      // A sync pass runs after the delete — and because the account is already
      // gone locally, it cannot push the record straight back.
      expect(kinds.indexOf("list", deleteAt)).toBeGreaterThan(deleteAt);
    } finally {
      registry.restore();
      await cleanupTempHome(homeDir);
    }
  });

  test("adding an account pushes it to the registry right away", async () => {
    const homeDir = await createTempHome();
    const registry = createFakeRegistry();

    try {
      const store = createAccountStore(homeDir);
      await addRemote(store, { name: "test", url: REMOTE_URL, token: REMOTE_TOKEN, setDefault: true });
      const flows = createAccountAddFlows();

      const result = await performUiAddAccount({
        store,
        flows,
        authLogin: createFakeBrowserLogin(createAuthPayload("acct-fresh")),
        name: "fresh",
        method: "browser",
      });
      expect(result.status).toBe("pending");
      await flows.settled();

      expect(existsSync(accountDir(homeDir, "fresh"))).toBe(true);
      expect(registry.has("fresh")).toBe(true);
      expect(
        registry.calls.some((call) => call.kind === "put" && call.name === "fresh"),
      ).toBe(true);
    } finally {
      registry.restore();
      await cleanupTempHome(homeDir);
    }
  });
});
