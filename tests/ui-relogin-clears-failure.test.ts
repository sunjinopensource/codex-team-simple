import { readFile, writeFile } from "node:fs/promises";

import { describe, expect, test } from "@rstest/core";

import { createAccountStore } from "../src/account-store/index.js";
import { findAuthReloginError } from "../src/auth-refresh.js";
import { createAccountAddFlows, performUiAddAccount } from "../src/commands/ui.js";
import { cleanupTempHome, createAuthPayload, createTempHome } from "./test-helpers.js";

/** Marks an account the way a failed auth refresh / quota refresh would. */
async function markAccountAsDead(store: ReturnType<typeof createAccountStore>) {
  const { accounts } = await store.listAccounts();
  const account = accounts[0];
  const meta = JSON.parse(await readFile(account.metaPath, "utf8"));

  meta.last_auth_refresh_at = new Date().toISOString();
  meta.last_auth_refresh_status = "error";
  meta.last_auth_refresh_error = "token refresh failed: 401 unauthorized";
  meta.auth_refresh_fail_count = 3;
  meta.quota = {
    status: "error",
    plan_type: "plus",
    fetched_at: new Date().toISOString(),
    error_message: "token_expired: your session has ended",
    five_hour: { used_percent: 42, window_seconds: 18000 },
  };

  await writeFile(account.metaPath, JSON.stringify(meta));
}

describe("re-login clears the dead-login flag", () => {
  test("a fresh snapshot stops the account from asking for another login", async () => {
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir);
      await store.addAccountSnapshot("work", createAuthPayload("acct-work"));
      await markAccountAsDead(store);

      const before = (await store.listAccounts()).accounts[0];
      expect(findAuthReloginError(before)).toBeTruthy();

      const flows = createAccountAddFlows();
      const result = await performUiAddAccount({
        store,
        flows,
        name: "work",
        method: "apikey",
        apiKey: "sk-fresh",
        force: true,
      });
      expect(result.status).toBe("added");

      const after = (await store.listAccounts()).accounts[0];
      expect(findAuthReloginError(after)).toBeNull();
      expect(after.last_auth_refresh_error).toBeNull();
      expect(after.auth_refresh_fail_count).toBe(0);

      // The usage windows survive — they still describe the same account.
      expect(after.quota.error_message).toBeUndefined();
      expect(after.quota.status).toBe("stale");
      expect(after.quota.five_hour).toEqual({ used_percent: 42, window_seconds: 18000 });
    } finally {
      await cleanupTempHome(homeDir);
    }
  });
});
