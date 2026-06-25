"""SynergyPlus Python SDK (CONTRACT §3).

    from synergyplus import SynergyClient, ArtifactRef

    sp = SynergyClient("http://localhost:8090", token="synergy-dev-key")
    sim = sp.submit_simulation(
        engine_version="24.1.0",
        model=ArtifactRef("s3://models/sample/baseline.idf"),
        weather=ArtifactRef("s3://weather/sample/chicago.epw"),
    )
    sp.wait(sim["id"])
    print(sp.get_results(sim["id"]))
"""

from .client import SynergyClient
from .models import ArtifactRef, Variant, sha256_file

__all__ = ["SynergyClient", "ArtifactRef", "Variant", "sha256_file"]
__version__ = "0.2.0"
