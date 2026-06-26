"""Pin storage._resolve_bucket: logical bucket names map to configured buckets.

Refs are stored with LOGICAL bucket names (``s3://models/...``) so a row works
in any environment. The runner must rewrite that netloc to the configured real
bucket (``synergyplus-models-…`` on AWS) — using the netloc literally made
``s3://models/...`` hit a third-party bucket named ``models`` and fail with 403
in production. This test guards that mapping.

Like test_content_hash_vectors, it AST-extracts the function from storage.py
rather than importing the package (synergy_runner/__init__ pulls in psycopg2),
so it runs under plain python3 with no third-party deps.
"""

from __future__ import annotations

import ast
import os
from types import SimpleNamespace

_RUNNER_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_STORAGE_PATH = os.path.join(_RUNNER_ROOT, "synergy_runner", "storage.py")


def _load_resolve_bucket():
    with open(_STORAGE_PATH, encoding="utf-8") as fh:
        tree = ast.parse(fh.read(), filename=_STORAGE_PATH)
    for node in tree.body:
        if isinstance(node, ast.FunctionDef) and node.name == "_resolve_bucket":
            module = ast.Module(body=[node], type_ignores=[])
            ns: dict = {}
            # RunnerConfig appears only in the (string, unused) annotations; bind
            # it to a dummy so exec'ing the lone def doesn't NameError.
            exec(  # noqa: S102 - executing trusted in-repo source under test
                compile(module, _STORAGE_PATH, "exec"),
                {"RunnerConfig": object},
                ns,
            )
            return ns["_resolve_bucket"]
    raise AssertionError(f"_resolve_bucket not found in {_STORAGE_PATH}")


_resolve_bucket = _load_resolve_bucket()


def test_logical_names_map_to_configured_buckets():
    cfg = SimpleNamespace(
        bucket_models="synergyplus-models-X",
        bucket_weather="synergyplus-weather-Y",
        bucket_results="synergyplus-results-Z",
    )
    assert _resolve_bucket("models", cfg) == "synergyplus-models-X"
    assert _resolve_bucket("weather", cfg) == "synergyplus-weather-Y"
    assert _resolve_bucket("results", cfg) == "synergyplus-results-Z"


def test_real_bucket_name_passes_through():
    cfg = SimpleNamespace(
        bucket_models="synergyplus-models-X",
        bucket_weather="synergyplus-weather-Y",
        bucket_results="synergyplus-results-Z",
    )
    # A netloc that is already a real bucket (e.g. minted by the apiserver upload
    # endpoint) is not a logical name and must be used verbatim.
    assert _resolve_bucket("synergyplus-models-X", cfg) == "synergyplus-models-X"
    assert _resolve_bucket("some-other-bucket", cfg) == "some-other-bucket"


def test_local_identity_mapping():
    # Locally (MinIO) the configured buckets ARE the logical names, so the map
    # is an identity and the local/OrbStack flow is unaffected.
    cfg = SimpleNamespace(
        bucket_models="models", bucket_weather="weather", bucket_results="results"
    )
    assert _resolve_bucket("models", cfg) == "models"
    assert _resolve_bucket("weather", cfg) == "weather"
    assert _resolve_bucket("results", cfg) == "results"


if __name__ == "__main__":
    test_logical_names_map_to_configured_buckets()
    test_real_bucket_name_passes_through()
    test_local_identity_mapping()
    print("OK: _resolve_bucket mapping verified")
