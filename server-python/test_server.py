"""Behaviour tests for the registry server.

Run from this directory:
    python -m unittest test_server

Everything runs against a throwaway data directory, so the operator's real
registry is never touched.
"""

from __future__ import annotations

import base64
import json
import os
import tempfile
import threading
import time
import unittest

_TMP_DATA = tempfile.mkdtemp(prefix="codexm-registry-test-")
os.environ["CODEXM_REGISTRY_DATA"] = _TMP_DATA
os.environ["CODEXM_REGISTRY_TOKEN"] = "test-token"

import server  # noqa: E402  (must import after the env vars are set)

server.app.testing = True

AUTH = {"Authorization": "Bearer test-token"}


def _segment(payload: dict) -> str:
    return base64.urlsafe_b64encode(json.dumps(payload).encode()).decode().rstrip("=")


def _jwt(exp: int) -> str:
    return f"{_segment({'alg': 'none'})}.{_segment({'exp': exp})}.signature"


def _bundle(exp: int, tag: str) -> dict:
    return {
        "kind": "auth_bundle",
        "version": 1,
        "exported_at": "2026-01-01T00:00:00Z",
        "auth": {
            "kind": "chatgpt",
            "auth_json": {
                "auth_mode": "chatgpt",
                "tokens": {
                    "id_token": _jwt(exp),
                    "access_token": _jwt(exp),
                    "account_id": tag,
                },
                "last_refresh": "2026-01-01T00:00:00Z",
            },
            "profile": {"plan": "pro"},
        },
    }


def _exp_iso(exp: int) -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(exp))


class RegistryServerTest(unittest.TestCase):
    def setUp(self) -> None:
        self.client = server.app.test_client()
        self.counter = 0

    def _name(self) -> str:
        self.counter += 1
        return f"acct-{id(self) % 9973}-{self.counter}"

    def _put(self, name: str, exp: int, tag: str = "t", **headers):
        return self.client.put(
            f"/v1/accounts/{name}",
            json=_bundle(exp, tag),
            headers={**AUTH, **headers},
        )

    def _lease(self, name: str, client_id: str, action: str = "acquire", ttl_ms=None):
        body = {"client_id": client_id, "action": action}
        if ttl_ms is not None:
            body["ttl_ms"] = ttl_ms
        return self.client.post(f"/v1/accounts/{name}/lease", json=body, headers=AUTH)

    def _meta(self, name: str) -> dict | None:
        response = self.client.get("/v1/accounts", headers=AUTH)
        for account in response.get_json()["accounts"]:
            if account["name"] == name:
                return account
        return None

    # --- upload / version -------------------------------------------------

    def test_upload_stamps_monotonic_version(self) -> None:
        name = self._name()
        first = self._put(name, 2_000_000_000)
        self.assertEqual(first.status_code, 200)
        self.assertEqual(first.get_json()["version"], 1)

        second = self._put(name, 2_000_100_000)
        self.assertEqual(second.get_json()["version"], 2)
        self.assertEqual(self._meta(name)["version"], 2)

    def test_older_upload_is_rejected(self) -> None:
        name = self._name()
        self._put(name, 2_000_000_000, tag="newer")
        response = self._put(name, 1_900_000_000, tag="older")

        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.get_json()["reason"], "registry holds a newer token")
        # The stored bundle must be untouched.
        stored_response = self.client.get(f"/v1/accounts/{name}", headers=AUTH)
        stored = stored_response.get_json()
        stored_response.close()
        self.assertEqual(stored["auth"]["auth_json"]["tokens"]["account_id"], "newer")

    def test_force_header_allows_older_upload(self) -> None:
        name = self._name()
        self._put(name, 2_000_000_000, tag="newer")
        response = self._put(name, 1_900_000_000, tag="older", **{"X-Registry-Force": "1"})

        self.assertEqual(response.status_code, 200)
        stored_response = self.client.get(f"/v1/accounts/{name}", headers=AUTH)
        stored = stored_response.get_json()
        stored_response.close()
        self.assertEqual(stored["auth"]["auth_json"]["tokens"]["account_id"], "older")

    def test_equal_expiry_upload_is_accepted(self) -> None:
        name = self._name()
        self._put(name, 2_000_000_000, tag="first")
        response = self._put(name, 2_000_000_000, tag="second")
        self.assertEqual(response.status_code, 200)

    # --- leases -----------------------------------------------------------

    def test_lease_granted_then_denied_then_renewed(self) -> None:
        name = self._name()
        granted = self._lease(name, "machine-a").get_json()
        self.assertTrue(granted["granted"])
        self.assertIsNotNone(granted["lease_id"])

        denied = self._lease(name, "machine-b").get_json()
        self.assertFalse(denied["granted"])
        self.assertEqual(denied["holder"], "machine-a")

        renewed = self._lease(name, "machine-a", ttl_ms=60_000).get_json()
        self.assertTrue(renewed["granted"])
        self.assertEqual(renewed["lease_id"], granted["lease_id"])

    def test_expired_lease_is_taken_over(self) -> None:
        name = self._name()
        self._lease(name, "machine-a", ttl_ms=1_000)
        # Force the lease into the past instead of sleeping through a TTL.
        with server.registry_lock():
            leases = server.load_leases()
            leases[name]["expires_at_epoch"] = time.time() - 10
            server.save_leases(leases)

        taken = self._lease(name, "machine-b").get_json()
        self.assertTrue(taken["granted"])

    def test_release_only_honoured_by_holder(self) -> None:
        name = self._name()
        self._lease(name, "machine-a")
        self.assertFalse(self._lease(name, "machine-b", "release").get_json()["released"])
        self.assertTrue(self._lease(name, "machine-a", "release").get_json()["released"])
        self.assertTrue(self._lease(name, "machine-c").get_json()["granted"])

    def test_leased_upload_releases_the_lease(self) -> None:
        name = self._name()
        lease_id = self._lease(name, "machine-a").get_json()["lease_id"]
        self.assertEqual(self._put(name, 2_000_000_000, tag="refreshed",
                                   **{"X-Lease-Id": lease_id}).status_code, 200)

        status = self.client.get(f"/v1/accounts/{name}/lease", headers=AUTH).get_json()
        self.assertIsNone(status["lease"])

    def test_upload_with_stale_lease_is_rejected(self) -> None:
        name = self._name()
        self._put(name, 2_000_100_000, tag="newer")
        response = self._put(name, 1_900_000_000, tag="stale",
                             **{"X-Lease-Id": "not-a-real-lease"})

        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.get_json()["reason"], "lease_invalid")

    def test_leaseholder_may_upload_older_token(self) -> None:
        """The authorised refresher wins even when exp did not advance."""
        name = self._name()
        self._put(name, 2_000_100_000, tag="newer")
        lease_id = self._lease(name, "machine-a").get_json()["lease_id"]
        response = self._put(name, 1_900_000_000, tag="leased",
                             **{"X-Lease-Id": lease_id})

        self.assertEqual(response.status_code, 200)
        stored_response = self.client.get(f"/v1/accounts/{name}", headers=AUTH)
        stored = stored_response.get_json()
        stored_response.close()
        self.assertEqual(stored["auth"]["auth_json"]["tokens"]["account_id"], "leased")

    # --- concurrency ------------------------------------------------------

    def test_concurrent_acquire_has_a_single_winner(self) -> None:
        name = self._name()
        results: list[bool] = []
        barrier = threading.Barrier(8)

        def attempt(index: int) -> None:
            barrier.wait()
            granted = self._lease(name, f"machine-{index}").get_json()["granted"]
            results.append(granted)

        threads = [threading.Thread(target=attempt, args=(i,)) for i in range(8)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()

        self.assertEqual(sum(results), 1, f"expected exactly one holder, got {results}")

    def test_concurrent_uploads_keep_the_newest_token(self) -> None:
        name = self._name()
        base = 2_000_000_000
        barrier = threading.Barrier(8)

        def attempt(index: int) -> None:
            barrier.wait()
            self._put(name, base + index, tag=f"t{index}")

        threads = [threading.Thread(target=attempt, args=(i,)) for i in range(8)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()

        self.assertEqual(self._meta(name)["token_expires_at"], _exp_iso(base + 7))


if __name__ == "__main__":
    unittest.main()
