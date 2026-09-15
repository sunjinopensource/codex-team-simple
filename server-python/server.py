"""codexm registry server — a minimal account-bundle repository.

Design constraints:
  * stores the EXACT JSON produced by `codexm export` (bundle format untouched)
  * no business logic: validation of the bundle stays in the Node client
  * Bearer token auth, append-only audit log
  * writes are serialised by a file lock, and a newer token is never rewound
  * short-lived refresh leases so only one client refreshes an account at a
    time (see README)

Data layout (<data-dir>/):
  accounts/<name>.json   raw share bundle
  index.json             metadata for listing (never contains tokens)
  leases.json            in-flight refresh leases (short TTL)
  audit.jsonl            who did what, when
  token.txt              bearer token, generated on first run

Environment:
  CODEXM_REGISTRY_DATA   data directory (default: ./registry-data)
  CODEXM_REGISTRY_TOKEN  bearer token (default: read or generate <data>/token.txt)
  PORT                   listen port (default: 8787)

Run (dev):
  flask --app server run --port 8787
Run (prod):
  gunicorn -w 1 -b 127.0.0.1:8787 server:app     # single worker: JSON file storage
"""

from __future__ import annotations

import base64
import calendar
import contextlib
import hmac
import json
import os
import re
import secrets
import threading
import time
import uuid
from pathlib import Path

try:  # POSIX
    import fcntl
except ImportError:  # pragma: no cover - Windows
    fcntl = None
try:  # Windows
    import msvcrt
except ImportError:  # pragma: no cover - POSIX
    msvcrt = None

from flask import Flask, abort, jsonify, request, send_file

app = Flask(__name__)
app.config["MAX_CONTENT_LENGTH"] = 5 * 1024 * 1024  # bundles are a few KB

DATA = Path(os.environ.get("CODEXM_REGISTRY_DATA", "./registry-data"))
ACCOUNTS = DATA / "accounts"
INDEX = DATA / "index.json"
AUDIT = DATA / "audit.jsonl"
TOKEN_FILE = DATA / "token.txt"
LEASES = DATA / "leases.json"
LOCK_FILE = DATA / ".lock"

# Refresh leases are short-lived on purpose: they only need to cover the few
# seconds an OAuth refresh takes. That keeps the server free of heartbeat,
# takeover and fencing logic — an expired lease simply disappears.
LEASE_TTL_DEFAULT_MS = 120_000
LEASE_TTL_MAX_MS = 600_000

# Same pattern the Node client uses for account names (keeps paths safe).
NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")

ACCOUNTS.mkdir(parents=True, exist_ok=True)
if not LOCK_FILE.exists():  # msvcrt.locking needs a non-empty region
    LOCK_FILE.write_text(" ", encoding="utf-8")


def now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def resolve_token() -> str:
    """Bearer token from env, or persisted in <data>/token.txt."""
    token = os.environ.get("CODEXM_REGISTRY_TOKEN", "").strip()
    if token:
        return token
    if TOKEN_FILE.exists():
        return TOKEN_FILE.read_text(encoding="utf-8").strip()
    generated = secrets.token_urlsafe(32)
    TOKEN_FILE.write_text(generated, encoding="utf-8")
    try:
        os.chmod(TOKEN_FILE, 0o600)
    except OSError:
        pass
    print(f"[registry] generated token -> {TOKEN_FILE}: {generated}")
    return generated


TOKEN = resolve_token()


def audit(action: str, name: str, ok: bool = True, note: str = "") -> None:
    entry = {
        "ts": now_iso(),
        "ip": request.remote_addr,
        "action": action,
        "account": name,
        "ok": ok,
        "note": note,
    }
    with AUDIT.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(entry) + "\n")


def load_index() -> dict:
    if not INDEX.exists():
        return {}
    try:
        data = json.loads(INDEX.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (json.JSONDecodeError, OSError):
        return {}


def save_index(index: dict) -> None:
    tmp = INDEX.with_suffix(".tmp")
    tmp.write_text(json.dumps(index, indent=2), encoding="utf-8")
    os.replace(tmp, INDEX)


_thread_lock = threading.Lock()


@contextlib.contextmanager
def registry_lock():
    """Serialise read-modify-write cycles across threads *and* processes.

    Flask's dev server is threaded and gunicorn may run more than one worker,
    so both an in-process lock and an OS-level file lock are held.
    """
    with _thread_lock, LOCK_FILE.open("a+") as handle:
        if fcntl is not None:
            fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
        elif msvcrt is not None:
            handle.seek(0)
            msvcrt.locking(handle.fileno(), msvcrt.LK_LOCK, 1)
        try:
            yield
        finally:
            if fcntl is not None:
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
            elif msvcrt is not None:
                handle.seek(0)
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)


def load_leases() -> dict:
    if not LEASES.exists():
        return {}
    try:
        data = json.loads(LEASES.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (json.JSONDecodeError, OSError):
        return {}


def save_leases(leases: dict) -> None:
    tmp = LEASES.with_suffix(".tmp")
    tmp.write_text(json.dumps(leases, indent=2), encoding="utf-8")
    os.replace(tmp, LEASES)


def epoch_to_iso(epoch: float) -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(epoch))


def prune_lease(leases: dict, name: str) -> dict | None:
    """Return the live lease for `name`, dropping it when absent or expired."""
    lease = leases.get(name)
    if not isinstance(lease, dict):
        leases.pop(name, None)
        return None
    expires = lease.get("expires_at_epoch")
    if not isinstance(expires, (int, float)) or expires <= time.time():
        leases.pop(name, None)
        return None
    return lease


def exp_rank(value: object) -> float:
    """Sortable rank for an expiry timestamp; unknown/unparsable sorts lowest."""
    if not isinstance(value, str) or value == "":
        return -1.0
    try:
        return float(calendar.timegm(time.strptime(value, "%Y-%m-%dT%H:%M:%SZ")))
    except (ValueError, TypeError):
        return -1.0


def jwt_exp_iso(token: object) -> str | None:
    """Read a JWT's exp claim without verifying the signature.

    Metadata only: this tells clients which copy of an account is fresher so
    `codexm remote sync` never rewinds a token another machine just refreshed.
    """
    if not isinstance(token, str):
        return None
    parts = token.split(".")
    if len(parts) < 2:
        return None
    payload = parts[1]
    try:
        claims = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
    except Exception:
        return None
    exp = claims.get("exp") if isinstance(claims, dict) else None
    if not isinstance(exp, (int, float)):
        return None
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(exp))


def summarize(bundle: dict) -> dict:
    """Metadata only — never index token material."""
    auth = bundle.get("auth") or {}
    profile = auth.get("profile") or {}
    tokens = (auth.get("auth_json") or {}).get("tokens") or {}
    return {
        "kind": auth.get("kind"),
        "plan_type": profile.get("plan"),
        "account_id": tokens.get("account_id"),
        "token_expires_at": jwt_exp_iso(tokens.get("id_token"))
        or jwt_exp_iso(tokens.get("access_token")),
    }


@app.before_request
def check_auth():
    if request.path == "/healthz":
        return None
    header = request.headers.get("Authorization", "")
    if not header.startswith("Bearer "):
        return jsonify(error="missing bearer token"), 401
    if not TOKEN or not hmac.compare_digest(header[7:], TOKEN):
        return jsonify(error="invalid token"), 403
    return None


@app.get("/healthz")
def healthz():
    return jsonify(ok=True, accounts=len(load_index()))


@app.get("/v1/accounts")
def list_accounts():
    index = load_index()
    return jsonify(accounts=[{"name": name, **meta} for name, meta in index.items()])


@app.get("/v1/accounts/<name>")
def get_account(name: str):
    if not NAME_RE.match(name):
        abort(400, description="invalid account name")
    path = ACCOUNTS / f"{name}.json"
    if not path.exists():
        return jsonify(error="not found"), 404

    version = None
    with registry_lock():
        index = load_index()
        meta = index.get(name)
        if isinstance(meta, dict):
            meta["last_downloaded_at"] = now_iso()
            save_index(index)
            version = meta.get("version")
    audit("download", name)
    response = send_file(path, mimetype="application/json")
    if isinstance(version, int):
        response.headers["X-Registry-Version"] = str(version)
    return response


@app.put("/v1/accounts/<name>")
def put_account(name: str):
    if not NAME_RE.match(name):
        abort(400, description="invalid account name")
    bundle = request.get_json(force=True, silent=True)
    if not isinstance(bundle, dict) or bundle.get("kind") != "auth_bundle":
        audit("upload", name, ok=False, note="invalid bundle")
        return jsonify(error="invalid bundle: expected kind=auth_bundle"), 400

    summary = summarize(bundle)
    # `--force` maps to this header: overwrite even when the upload is older.
    forced = request.headers.get("X-Registry-Force", "") == "1"
    lease_id = request.headers.get("X-Lease-Id") or ""

    with registry_lock():
        index = load_index()
        leases = load_leases()
        current = index.get(name)
        current = current if isinstance(current, dict) else None

        lease_ok = False
        if lease_id:
            lease = prune_lease(leases, name)
            lease_ok = bool(lease) and lease.get("lease_id") == lease_id
            if not lease_ok:
                audit("upload", name, ok=False, note="invalid or expired lease")
                return jsonify(
                    error="stale",
                    reason="lease_invalid",
                    name=name,
                    current=current,
                ), 409

        # A blind upload could rewind a token another machine just refreshed,
        # so compare expiries while holding the lock. Leased writers are the
        # authorised refresher and always win.
        if (
            current is not None
            and not forced
            and not lease_ok
            and exp_rank(summary.get("token_expires_at"))
            < exp_rank(current.get("token_expires_at"))
        ):
            audit("upload", name, ok=False, note="stale token rejected")
            return jsonify(
                error="stale",
                reason="registry holds a newer token",
                name=name,
                current=current,
            ), 409

        tmp = ACCOUNTS / f"{name}.json.tmp"
        payload = json.dumps(bundle, indent=2)
        tmp.write_text(payload, encoding="utf-8")
        try:
            os.chmod(tmp, 0o600)
        except OSError:
            pass
        os.replace(tmp, ACCOUNTS / f"{name}.json")

        previous_version = current.get("version") if current else None
        version = previous_version + 1 if isinstance(previous_version, int) else 1
        index[name] = {
            **summary,
            "version": version,
            "updated_at": now_iso(),
            "last_downloaded_at": (current or {}).get("last_downloaded_at"),
            "size": len(payload),
        }
        save_index(index)

        if lease_ok:
            # The refresh round-trip is done; release so others can refresh.
            leases.pop(name, None)
            save_leases(leases)

    audit("upload", name)
    return jsonify(ok=True, name=name, version=version, **summary)


@app.get("/v1/accounts/<name>/lease")
@app.post("/v1/accounts/<name>/lease")
def lease_account(name: str):
    """Short-lived "I am refreshing this account right now" lock.

    Only the holder may upload a refreshed bundle while the lease is live, and
    a successful upload releases it. There is no heartbeat: an abandoned lease
    expires on its own, which is safe because refreshes happen at most once a
    day per account.
    """
    if not NAME_RE.match(name):
        abort(400, description="invalid account name")

    if request.method == "GET":
        with registry_lock():
            lease = prune_lease(load_leases(), name)
        return jsonify(ok=True, name=name, lease=lease)

    body = request.get_json(force=True, silent=True)
    if not isinstance(body, dict):
        return jsonify(error="invalid body: expected a JSON object"), 400

    action = str(body.get("action") or "acquire")
    client_id = str(body.get("client_id") or "").strip()
    if client_id == "" or len(client_id) > 128:
        return jsonify(error="client_id is required (1-128 chars)"), 400

    ttl_ms = body.get("ttl_ms", LEASE_TTL_DEFAULT_MS)
    try:
        ttl_ms = int(ttl_ms)
    except (TypeError, ValueError):
        return jsonify(error="ttl_ms must be an integer"), 400
    ttl_ms = max(1_000, min(ttl_ms, LEASE_TTL_MAX_MS))

    with registry_lock():
        leases = load_leases()
        lease = prune_lease(leases, name)

        if action == "release":
            if lease and lease.get("client_id") == client_id:
                leases.pop(name, None)
                save_leases(leases)
                audit("lease.release", name, note=client_id)
                return jsonify(ok=True, name=name, released=True)
            audit("lease.release", name, ok=False, note=client_id)
            return jsonify(ok=True, name=name, released=False)

        if action not in ("acquire", "renew"):
            return jsonify(error=f"unknown action: {action}"), 400

        if lease is None or lease.get("client_id") == client_id:
            lease_id = (lease or {}).get("lease_id") or uuid.uuid4().hex
            expires = time.time() + ttl_ms / 1000.0
            leases[name] = {
                "client_id": client_id,
                "lease_id": lease_id,
                "acquired_at": (lease or {}).get("acquired_at") or now_iso(),
                "expires_at": epoch_to_iso(expires),
                "expires_at_epoch": expires,
                "ttl_ms": ttl_ms,
            }
            save_leases(leases)
            audit("lease.acquire", name, note=client_id)
            return jsonify(
                ok=True,
                name=name,
                granted=True,
                lease_id=lease_id,
                expires_at=leases[name]["expires_at"],
                ttl_ms=ttl_ms,
            )

        audit("lease.deny", name, ok=False, note=client_id)
        return jsonify(
            ok=True,
            name=name,
            granted=False,
            holder=lease.get("client_id"),
            expires_at=lease.get("expires_at"),
        )


@app.delete("/v1/accounts/<name>")
def delete_account(name: str):
    if not NAME_RE.match(name):
        abort(400, description="invalid account name")
    path = ACCOUNTS / f"{name}.json"
    if not path.exists():
        return jsonify(error="not found"), 404
    path.unlink()
    with registry_lock():
        index = load_index()
        index.pop(name, None)
        save_index(index)
        leases = load_leases()
        if name in leases:
            leases.pop(name, None)
            save_leases(leases)
    audit("delete", name)
    return jsonify(ok=True)


@app.get("/v1/audit")
def get_audit():
    limit = request.args.get("limit", "100")
    try:
        limit = max(1, min(int(limit), 1000))
    except ValueError:
        limit = 100
    if not AUDIT.exists():
        return jsonify(entries=[])
    lines = AUDIT.read_text(encoding="utf-8").splitlines()[-limit:]
    entries = []
    for line in lines:
        try:
            entries.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return jsonify(entries=entries)


if __name__ == "__main__":
    # Default to loopback. Set HOST=0.0.0.0 to expose to your LAN — only do
    # that on a trusted network, since bundles carry live refresh tokens.
    app.run(
        host=os.environ.get("HOST", "127.0.0.1"),
        port=int(os.environ.get("PORT", "8787")),
    )
