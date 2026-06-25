"""Tests for the API-key-only PresignedURLBackend (ACCEPTANCE B1–B4, D4).

The unit tests use a fake HTTP layer so they run without a live stack or boto3.
The live end-to-end test (``test_live_end_to_end``) runs only when SP_LIVE_BASE_URL
is set, and drives a real apiserver with ONLY an API key (no S3 creds) — that is
the D3 demo, reusable in CI against the local stack.
"""

from __future__ import annotations

import os
import tempfile

import pytest

from synergyplus import PresignedURLBackend, ResultLocation, SynergyClient
from synergyplus.storage import StorageError


# --- a tiny fake transport ----------------------------------------------------


class _Resp:
    def __init__(self, status=200, json_body=None, text="", content=b""):
        self.status_code = status
        self._json = json_body
        self.text = text
        self.content = content
        self.ok = 200 <= status < 300

    def json(self):
        return self._json

    def raise_for_status(self):
        if not self.ok:
            raise RuntimeError(f"HTTP {self.status_code}")

    # context-manager form used by streaming download
    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def iter_content(self, chunk_size=0):
        yield self.content


class _FakeSession:
    """Records POST/GET calls and replays canned responses keyed by URL suffix."""

    def __init__(self):
        self.headers = {}
        self.calls = []
        self.uploads = []  # (method, url, body bytes)
        self.minted_put_url = "http://localhost:9000/models/uploads/HASH-x.idf?sig=PUT"
        self.artifacts = []

    def post(self, url, json=None, timeout=None):
        self.calls.append(("POST", url, json))
        if url.endswith("/v1/uploads"):
            return _Resp(
                200,
                {
                    "url": self.minted_put_url,
                    "ref": "s3://models/uploads/%s-%s"
                    % (json["sha256"], json["filename"]),
                    "method": "PUT",
                    "expiresIn": 300,
                },
            )
        return _Resp(404, text="nope")

    def get(self, url, timeout=None, **kw):
        self.calls.append(("GET", url, None))
        if url.endswith("/artifacts"):
            return _Resp(200, {"artifacts": self.artifacts})
        return _Resp(404)


# --- B1/B4: upload via presigned PUT -----------------------------------------


def test_upload_input_uses_endpoint_and_http_put(monkeypatch):
    sess = _FakeSession()
    backend = PresignedURLBackend("http://api", sess)

    captured = {}

    def fake_request(method, url, data=None, headers=None, timeout=None):
        captured["method"] = method
        captured["url"] = url
        captured["bytes"] = data.read()
        return _Resp(200)

    monkeypatch.setattr("synergyplus.storage.requests.request", fake_request)

    with tempfile.NamedTemporaryFile("wb", suffix=".idf", delete=False) as fh:
        fh.write(b"IDF CONTENT")
        path = fh.name
    try:
        ref, digest = backend.upload_input(path, "models")
    finally:
        os.unlink(path)

    # POST /v1/uploads was called with the locally computed sha256 (B4).
    assert sess.calls[0][0] == "POST"
    assert sess.calls[0][1].endswith("/v1/uploads")
    assert sess.calls[0][2]["sha256"] == digest
    assert sess.calls[0][2]["kind"] == "model"
    # Bytes were PUT to the minted presigned URL (B1).
    assert captured["method"] == "PUT"
    assert captured["url"] == sess.minted_put_url
    assert captured["bytes"] == b"IDF CONTENT"
    assert ref.startswith("s3://models/uploads/")


def test_upload_input_missing_file():
    backend = PresignedURLBackend("http://api", _FakeSession())
    with pytest.raises(StorageError):
        backend.upload_input("/no/such/file.idf", "models")


def test_upload_input_bad_bucket():
    backend = PresignedURLBackend("http://api", _FakeSession())
    with tempfile.NamedTemporaryFile(delete=False) as fh:
        path = fh.name
    try:
        with pytest.raises(StorageError):
            backend.upload_input(path, "results")
    finally:
        os.unlink(path)


# --- B1: download via presigned GETs -----------------------------------------


def test_download_result_streams_artifacts(monkeypatch):
    sess = _FakeSession()
    sess.artifacts = [
        {"name": "eplusout.err", "url": "http://localhost:9000/results/h/eplusout.err?sig"},
        {"name": "synergy-summary.json", "url": "http://localhost:9000/results/h/synergy-summary.json?sig"},
    ]
    backend = PresignedURLBackend("http://api", sess)

    bodies = {
        "eplusout.err?sig": b"** no errors **",
        "synergy-summary.json?sig": b'{"site_eui": 1.0}',
    }

    def fake_get(url, stream=False, timeout=None, **kw):
        key = url.split("/")[-1]
        return _Resp(200, content=bodies[key])

    monkeypatch.setattr("synergyplus.storage.requests.get", fake_get)

    with tempfile.TemporaryDirectory() as d:
        paths = backend.download_result(ResultLocation("sim-1"), d)
        names = sorted(os.path.basename(p) for p in paths)
        assert names == ["eplusout.err", "synergy-summary.json"]
        with open(os.path.join(d, "synergy-summary.json")) as fh:
            assert "site_eui" in fh.read()


def test_download_result_no_artifacts():
    sess = _FakeSession()
    sess.artifacts = []
    backend = PresignedURLBackend("http://api", sess)
    with tempfile.TemporaryDirectory() as d:
        with pytest.raises(StorageError):
            backend.download_result(ResultLocation("sim-1"), d)


# --- B2: client selects the presigned backend when no S3 config --------------


def test_client_defaults_to_presigned(monkeypatch):
    for k in ("S3_ENDPOINT", "S3_ACCESS_KEY", "S3_SECRET_KEY"):
        monkeypatch.delenv(k, raising=False)
    c = SynergyClient("http://api", token="k")
    assert isinstance(c._storage, PresignedURLBackend)


def test_client_uses_direct_s3_when_configured(monkeypatch):
    for k in ("S3_ENDPOINT", "S3_ACCESS_KEY", "S3_SECRET_KEY"):
        monkeypatch.delenv(k, raising=False)
    from synergyplus import S3StorageBackend

    c = SynergyClient(
        "http://api", token="k",
        s3_endpoint="http://localhost:9000", s3_access_key="a", s3_secret_key="b",
    )
    assert isinstance(c._storage, S3StorageBackend)


def test_injected_backend_wins(monkeypatch):
    sentinel = PresignedURLBackend("http://api", _FakeSession())
    c = SynergyClient("http://api", token="k", storage=sentinel)
    assert c._storage is sentinel


# --- D3: live end-to-end with ONLY an API key --------------------------------


@pytest.mark.skipif(
    not os.environ.get("SP_LIVE_BASE_URL"),
    reason="set SP_LIVE_BASE_URL (+ SP_LIVE_TOKEN, SP_LIVE_MODEL, SP_LIVE_WEATHER) to run live",
)
def test_live_end_to_end():
    """API-key-only upload → run → download against a live stack (no S3 creds)."""
    base = os.environ["SP_LIVE_BASE_URL"]
    token = os.environ.get("SP_LIVE_TOKEN", "synergy-dev-key")
    model = os.environ["SP_LIVE_MODEL"]
    weather = os.environ["SP_LIVE_WEATHER"]

    # No S3 env / kwargs → must pick the presigned backend.
    for k in ("S3_ENDPOINT", "S3_ACCESS_KEY", "S3_SECRET_KEY"):
        os.environ.pop(k, None)
    sp = SynergyClient(base, token=token)
    assert isinstance(sp._storage, PresignedURLBackend)

    sim = sp.submit_simulation(engine_version="24.1.0", model=model, weather=weather)
    sp.wait(sim["id"], poll=2.0, deadline=600)
    with tempfile.TemporaryDirectory() as d:
        paths = sp.download_results(sim["id"], d)
        names = {os.path.basename(p) for p in paths}
        assert "synergy-summary.json" in names, names
    metrics = sp.get_metrics(sim["id"])
    assert "site_eui" in metrics
