import { readFile } from "node:fs/promises";

import { describe, expect, test } from "@rstest/core";

import { createAccountStore } from "../src/account-store/index.js";
import {
  cleanupTempHome,
  createApiKeyPayload,
  createAuthPayload,
  createTempHome,
} from "./test-helpers.js";

/**
 * An apikey account is unusable without a config.toml snapshot: switch, doctor
 * and export all read it. Console-added apikey accounts have no config of their
 * own, so the store keeps an empty placeholder instead of nothing — and a
 * re-login must not throw away the base_url an account was configured with.
 */

const RAW_CONFIG = 'model_provider = "openai"\n';

describe("apikey accounts keep a config.toml snapshot", () => {
  test("saving without a config leaves an empty placeholder", async () => {
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir);
      const account = await store.addAccountSnapshot("keyed", createApiKeyPayload("sk-test"));

      expect(account.configPath).not.toBeNull();
      expect(await readFile(account.configPath as string, "utf8")).toBe("");

      const report = await store.doctor();
      expect(report.issues.join("\n")).not.toContain("missing config.toml");
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("re-saving an apikey account keeps the config it was saved with", async () => {
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir);
      await store.addAccountSnapshot("keyed", createApiKeyPayload("sk-old"), {
        rawConfig: RAW_CONFIG,
      });

      const reSaved = await store.addAccountSnapshot("keyed", createApiKeyPayload("sk-new"), {
        force: true,
      });

      expect(await readFile(reSaved.configPath as string, "utf8")).toBe(RAW_CONFIG);
    } finally {
      await cleanupTempHome(homeDir);
    }
  });

  test("chatgpt accounts still get no config.toml", async () => {
    const homeDir = await createTempHome();

    try {
      const store = createAccountStore(homeDir);
      const account = await store.addAccountSnapshot("work", createAuthPayload("acct-work"));

      expect(account.configPath).toBeNull();
    } finally {
      await cleanupTempHome(homeDir);
    }
  });
});
