"""SynergyPlus Python SDK (CONTRACT §3).

    from synergyplus import SynergyClient

    sp = SynergyClient(
        "http://localhost:8090", token="synergy-dev-key",
        s3_endpoint="http://localhost:9000",
        s3_access_key="synergy", s3_secret_key="synergypass",
    )
    sim = sp.submit_simulation(
        engine_version="24.1.0",
        model="./tower.idf",        # local path → uploaded automatically
        weather="./chicago.epw",
    )
    sp.wait(sim["id"])
    sp.download_results(sim["id"], "./out")
    print(sp.get_metrics(sim["id"]))

``model``/``weather`` also accept ``s3://...`` strings and :class:`ArtifactRef`.
"""

from .client import SynergyClient
from .models import ArtifactRef, Variant, is_local_path, sha256_file
from .storage import (
    PresignedURLBackend,
    ResultLocation,
    S3StorageBackend,
    StorageBackend,
    StorageError,
)

__all__ = [
    "SynergyClient",
    "ArtifactRef",
    "Variant",
    "sha256_file",
    "is_local_path",
    "StorageBackend",
    "S3StorageBackend",
    "PresignedURLBackend",
    "ResultLocation",
    "StorageError",
]
__version__ = "0.6.4"
