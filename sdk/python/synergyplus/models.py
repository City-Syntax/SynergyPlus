"""Lightweight request/response models for the SynergyPlus API (CONTRACT §3)."""

from __future__ import annotations

import hashlib
import os
from dataclasses import dataclass
from typing import Optional, Union


@dataclass
class ArtifactRef:
    """A model or weather blob in object storage (``s3://bucket/key``).

    ``sha256`` feeds the deterministic content hash (CONTRACT §2.1). If you have
    the local file, use :meth:`from_file` to compute it.
    """

    ref: str
    sha256: Optional[str] = None

    def to_dict(self) -> dict:
        d = {"ref": self.ref}
        if self.sha256:
            d["sha256"] = self.sha256
        return d

    @classmethod
    def from_file(cls, ref: str, local_path: str) -> "ArtifactRef":
        """Build a ref whose sha256 is hashed from a local copy of the object."""
        return cls(ref=ref, sha256=sha256_file(local_path))


def sha256_file(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def as_ref(value: Union[str, ArtifactRef], sha256: Optional[str] = None) -> dict:
    """Accept either a bare ``s3://`` string or an :class:`ArtifactRef`."""
    if isinstance(value, ArtifactRef):
        return value.to_dict()
    return ArtifactRef(ref=value, sha256=sha256).to_dict()


def is_local_path(value: Union[str, ArtifactRef]) -> bool:
    """True if *value* is a local filesystem path that should be uploaded.

    An :class:`ArtifactRef` or any ``<scheme>://`` URI (``s3://``, ``https://``)
    is treated as an existing object reference — never a local path. Everything
    else (``./tower.idf``, ``/abs/path.idf``, ``model.idf``) is a local path.
    """
    if isinstance(value, ArtifactRef):
        return False
    if not isinstance(value, str):
        return False
    # A URI scheme like "s3" or "https" means it is already a storage ref.
    return "://" not in value


@dataclass
class Variant:
    """One model variant in a batch submission."""

    model: Union[str, ArtifactRef]
    name: Optional[str] = None

    def to_dict(self) -> dict:
        d: dict = {"model": as_ref(self.model)}
        if self.name:
            d["name"] = self.name
        return d
