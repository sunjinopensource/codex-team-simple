import type { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import { PassThrough } from "node:stream";

import { describe, expect, test } from "@rstest/core";

import {
  createCodexLoginProvider,
  startCodexBrowserLogin,
  startCodexDeviceLogin,
} from "../src/codex-login.js";
import { createAuthPayload, jsonResponse, textResponse } from "./test-helpers.js";

function captureWritable(): {
  stream: NodeJS.WriteStream;
  read: () => string;
} {
  const stream = new PassThrough();
  let output = "";
  stream.on("data", (chunk) => {
    output += chunk.toString("utf8");
  });

  return {
    stream: stream as unknown as NodeJS.WriteStream,
    read: () => output,
  };
}

/** Reserves a free loopback port so callback tests never collide with port 1455. */
async function reserveLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });

  if (port === 0) {
    throw new Error("Failed to reserve a loopback port for the callback test.");
  }

  return port;
}

describe("Codex login provider", () => {
  test("continues browser login when the browser opener emits an error", async () => {
    const auth = createAuthPayload("acct-browser-provider", "chatgpt", "plus", "user-browser-provider");
    const requests: Array<{ url: string; body: string }> = [];
    const child = new EventEmitter() as EventEmitter & { unref: () => void };
    let spawnedUrl = "";
    let unrefCalled = false;
    child.unref = () => {
      unrefCalled = true;
    };

    const spawnMock: typeof spawn = ((_: string, args?: readonly string[]) => {
      spawnedUrl = args?.at(-1) ?? "";
      setTimeout(() => {
        child.emit("error", new Error("spawn xdg-open ENOENT"));
      }, 0);
      return child as ReturnType<typeof spawn>;
    }) as unknown as typeof spawn;

    const fetchMock: typeof fetch = async (input, init) => {
      const url = String(input);
      const body = String(init?.body ?? "");
      requests.push({ url, body });

      if (url.endsWith("/oauth/token")) {
        expect(body).toContain("grant_type=authorization_code");
        expect(body).toContain("code=browser-authorization-code");
        expect(body).toContain("redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback");
        return jsonResponse({
          id_token: auth.tokens?.id_token,
          access_token: auth.tokens?.access_token,
          refresh_token: auth.tokens?.refresh_token,
        });
      }

      throw new Error(`Unexpected URL: ${url}`);
    };
    const stdout = captureWritable();
    const stderr = captureWritable();

    const snapshot = await createCodexLoginProvider(fetchMock, {
      spawnImpl: spawnMock,
      waitForBrowserCallback: async (state) => {
        await new Promise((resolve) => setTimeout(resolve, 0));
        return {
          result: {
            code: "browser-authorization-code",
            state,
          },
          redirectUri: "http://localhost:1455/auth/callback",
        };
      },
    }).login({
      mode: "browser",
      stdout: stdout.stream,
      stderr: stderr.stream,
    });

    expect(snapshot).toMatchObject({
      auth_mode: "chatgpt",
      tokens: {
        account_id: "acct-browser-provider",
      },
    });
    expect(requests.map((request) => request.url)).toEqual([
      "https://auth.openai.com/oauth/token",
    ]);
    expect(spawnedUrl).toContain("https://auth.openai.com/oauth/authorize?");
    expect(unrefCalled).toBe(true);
    expect(stdout.read()).toBe("");
    expect(stderr.read()).toContain("Failed to open browser automatically: spawn xdg-open ENOENT");
  });

  test("escapes the authorize URL on Windows so cmd keeps the whole query string", async () => {
    const auth = createAuthPayload("acct-browser-windows", "chatgpt", "plus", "user-browser-windows");
    const child = new EventEmitter() as EventEmitter & { unref: () => void };
    child.unref = () => undefined;

    const spawnCalls: Array<{ command: string; args?: readonly string[] }> = [];
    const spawnMock: typeof spawn = ((command: string, args?: readonly string[]) => {
      spawnCalls.push({ command, args });
      return child as ReturnType<typeof spawn>;
    }) as unknown as typeof spawn;

    const fetchMock: typeof fetch = async (input) => {
      if (String(input).endsWith("/oauth/token")) {
        return jsonResponse({
          id_token: auth.tokens?.id_token,
          access_token: auth.tokens?.access_token,
          refresh_token: auth.tokens?.refresh_token,
        });
      }

      throw new Error(`Unexpected URL: ${String(input)}`);
    };

    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    try {
      await createCodexLoginProvider(fetchMock, {
        spawnImpl: spawnMock,
        waitForBrowserCallback: async (state) => ({
          result: { code: "browser-authorization-code", state },
          redirectUri: "http://localhost:1455/auth/callback",
        }),
      }).login({
        mode: "browser",
        stdout: captureWritable().stream,
        stderr: captureWritable().stream,
      });
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform, configurable: true });
    }

    expect(spawnCalls[0]?.command).toBe("cmd");
    const openedUrl = spawnCalls[0]?.args?.at(-1) ?? "";
    expect(openedUrl.startsWith("https://auth.openai.com/oauth/authorize?")).toBe(true);
    expect(openedUrl).toContain("^&client_id=app_EMoamEEZ73f0CkXaXp7hrann");
    const unescapedUrl = openedUrl.replace(/\^(.)/g, "$1");
    expect(unescapedUrl).toContain("&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback");
    expect(unescapedUrl).toContain("&code_challenge_method=S256");
  });

  test("completes device login using Codex device endpoints", async () => {
    const auth = createAuthPayload("acct-device-provider", "chatgpt", "plus", "user-device-provider");
    const requests: Array<{ url: string; body: string }> = [];
    const fetchMock: typeof fetch = async (input, init) => {
      const url = String(input);
      const body = String(init?.body ?? "");
      requests.push({ url, body });

      if (url.endsWith("/api/accounts/deviceauth/usercode")) {
        return jsonResponse({
          device_auth_id: "device-auth-id",
          user_code: "ABCD-EFGH",
          interval: "1",
        });
      }

      if (url.endsWith("/api/accounts/deviceauth/token")) {
        return jsonResponse({
          authorization_code: "authorization-code",
          code_verifier: "code-verifier",
          code_challenge: "code-challenge",
        });
      }

      if (url.endsWith("/oauth/token")) {
        expect(body).toContain("grant_type=authorization_code");
        expect(body).toContain("client_id=app_EMoamEEZ73f0CkXaXp7hrann");
        expect(body).toContain("code=authorization-code");
        expect(body).toContain("redirect_uri=https%3A%2F%2Fauth.openai.com%2Fdeviceauth%2Fcallback");
        expect(body).toContain("code_verifier=code-verifier");
        return jsonResponse({
          id_token: auth.tokens?.id_token,
          access_token: auth.tokens?.access_token,
          refresh_token: auth.tokens?.refresh_token,
        });
      }

      throw new Error(`Unexpected URL: ${url}`);
    };
    const stdout = captureWritable();
    const stderr = captureWritable();

    const snapshot = await createCodexLoginProvider(fetchMock).login({
      mode: "device",
      stdout: stdout.stream,
      stderr: stderr.stream,
    });

    expect(snapshot).toMatchObject({
      auth_mode: "chatgpt",
      tokens: {
        account_id: "acct-device-provider",
      },
    });
    expect(requests.map((request) => request.url)).toEqual([
      "https://auth.openai.com/api/accounts/deviceauth/usercode",
      "https://auth.openai.com/api/accounts/deviceauth/token",
      "https://auth.openai.com/oauth/token",
    ]);
    expect(stdout.read()).toBe("");
    expect(stderr.read()).toContain("ABCD-EFGH");
  });

  test("starts a device session before the operator approves it", async () => {
    const auth = createAuthPayload("acct-device-session", "chatgpt", "plus", "user-device-session");
    let tokenAttempts = 0;

    const fetchMock: typeof fetch = async (input) => {
      const url = String(input);

      if (url.endsWith("/api/accounts/deviceauth/usercode")) {
        return jsonResponse({
          device_auth_id: "device-auth-id",
          user_code: "WXYZ-1234",
          interval: "1",
        });
      }

      if (url.endsWith("/api/accounts/deviceauth/token")) {
        tokenAttempts += 1;
        if (tokenAttempts < 2) {
          return textResponse("authorization_pending", 403);
        }
        return jsonResponse({
          authorization_code: "authorization-code",
          code_verifier: "code-verifier",
        });
      }

      if (url.endsWith("/oauth/token")) {
        return jsonResponse({
          id_token: auth.tokens?.id_token,
          access_token: auth.tokens?.access_token,
          refresh_token: auth.tokens?.refresh_token,
        });
      }

      throw new Error(`Unexpected URL: ${url}`);
    };

    const session = await startCodexDeviceLogin(fetchMock);
    expect(session.userCode).toBe("WXYZ-1234");
    expect(session.verificationUrl).toBe("https://auth.openai.com/codex/device");
    expect(tokenAttempts).toBe(0);

    const snapshot = await session.wait();
    expect(snapshot).toMatchObject({
      auth_mode: "chatgpt",
      tokens: {
        account_id: "acct-device-session",
      },
    });
    expect(tokenAttempts).toBe(2);
  });

  test("cancels a pending device session instead of polling on", async () => {
    const fetchMock: typeof fetch = async (input) => {
      const url = String(input);

      if (url.endsWith("/api/accounts/deviceauth/usercode")) {
        return jsonResponse({
          device_auth_id: "device-auth-id",
          user_code: "CANCEL-01",
          interval: "1",
        });
      }

      if (url.endsWith("/api/accounts/deviceauth/token")) {
        return textResponse("authorization_pending", 403);
      }

      throw new Error(`Unexpected URL: ${url}`);
    };

    const session = await startCodexDeviceLogin(fetchMock);
    const waiting = session.wait();
    setTimeout(() => session.cancel("stopped by test"), 10);

    await expect(waiting).rejects.toThrow("stopped by test");
  });

  test("completes a browser login when the operator returns to the callback port", async () => {
    const auth = createAuthPayload("acct-browser-session", "chatgpt", "plus", "user-browser-session");
    const fetchMock: typeof fetch = async (input) => {
      const url = String(input);

      if (url.endsWith("/oauth/token")) {
        return jsonResponse({
          id_token: auth.tokens?.id_token,
          access_token: auth.tokens?.access_token,
          refresh_token: auth.tokens?.refresh_token,
        });
      }

      throw new Error(`Unexpected URL: ${url}`);
    };

    const port = await reserveLoopbackPort();
    const session = await startCodexBrowserLogin(fetchMock, { port });
    expect(session.redirectUri).toBe(`http://localhost:${port}/auth/callback`);

    const state = new URL(session.authorizeUrl).searchParams.get("state") ?? "";
    const callback = await fetch(
      `http://127.0.0.1:${port}/auth/callback?code=browser-code&state=${encodeURIComponent(state)}`,
    );
    expect(callback.status).toBe(200);

    const snapshot = await session.wait();
    expect(snapshot).toMatchObject({
      auth_mode: "chatgpt",
      tokens: {
        account_id: "acct-browser-session",
      },
    });
  });

  test("releases the callback port when a browser login is cancelled", async () => {
    const fetchMock: typeof fetch = async () => jsonResponse({});
    const port = await reserveLoopbackPort();

    const session = await startCodexBrowserLogin(fetchMock, { port });
    const waiting = session.wait();
    session.cancel("stopped by test");

    await expect(waiting).rejects.toThrow("stopped by test");

    const restarted = await startCodexBrowserLogin(fetchMock, { port });
    restarted.cancel("cleanup");
    await expect(restarted.wait()).rejects.toThrow("cleanup");
  });

  test("gives up on a browser login nobody completes, and frees the port", async () => {
    const fetchMock: typeof fetch = async () => jsonResponse({});
    const port = await reserveLoopbackPort();

    // A closed authorize tab never calls back; without a deadline the console
    // keeps the loopback listener bound and the next login cannot bind it.
    const session = await startCodexBrowserLogin(fetchMock, { port, timeoutMs: 20 });

    await expect(session.wait()).rejects.toThrow("timed out");

    const restarted = await startCodexBrowserLogin(fetchMock, { port, timeoutMs: 20 });
    restarted.cancel("cleanup");
    await expect(restarted.wait()).rejects.toThrow("cleanup");
  });
});
