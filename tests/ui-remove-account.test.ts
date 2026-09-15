import { describe, expect, test } from "@rstest/core";

import { createAccountStore } from "../src/account-store/index.js";
import { performUiRemoveAccount } from "../src/commands/ui.js";
import { cleanupTempHome, createTempHome, writeCurrentAuth } from "./test-helpers.js";

async function seedAccounts(homeDir: string) {
  const store = createAccountStore(homeDir);
  await writeCurrentAuth(homeDir, "acct-alpha");
  await store.saveCurrentAccount("alpha");
  await writeCurrentAuth(homeDir, "acct-beta");
  await store.saveCurrentAccount("beta");
  return store;
}

describe("console remove account", () => {
  test("deletes the account directory and leaves the others alone", async () => {
    const homeDir = await createTempHome();

    try {
      const store = await seedAccounts(homeDir);
      await store.switchAccount("alpha");

      const result = await performUiRemoveAccount({ store, name: "beta" });

      expect(result.message).toContain("已删除账号");
      expect(result.warnings).toEqual([]);

      const { accounts } = await store.listAccounts();
      expect(accounts.map((account) => account.name)).toEqual(["alpha"]);
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("warns when the removed account is the one codex is currently using", async () => {
    const homeDir = await createTempHome();

    try {
      const store = await seedAccounts(homeDir);
      await store.switchAccount("beta");

      const result = await performUiRemoveAccount({ store, name: "beta" });

      expect(result.warnings).toHaveLength(1);
      expect(result.warnings[0]).toContain("当前 codex 使用的登录态来源");

      // The current auth file is a copy, so codex keeps working.
      const status = await store.getCurrentStatus();
      expect(status.exists).toBe(true);
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("rejects a blank name and reports a missing account", async () => {
    const homeDir = await createTempHome();

    try {
      const store = await seedAccounts(homeDir);

      await expect(performUiRemoveAccount({ store, name: "  " })).rejects.toThrow("缺少账号名称");
      await expect(performUiRemoveAccount({ store, name: "ghost" })).rejects.toThrow("删除账号");
    } finally {
      await cleanupTempHome(homeDir);
    }
  });
});
