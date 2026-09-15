import { randomBytes, createHash } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { spawn } from "node:child_process";

import type { AuthSnapshot } from "./auth-snapshot.js";

const CODEX_AUTH_BASE_URL = "https://auth.openai.com";
const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CODEX_ORIGINATOR = "codex_cli_rs";
const CODEX_LOGIN_PORT = 1455;
const DEVICE_LOGIN_TIMEOUT_MS = 15 * 60 * 1000;
const BROWSER_LOGIN_TIMEOUT_MS = 15 * 60 * 1000;

export type CodexLoginMode = "browser" | "device";

export interface CodexLoginRequest {
  mode: CodexLoginMode;
  stdout: NodeJS.WriteStream;
  stderr: NodeJS.WriteStream;
}

/**
 * A started device-code login. Surfaces that cannot block on the operator (the
 * web console) read the code first, then poll `wait()` until the operator
 * approves it in a browser.
 */
export interface CodexDeviceLoginSession {
  userCode: string;
  verificationUrl: string;
  intervalMs: number;
  wait(): Promise<AuthSnapshot>;
  /** Abandons the flow; a pending `wait()` rejects instead of polling forever. */
  cancel(reason?: string): void;
}

/**
 * A started browser login. The caller hands the authorize URL back immediately
 * (the operator opens it in a browser on the machine that runs codexm, because
 * OpenAI redirects to a loopback port there) and awaits `wait()`.
 */
export interface CodexBrowserLoginSession {
  authorizeUrl: string;
  redirectUri: string;
  wait(): Promise<AuthSnapshot>;
  /** Abandons the flow; a pending `wait()` rejects and the callback port is released. */
  cancel(reason?: string): void;
}

export interface CodexLoginProvider {
  login(request: CodexLoginRequest): Promise<AuthSnapshot>;
  /** Optional: only providers that can drive the device flow expose it. */
  startDeviceLogin?(): Promise<CodexDeviceLoginSession>;
  /** Optional: only providers that can drive the browser flow expose it. */
  startBrowserLogin?(): Promise<CodexBrowserLoginSession>;
}

interface TokenExchangeResponse {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
}

interface DeviceUserCodeResponse {
  device_auth_id?: string;
  user_code?: string;
  usercode?: string;
  interval?: string | number;
}

interface DeviceTokenResponse {
  authorization_code?: string;
  code_verifier?: string;
  code_challenge?: string;
}

interface BrowserCallbackResult {
  code: string;
  state: string;
}

type BrowserCallbackWaiter = (
  state: string,
  stderr: NodeJS.WriteStream,
) => Promise<{ result: BrowserCallbackResult; redirectUri: string }>;

type BrowserOpenErrorHandler = (error: Error) => void;
type SpawnLike = typeof spawn;

interface CodexLoginProviderOptions {
  spawnImpl?: SpawnLike;
  waitForBrowserCallback?: BrowserCallbackWaiter;
}

interface PkceCodes {
  codeVerifier: string;
  codeChallenge: string;
}

function generateBase64Url(byteLength: number): string {
  return randomBytes(byteLength).toString("base64url");
}

function generatePkceCodes(): PkceCodes {
  const codeVerifier = generateBase64Url(96);
  const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");

  return {
    codeVerifier,
    codeChallenge,
  };
}

function buildAuthorizeUrl(state: string, redirectUri: string, pkce: PkceCodes): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: CODEX_CLIENT_ID,
    redirect_uri: redirectUri,
    scope: "openid profile email offline_access api.connectors.read api.connectors.invoke",
    code_challenge: pkce.codeChallenge,
    code_challenge_method: "S256",
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
    state,
    originator: CODEX_ORIGINATOR,
  });

  return `${CODEX_AUTH_BASE_URL}/oauth/authorize?${params.toString()}`;
}

const WINDOWS_CMD_METACHARACTERS = /[\^&|<>%]/g;

function escapeCmdArgument(value: string): string {
  return value.replace(WINDOWS_CMD_METACHARACTERS, "^$&");
}

function openBrowser(
  url: string,
  onError: BrowserOpenErrorHandler = () => undefined,
  spawnImpl: SpawnLike = spawn,
): void {
  const isWindows = process.platform === "win32";
  const command = isWindows ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
  // cmd.exe treats "&" as a command separator and Node only quotes arguments
  // that contain whitespace, so an unescaped authorize URL is cut at the first
  // "&": the browser loads a URL without client_id and OpenAI answers with
  // missing_required_parameter. Escape cmd metacharacters instead of relying
  // on quotes, which cmd's own argument parsing swallows.
  const args = isWindows ? ["/c", "start", "", escapeCmdArgument(url)] : [url];
  const child = spawnImpl(command, args, {
    detached: true,
    stdio: "ignore",
  });

  child.on("error", onError);
  child.unref();
}

function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const parts = jwt.split(".");
  if (parts.length < 2 || !parts[1]) {
    throw new Error("ID token is not a valid JWT.");
  }

  return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Record<string, unknown>;
}

function extractAccountIdFromIdToken(idToken: string): string {
  const payload = decodeJwtPayload(idToken);
  const authClaim = payload["https://api.openai.com/auth"];
  if (
    typeof authClaim === "object" &&
    authClaim !== null &&
    !Array.isArray(authClaim) &&
    typeof (authClaim as Record<string, unknown>).chatgpt_account_id === "string"
  ) {
    const accountId = (authClaim as Record<string, string>).chatgpt_account_id;
    if (accountId.trim() !== "") {
      return accountId;
    }
  }

  throw new Error("ID token is missing ChatGPT account id.");
}

function authSnapshotFromTokens(tokens: TokenExchangeResponse): AuthSnapshot {
  if (!tokens.id_token || !tokens.access_token || !tokens.refresh_token) {
    throw new Error("Token response is missing required fields.");
  }

  return {
    auth_mode: "chatgpt",
    tokens: {
      id_token: tokens.id_token,
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      account_id: extractAccountIdFromIdToken(tokens.id_token),
    },
    last_refresh: new Date().toISOString(),
  };
}

async function readJsonResponse<T>(response: Response, context: string): Promise<T> {
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`${context} failed with status ${response.status}: ${body.trim() || "empty response"}`);
  }

  return JSON.parse(body) as T;
}

async function exchangeCodeForTokens(
  fetchImpl: typeof fetch,
  code: string,
  redirectUri: string,
  codeVerifier: string,
): Promise<TokenExchangeResponse> {
  const response = await fetchImpl(`${CODEX_AUTH_BASE_URL}/oauth/token`, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: CODEX_CLIENT_ID,
      code,
      redirect_uri: redirectUri,
      code_verifier: codeVerifier,
    }),
  });

  return readJsonResponse<TokenExchangeResponse>(response, "Codex token exchange");
}

function writeHtml(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
  });
  response.end(body);
}

interface BrowserCallbackServerHandle {
  /** Resolves once the loopback listener is up; rejects when the port is taken. */
  ready: Promise<void>;
  result: Promise<{ result: BrowserCallbackResult; redirectUri: string }>;
  close: () => void;
}

function startBrowserCallbackServer(
  state: string,
  port: number,
  stderr?: NodeJS.WriteStream,
): BrowserCallbackServerHandle {
  let resolveResult: (value: { result: BrowserCallbackResult; redirectUri: string }) => void =
    () => undefined;
  let rejectResult: (error: Error) => void = () => undefined;
  const result = new Promise<{ result: BrowserCallbackResult; redirectUri: string }>(
    (resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    },
  );

  const redirectUri = `http://localhost:${port}/auth/callback`;
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const rawUrl = request.url ?? "/";
    const url = new URL(rawUrl, `http://localhost:${port}`);

    if (url.pathname !== "/auth/callback") {
      writeHtml(response, 404, "<h1>Not found</h1>");
      return;
    }

    const error = url.searchParams.get("error");
    if (error) {
      writeHtml(response, 400, "<h1>Codex login failed</h1><p>You can close this window.</p>");
      rejectResult(new Error(`Codex login failed: ${error}`));
      server.close();
      return;
    }

    const code = url.searchParams.get("code");
    const returnedState = url.searchParams.get("state");
    if (!code || !returnedState) {
      writeHtml(response, 400, "<h1>Codex login failed</h1><p>Missing callback parameters.</p>");
      rejectResult(new Error("Codex login callback is missing code or state."));
      server.close();
      return;
    }

    if (returnedState !== state) {
      writeHtml(response, 400, "<h1>Codex login failed</h1><p>Invalid state.</p>");
      rejectResult(new Error("Codex login callback state mismatch."));
      server.close();
      return;
    }

    writeHtml(response, 200, "<h1>Codex login complete</h1><p>You can close this window.</p>");
    resolveResult({
      result: {
        code,
        state: returnedState,
      },
      redirectUri,
    });
    server.close();
  });

  server.on("error", (error: Error) => {
    rejectResult(error);
  });

  const ready = new Promise<void>((resolve, reject) => {
    if (server.listening) {
      resolve();
      return;
    }
    server.once("listening", () => {
      stderr?.write(`Waiting for Codex login callback on http://localhost:${port}.\n`);
      resolve();
    });
    server.once("error", reject);
  });

  server.listen(port, "127.0.0.1");

  return {
    ready,
    result,
    close: () => server.close(),
  };
}

async function waitForBrowserCallback(
  state: string,
  stderr: NodeJS.WriteStream,
): Promise<{ result: BrowserCallbackResult; redirectUri: string }> {
  return await startBrowserCallbackServer(state, CODEX_LOGIN_PORT, stderr).result;
}

/**
 * Starts (but does not await) a browser login. The caller shows `authorizeUrl`
 * first — OpenAI redirects to a loopback port on the machine running codexm —
 * then awaits `wait()`.
 */
export async function startCodexBrowserLogin(
  fetchImpl: typeof fetch = globalThis.fetch,
  options: {
    port?: number;
    stderr?: NodeJS.WriteStream;
    openBrowser?: boolean;
    spawnImpl?: SpawnLike;
    timeoutMs?: number;
  } = {},
): Promise<CodexBrowserLoginSession> {
  const port = options.port ?? CODEX_LOGIN_PORT;
  const timeoutMs = options.timeoutMs ?? BROWSER_LOGIN_TIMEOUT_MS;
  const state = generateBase64Url(32);
  const pkce = generatePkceCodes();
  const redirectUri = `http://localhost:${port}/auth/callback`;
  const authorizeUrl = buildAuthorizeUrl(state, redirectUri, pkce);
  const server = startBrowserCallbackServer(state, port, options.stderr);
  // A late rejection still has to be observed when `wait()` is never awaited.
  server.result.catch(() => undefined);

  await server.ready;

  if (options.openBrowser) {
    try {
      openBrowser(
        authorizeUrl,
        (error) => {
          options.stderr?.write(`Failed to open browser automatically: ${error.message}\n`);
        },
        options.spawnImpl ?? spawn,
      );
    } catch (error) {
      options.stderr?.write(`Failed to open browser automatically: ${(error as Error).message}\n`);
    }
  }

  const cancelListeners = new Set<(error: Error) => void>();
  let cancellation: Error | null = null;
  let timeout: NodeJS.Timeout | null = null;

  /**
   * Abandoned browser logins used to hold the loopback callback listener
   * forever — nobody calls back when the tab is closed, and a long-lived host
   * (the console) would keep the port bound until it restarted.
   */
  const endSession = (reason: string): void => {
    if (cancellation) {
      return;
    }
    cancellation = new Error(reason);
    if (timeout) {
      clearTimeout(timeout);
      timeout = null;
    }
    server.close();
    for (const listener of cancelListeners) {
      listener(cancellation);
    }
    cancelListeners.clear();
  };

  return {
    authorizeUrl,
    redirectUri,
    wait: async (): Promise<AuthSnapshot> => {
      if (cancellation) {
        throw cancellation;
      }

      timeout = setTimeout(() => {
        endSession("Codex browser login timed out with no callback.");
      }, timeoutMs);
      // A pending timeout must not keep a short-lived process alive.
      timeout.unref?.();

      try {
        const { result } = await Promise.race([
          server.result,
          new Promise<never>((_, reject) => {
            if (cancellation) {
              reject(cancellation);
              return;
            }
            cancelListeners.add(reject);
          }),
        ]);

        const tokens = await exchangeCodeForTokens(
          fetchImpl,
          result.code,
          redirectUri,
          pkce.codeVerifier,
        );
        return authSnapshotFromTokens(tokens);
      } finally {
        if (timeout) {
          clearTimeout(timeout);
          timeout = null;
        }
      }
    },
    cancel: (reason?: string) => {
      endSession(reason ?? "Codex browser login was cancelled.");
    },
  };
}

function parseDeviceInterval(value: string | number | undefined): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number.parseInt(value.trim(), 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }

  return 5;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

const CODEX_DEVICE_VERIFICATION_URL = `${CODEX_AUTH_BASE_URL}/codex/device`;

async function requestDeviceUserCode(fetchImpl: typeof fetch): Promise<{
  userCode: string;
  deviceAuthId: string;
  intervalMs: number;
}> {
  const userCodeResponse = await fetchImpl(`${CODEX_AUTH_BASE_URL}/api/accounts/deviceauth/usercode`, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify({ client_id: CODEX_CLIENT_ID }),
  });
  const deviceCode = await readJsonResponse<DeviceUserCodeResponse>(
    userCodeResponse,
    "Codex device code request",
  );
  const userCode = (deviceCode.user_code ?? deviceCode.usercode ?? "").trim();
  const deviceAuthId = (deviceCode.device_auth_id ?? "").trim();
  if (!userCode || !deviceAuthId) {
    throw new Error("Codex device code response is missing required fields.");
  }

  return {
    userCode,
    deviceAuthId,
    intervalMs: parseDeviceInterval(deviceCode.interval) * 1000,
  };
}

/**
 * Starts (but does not await) a device-code login, so callers can show the code
 * before the operator has approved anything.
 */
export async function startCodexDeviceLogin(
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<CodexDeviceLoginSession> {
  const { userCode, deviceAuthId, intervalMs } = await requestDeviceUserCode(fetchImpl);
  const cancelListeners = new Set<(error: Error) => void>();
  let cancellation: Error | null = null;

  const waitForCancellation = (): Promise<never> =>
    new Promise((_, reject) => {
      if (cancellation) {
        reject(cancellation);
        return;
      }
      cancelListeners.add(reject);
    });

  const sleepOrCancel = async (ms: number): Promise<void> => {
    await Promise.race([sleep(ms), waitForCancellation()]);
    if (cancellation) {
      throw cancellation;
    }
  };

  const wait = async (): Promise<AuthSnapshot> => {
    const deadline = Date.now() + DEVICE_LOGIN_TIMEOUT_MS;
    let tokenResponse: DeviceTokenResponse | null = null;

    while (Date.now() < deadline) {
      if (cancellation) {
        throw cancellation;
      }

      const response = await fetchImpl(`${CODEX_AUTH_BASE_URL}/api/accounts/deviceauth/token`, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          device_auth_id: deviceAuthId,
          user_code: userCode,
        }),
      });

      if (response.ok) {
        tokenResponse = await response.json() as DeviceTokenResponse;
        break;
      }

      if (response.status !== 403 && response.status !== 404) {
        const body = await response.text();
        throw new Error(`Codex device token polling failed with status ${response.status}: ${body.trim() || "empty response"}`);
      }

      await sleepOrCancel(intervalMs);
    }

    if (cancellation) {
      throw cancellation;
    }

    if (!tokenResponse) {
      throw new Error("Codex device authentication timed out after 15 minutes.");
    }

    if (!tokenResponse.authorization_code || !tokenResponse.code_verifier) {
      throw new Error("Codex device token response is missing required fields.");
    }

    const tokens = await exchangeCodeForTokens(
      fetchImpl,
      tokenResponse.authorization_code,
      `${CODEX_AUTH_BASE_URL}/deviceauth/callback`,
      tokenResponse.code_verifier,
    );
    return authSnapshotFromTokens(tokens);
  };

  return {
    userCode,
    verificationUrl: CODEX_DEVICE_VERIFICATION_URL,
    intervalMs,
    wait,
    cancel: (reason?: string) => {
      cancellation = new Error(reason ?? "Codex device login was cancelled.");
      for (const listener of cancelListeners) {
        listener(cancellation);
      }
      cancelListeners.clear();
    },
  };
}

export function createCodexLoginProvider(
  fetchImpl: typeof fetch = globalThis.fetch,
  options: CodexLoginProviderOptions = {},
): CodexLoginProvider {
  const spawnImpl = options.spawnImpl ?? spawn;
  const waitForBrowserCallbackImpl = options.waitForBrowserCallback ?? waitForBrowserCallback;

  return {
    async login(request: CodexLoginRequest): Promise<AuthSnapshot> {
      if (request.mode === "browser") {
        const state = generateBase64Url(32);
        const pkce = generatePkceCodes();
        const redirectUri = `http://localhost:${CODEX_LOGIN_PORT}/auth/callback`;
        const authUrl = buildAuthorizeUrl(state, redirectUri, pkce);

        request.stderr.write(`Open this URL to authenticate Codex:\n${authUrl}\n`);
        try {
          openBrowser(authUrl, (error) => {
            request.stderr.write(`Failed to open browser automatically: ${error.message}\n`);
          }, spawnImpl);
        } catch (error) {
          request.stderr.write(`Failed to open browser automatically: ${(error as Error).message}\n`);
        }

        const { result } = await waitForBrowserCallbackImpl(state, request.stderr);
        const tokens = await exchangeCodeForTokens(fetchImpl, result.code, redirectUri, pkce.codeVerifier);
        return authSnapshotFromTokens(tokens);
      }

      const session = await startCodexDeviceLogin(fetchImpl);
      request.stderr.write(
        `Open ${session.verificationUrl} and enter code ${session.userCode}.\n`,
      );

      return await session.wait();
    },
    startDeviceLogin: () => startCodexDeviceLogin(fetchImpl),
    startBrowserLogin: () => startCodexBrowserLogin(fetchImpl, { spawnImpl }),
  };
}
