import { describe, expect, test } from "@rstest/core";

import { findAuthReloginError } from "../src/auth-refresh.js";
import type { ManagedAccount } from "../src/account-store/index.js";

function accountWith(overrides: Partial<ManagedAccount> = {}): ManagedAccount {
  return {
    name: "jsunhj",
    auth_mode: "chatgpt",
    account_id: "acct-1",
    quota: { status: "available", plan_type: "plus" },
    last_auth_refresh_error: null,
    ...overrides,
  } as unknown as ManagedAccount;
}

describe("relogin detection", () => {
  test("flags a rejected token refresh from the quota path", () => {
    const account = accountWith({
      quota: {
        status: "error",
        error_message:
          'Token refresh failed: 401 {"error":{"message":"Your session has ended. Please log in again."}}',
      },
    });

    expect(findAuthReloginError(account)).toContain("session has ended");
  });

  test("flags a failed auth refresh sweep", () => {
    const account = accountWith({ last_auth_refresh_error: "token_expired" });

    expect(findAuthReloginError(account)).toBe("token_expired");
  });

  test("ignores errors that a retry could fix", () => {
    const account = accountWith({
      quota: { status: "error", error_message: "Failed to refresh quota: ETIMEDOUT" },
    });

    expect(findAuthReloginError(account)).toBeNull();
  });

  test("ignores healthy accounts", () => {
    expect(findAuthReloginError(accountWith())).toBeNull();
  });
});
