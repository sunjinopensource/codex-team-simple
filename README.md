# codex-team

This repository now keeps only two surfaces:

- **webui** — `codexm ui`, a loopback-only web console for managing saved Codex ChatGPT accounts (`src/commands/ui.ts` and its dependencies).
- **python server** — the account-bundle registry server (`server-python/`).

Everything else (CLI command set, terminal dashboard, watch, daemon, proxy, run, share-bundle commands, tests, agent skills) has been removed.

## Layout

| Path | What it is |
|---|---|
| `src/` | webui console plus the modules it needs (account store, auth, quota, Desktop control, tray, registry client) |
| `server-python/` | Flask registry server: stores bundles produced by `codexm export`, hands them back to clients |

## Run the webui

```bash
pnpm install
pnpm build
node dist/cli.js ui
```

The console listens on `127.0.0.1` only and prints a one-shot-token URL:

```
http://127.0.0.1:<port>/?token=...
```

| Flag | Meaning |
|---|---|
| `--port <port>` | serve on a fixed port instead of a random one |
| `--no-open` | start the server without opening a browser tab |
| `--tray` | keep the console resident in the system tray (Windows; other platforms fall back to the normal console) |
| `--debug` | log background activity to stderr |

From the console you can add accounts (device-code login, browser-callback login, or API key), switch the active account, re-login accounts whose refresh token was revoked, delete accounts, restart Codex Desktop, and sync with a registry server.

### TOF (OA) login

The console can require an OA login before it serves anything — same TOF4 flow as flaskpang (`views/auth.py`): `/login` redirects to `passport.woa.com`, passport comes back with `?code=...`, the code is exchanged through the RIO-signed TOF4 AccessToken API for `LoginName` / `ChineseName`, and the identity is kept in a signed `HttpOnly` cookie. `/api/*` answers `401 {"need_login": true}` instead of redirecting, so `fetch` never gets an HTML login page.

| Env | Meaning |
|---|---|
| `CODEXM_TOF_PAAS_ID` / `PAAS_ID` | OAuth appkey (default `pang_oa_com`) |
| `CODEXM_TOF_PAAS_TOKEN` / `PAAS_TOKEN` | OAuth token; TOF stays **off** without it |
| `CODEXM_TOF_SECRET` / `SECRET_KEY` | cookie signing key; random per process when unset (a restart logs everyone out) |
| `CODEXM_UI_LOGIN_DISABLED` / `LOGIN_DISABLED=1` | force TOF off (local debugging) |

```bash
export CODEXM_TOF_PAAS_ID=pang_oa_com
export CODEXM_TOF_PAAS_TOKEN=...
node dist/cli.js ui
```

Without a token the console keeps working on its one-shot local token alone, and says so at startup.

## Run the registry server

```bash
cd server-python
pip install -r requirements.txt
export CODEXM_REGISTRY_DATA=./registry-data
flask --app server run --port 8787
```

See [`server-python/README.md`](./server-python/README.md) for the API, token setup, refresh leases and security notes.

## Verify

```bash
pnpm typecheck
pnpm build
```
