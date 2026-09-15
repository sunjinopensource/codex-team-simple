# codexm registry server

A tiny account-bundle repository for `codexm`, so several machines can share
managed accounts without copying files around by hand.

It stores the **exact JSON produced by `codexm export`** — no new format, no
re-encoding. Bundle validation stays in the Node client (`parseShareBundle`),
so this server never needs to understand the bundle contents beyond a few
metadata fields used for listing.

```
client (codexm remote pull)  ──►  GET  /v1/accounts/<name>         raw bundle
client (codexm remote push)  ──►  PUT  /v1/accounts/<name>         raw bundle
client (auto-sync)           ──►  POST /v1/accounts/<name>/lease   refresh lock
UI / CLI listing             ──►  GET  /v1/accounts                metadata only
```

## Run

```bash
pip install -r requirements.txt

# dev
export CODEXM_REGISTRY_DATA=./registry-data
flask --app server run --port 8787

# prod (single worker — JSON file storage is not multi-writer safe)
export CODEXM_REGISTRY_TOKEN=<a-long-random-string>
gunicorn -w 1 -b 127.0.0.1:8787 server:app
```

On first run without `CODEXM_REGISTRY_TOKEN`, a token is generated and written
to `<data-dir>/token.txt`. Copy it into your password manager and into each
client's `codexm remote add --token`.

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `CODEXM_REGISTRY_DATA` | `./registry-data` | where bundles, index and audit log live |
| `CODEXM_REGISTRY_TOKEN` | `<data>/token.txt` | bearer token required by every `/v1` route |
| `PORT` | `8787` | only used by `python server.py` |

## API

| Method | Path | Notes |
|---|---|---|
| GET | `/healthz` | unauthenticated liveness check |
| GET | `/v1/accounts` | list metadata (name, kind, plan, account_id, updated_at, last_downloaded_at) |
| GET | `/v1/accounts/<name>` | download the raw bundle; records `last_downloaded_at` |
| PUT | `/v1/accounts/<name>` | upload a bundle; a newer token is never rewound (see below) |
| GET | `/v1/accounts/<name>/lease` | current refresh lease, if any |
| POST | `/v1/accounts/<name>/lease` | `acquire` / `renew` / `release` a refresh lease |
| DELETE | `/v1/accounts/<name>` | remove an account, and any lease it holds |
| GET | `/v1/audit?limit=100` | recent audit entries |

All `/v1` routes require `Authorization: Bearer <token>`.

### Uploads never rewind a token

`PUT` compares the incoming `id_token` expiry with the stored one while holding
the write lock. Uploading an older bundle answers `409` with
`{"error":"stale","reason":"registry holds a newer token","current":{...}}` and
the caller is expected to adopt the server copy instead. Two request headers
change that:

* `X-Registry-Force: 1` — overwrite anyway (`codexm remote push --force`)
* `X-Lease-Id: <id>` — the caller holds the live refresh lease, so it is the
  authorised refresher and always wins; a successful upload releases the lease

### Refresh leases

Several machines can share one account, and they all cross the refresh
threshold at the same moment. Only one may rotate the refresh token, so a
client takes a lease before refreshing:

```
POST /v1/accounts/<name>/lease   {"client_id": "laptop-9f3a", "action": "acquire"}
  → {"granted": true,  "lease_id": "...", "expires_at": "...", "ttl_ms": 120000}
  → {"granted": false, "holder": "desktop-01", "expires_at": "..."}
```

Leases are short-lived (default 120 s, max 600 s) and expire on their own — no
heartbeat, no takeover, no fencing. That is deliberate: an account is refreshed
at most once a day, so the only window worth protecting is the few seconds of a
single OAuth round-trip.

Run the tests with `python -m unittest test_server`.

## Security notes

* **The bundles contain live refresh tokens.** Anyone with the token can
  download every account. Treat this host as a credential store.
* Serve over HTTPS or keep it on a private network (Tailscale/WireGuard/VPN).
  Plain HTTP on a public IP is not acceptable.
* Behind a reverse proxy, terminate TLS there (Caddy does this automatically:
  `caddy reverse-proxy --from registry.example.com --to :8787`).
* `gunicorn -w 1` is still recommended. Writes are now serialised by a file
  lock, so several workers no longer corrupt `index.json`, but SQLite is the
  answer before scaling out.
* The audit log is append-only and records IP, action and account for every
  upload/download/delete.

## Known tradeoffs

* **Concurrent *use* is still allowed.** The lease covers refreshing only: two
  clients can download the same account and use it at the same time. ChatGPT
  refresh tokens rotate, so whoever refreshes invalidates the other's refresh
  token — the lease makes that happen once, deliberately, instead of by
  accident. `last_downloaded_at` is exposed so the UI can warn when an account
  was recently pulled by someone else.
* **A holder that dies mid-refresh leaves the rotation unrecorded.** The
  refreshed token only exists in that machine's memory until it is uploaded, so
  the server cannot recover it. The client writes the token to disk *before*
  uploading, so a later pass re-pushes it; if that machine never comes back, the
  account needs a fresh login.
* **Writes are serialised, not distributed.** The file lock covers threads and
  processes on this host. Do not point two servers at one data directory over a
  network filesystem.
