"""Shared-vector test pinning the Runner's content_hash (CONTRACT §2.1).

This loads the SAME testdata/content_hash_vectors.json that the Go suite
(internal/queue/content_hash_vectors_test.go) asserts against, so the two
independent implementations of the content hash cannot silently diverge. A
one-byte drift in either makes the Runner write results under a key the API
never looks up; this test turns that into a build failure on the Python side.

content_hash depends only on hashlib (stdlib), so this test runs with plain
``python3`` even without third-party deps installed.
"""

from __future__ import annotations

import ast
import json
import os

_RUNNER_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_LOOP_PATH = os.path.join(_RUNNER_ROOT, "synergy_runner", "loop.py")

# Repo root is two levels up from runner/tests/ -> testdata lives at the root.
_REPO_ROOT = os.path.dirname(_RUNNER_ROOT)
_VECTORS_PATH = os.path.join(_REPO_ROOT, "testdata", "content_hash_vectors.json")


def _load_content_hash():
    """Load content_hash straight from loop.py without importing the package.

    Importing synergy_runner.loop drags in db.py, which requires psycopg
    (third-party). content_hash itself only needs hashlib, so we extract the
    function definition from the source via AST and exec it in an isolated
    namespace. This keeps the shared-vector test runnable with plain python3 in
    any environment, while still pinning it to the *actual* source of
    content_hash in loop.py.
    """
    with open(_LOOP_PATH, encoding="utf-8") as fh:
        tree = ast.parse(fh.read(), filename=_LOOP_PATH)
    for node in tree.body:
        if isinstance(node, ast.FunctionDef) and node.name == "content_hash":
            module = ast.Module(body=[node], type_ignores=[])
            ns: dict = {}
            exec(  # noqa: S102 - executing trusted in-repo source under test
                compile(module, _LOOP_PATH, "exec"),
                {"hashlib": __import__("hashlib")},
                ns,
            )
            return ns["content_hash"]
    raise AssertionError(f"content_hash not found in {_LOOP_PATH}")


content_hash = _load_content_hash()


def _load_vectors():
    with open(_VECTORS_PATH, encoding="utf-8") as fh:
        vectors = json.load(fh)
    assert vectors, f"no vectors found in {_VECTORS_PATH}"
    return vectors


def test_content_hash_matches_shared_vectors():
    for v in _load_vectors():
        got = content_hash(v["model_sha256"], v["weather_sha256"], v["engine_version"])
        assert got == v["expected"], (
            f"vector {v.get('name')!r}: content_hash("
            f"{v['model_sha256']!r}, {v['weather_sha256']!r}, {v['engine_version']!r})"
            f" = {got!r}, want {v['expected']!r}"
        )


if __name__ == "__main__":
    # Allow running with plain `python3 runner/tests/test_content_hash_vectors.py`
    # when pytest is not available in the environment.
    test_content_hash_matches_shared_vectors()
    print(f"OK: {len(_load_vectors())} content-hash vectors matched")
