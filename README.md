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
