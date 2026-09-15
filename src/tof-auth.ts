import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * TOF4 (OA passport) login for the console, mirroring flaskpang's
 * `views/auth.py`:
 *
 *   1. unauthenticated request -> redirect to passport.woa.com (with callback)
 *   2. passport comes back to /login?code=...
 *   3. code -> TOF4 AccessToken (RIO signed) -> LoginName / ChineseName
 *   4. identity -> signed HttpOnly cookie; no server-side session state, so
 *      restarts and concurrent requests need nothing but the secret.
 */

const TOF4_ACCESS_TOKEN_URL =
  "http://api-s-idc.sgw.woa.com/ebus/tof4/api/v1/passport/AccessToken";
const PASSPORT_SIGNIN_URL = "https://passport.woa.com/modules/passport/signin.ashx";
const PASSPORT_SIGNOUT_URL = "https://passport.woa.com/modules/passport/signout.ashx";

export const TOF_SESSION_COOKIE = "codexm_tof_session";

/** Where the cookie signing key is kept so a restart does not log everyone out. */
const SECRET_FILE_NAME = "tof-session-secret";

/** A week, so OA only has to be visited once in a while (flaskpang does the same). */
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;
const TOF_REQUEST_TIMEOUT_MS = 10_000;

export interface TofUser {
  login_name: string;
  chinese_name: string;
}

export interface TofConfig {
  enabled: boolean;
  paasId: string;
  paasToken: string;
  secret: string;
}

function firstNonEmpty(...values: (string | undefined)[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") {
      return value.trim();
    }
  }
  return "";
}

function isTruthy(value: string | undefined): boolean {
  return value === "1" || (value ?? "").toLowerCase() === "true";
}

/**
 * A per-process key would invalidate the cookie on every restart, so it is
 * persisted next to the other console state. Cookies are host-scoped (not
 * port-scoped), so a console on a new port still accepts a previous session.
 */
function loadOrCreateSecret(stateDir?: string): string {
  if (!stateDir) {
    return randomBytes(32).toString("hex");
  }
  const filePath = join(stateDir, SECRET_FILE_NAME);
  try {
    if (existsSync(filePath)) {
      const existing = readFileSync(filePath, "utf8").trim();
      if (existing !== "") {
        return existing;
      }
    }
    const created = randomBytes(32).toString("hex");
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(filePath, created, { mode: 0o600 });
    return created;
  } catch {
    // Read-only or missing home: fall back to a key that only lasts this run.
    return randomBytes(32).toString("hex");
  }
}

/**
 * TOF stays off until it has an OAuth app token: without one every request
 * would bounce to passport and fail, so the console keeps working on its
 * one-shot local token instead.
 *
 * Env:
 *   CODEXM_TOF_PAAS_ID / PAAS_ID        OAuth appkey (default: pang_oa_com)
 *   CODEXM_TOF_PAAS_TOKEN / PAAS_TOKEN  OAuth token (required to enable)
 *   CODEXM_TOF_SECRET / SECRET_KEY      cookie signing key; generated and
 *                                       reused from <stateDir> when unset
 *   CODEXM_UI_LOGIN_DISABLED / LOGIN_DISABLED=1  force TOF off
 */
export function resolveTofConfig(stateDir?: string): TofConfig {
  const paasId =
    firstNonEmpty(process.env.CODEXM_TOF_PAAS_ID, process.env.PAAS_ID) || "pang_oa_com";
  const paasToken = firstNonEmpty(process.env.CODEXM_TOF_PAAS_TOKEN, process.env.PAAS_TOKEN);
  const secret =
    firstNonEmpty(process.env.CODEXM_TOF_SECRET, process.env.SECRET_KEY) ||
    loadOrCreateSecret(stateDir);
  const disabled =
    isTruthy(process.env.CODEXM_UI_LOGIN_DISABLED) || isTruthy(process.env.LOGIN_DISABLED);
  return { enabled: !disabled && paasToken !== "", paasId, paasToken, secret };
}

function rioHeaders(config: TofConfig): Record<string, string> {
  const timestamp = Math.floor(Date.now() / 1000);
  const nonce = randomInt(100_000, 999_999);
  const signature = createHash("sha256")
    .update(`${timestamp}${config.paasToken}${nonce}${timestamp}`)
    .digest("hex")
    .toUpperCase();
  return {
    "cache-control": "no-cache",
    "content-type": "application/json",
    "x-rio-nonce": String(nonce),
    "x-rio-signature": signature,
    "x-rio-timestamp": String(timestamp),
    "x-rio-paasid": config.paasId,
  };
}

function readString(source: unknown, key: string): string {
  if (!source || typeof source !== "object") {
    return "";
  }
  const value = (source as Record<string, unknown>)[key];
  return typeof value === "string" ? value : "";
}

/** Exchange the OAuth code for the OA identity behind it. */
export async function fetchTofUser(config: TofConfig, code: string): Promise<TofUser> {
  const url = `${TOF4_ACCESS_TOKEN_URL}?code=${encodeURIComponent(code)}`;
  const response = await fetch(url, {
    headers: rioHeaders(config),
    signal: AbortSignal.timeout(TOF_REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`认证服务返回 ${response.status}`);
  }

  const payload: unknown = await response.json();
  const ret = (payload as Record<string, unknown> | null)?.Ret;
  if (ret !== 0) {
    const reason =
      `${readString(payload, "ErrCode")} ${readString(payload, "ErrMsg")}`.trim() ||
      "未知错误";
    throw new Error(reason);
  }

  const data = (payload as Record<string, unknown> | null)?.Data;
  const loginName = readString(data, "LoginName");
  if (loginName === "") {
    throw new Error("未获取到用户信息");
  }
  return { login_name: loginName, chinese_name: readString(data, "ChineseName") };
}

export function buildPassportSignInUrl(config: TofConfig, callbackUrl: string): string {
  return (
    `${PASSPORT_SIGNIN_URL}?oauth=true` +
    `&url=${encodeURIComponent(callbackUrl)}` +
    `&appkey=${encodeURIComponent(config.paasId)}`
  );
}

export function buildPassportSignOutUrl(config: TofConfig, callbackUrl: string): string {
  return (
    `${PASSPORT_SIGNOUT_URL}?oauth=true` +
    `&appkey=${encodeURIComponent(config.paasId)}` +
    `&url=${encodeURIComponent(callbackUrl)}`
  );
}

function sign(config: TofConfig, payload: string): string {
  return createHmac("sha256", config.secret).update(payload).digest("base64url");
}

export function serializeTofSession(config: TofConfig, user: TofUser): string {
  const payload = Buffer.from(
    JSON.stringify({
      login_name: user.login_name,
      chinese_name: user.chinese_name,
      exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS,
    }),
  ).toString("base64url");
  return `${payload}.${sign(config, payload)}`;
}

export function parseTofSession(config: TofConfig, raw: string | null | undefined): TofUser | null {
  if (!raw) {
    return null;
  }
  const separator = raw.lastIndexOf(".");
  if (separator <= 0) {
    return null;
  }
  const payload = raw.slice(0, separator);
  const provided = Buffer.from(raw.slice(separator + 1));
  const expected = Buffer.from(sign(config, payload));
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return null;
  }

  try {
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      login_name?: unknown;
      chinese_name?: unknown;
      exp?: unknown;
    };
    const exp = typeof decoded.exp === "number" ? decoded.exp : 0;
    if (exp * 1000 <= Date.now()) {
      return null;
    }
    const loginName = typeof decoded.login_name === "string" ? decoded.login_name : "";
    if (loginName === "") {
      return null;
    }
    return {
      login_name: loginName,
      chinese_name: typeof decoded.chinese_name === "string" ? decoded.chinese_name : "",
    };
  } catch {
    return null;
  }
}

export function readCookie(header: string | undefined, name: string): string | null {
  if (!header) {
    return null;
  }
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) {
      continue;
    }
    if (part.slice(0, index).trim() === name) {
      return decodeURIComponent(part.slice(index + 1).trim());
    }
  }
  return null;
}

export function readTofSession(config: TofConfig, cookieHeader: string | undefined): TofUser | null {
  return parseTofSession(config, readCookie(cookieHeader, TOF_SESSION_COOKIE));
}

export function tofSessionCookie(value: string): string {
  return (
    `${TOF_SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; ` +
    `Max-Age=${SESSION_TTL_SECONDS}`
  );
}

export function expiredTofSessionCookie(): string {
  return `${TOF_SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}
