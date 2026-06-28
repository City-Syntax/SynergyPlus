# SynergyPlus Runner — real EnergyPlus, multi-arch (arm64 + amd64).
#
# Built on ubuntu:22.04 (multi-arch; ships Python 3.10 — no deadsnakes needed) with
# the architecture-matched official EnergyPlus release. Builds NATIVELY on Apple
# Silicon / arm64 (OrbStack) AND on amd64 (EKS) — Docker selects the base image arch
# and TARGETARCH picks the matching EnergyPlus tarball.
#
#   docker build -t ghcr.io/city-syntax/synergyplus-runner:24.1.0 runner/
#
# For another EnergyPlus version, pass its version AND release commit sha:
#   --build-arg EPLUS_VERSION=24.2.0 --build-arg EPLUS_SHA=<sha>
FROM ubuntu:22.04

ARG EPLUS_VERSION=24.1.0
ARG EPLUS_SHA=9d7789a3ac
ARG TARGETARCH
ENV DEBIAN_FRONTEND=noninteractive

# Runtime + build deps. Ubuntu 22.04's python3 is 3.10 (>=3.9), so no deadsnakes.
# libgomp1 (OpenMP) + libpq5 (psycopg) are EnergyPlus/driver runtime requirements.
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends \
        python3 python3-pip ca-certificates wget \
        libgomp1 libpq5 libx11-6 libxext6; \
    rm -rf /var/lib/apt/lists/*

# Install the architecture-matched EnergyPlus release.
RUN set -eux; \
    case "${TARGETARCH}" in \
      arm64) EPARCH=arm64 ;; \
      amd64) EPARCH=x86_64 ;; \
      *) echo "unsupported TARGETARCH=${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    base="EnergyPlus-${EPLUS_VERSION}-${EPLUS_SHA}-Linux-Ubuntu22.04-${EPARCH}"; \
    wget -q "https://github.com/NREL/EnergyPlus/releases/download/v${EPLUS_VERSION}/${base}.tar.gz" \
        -O /tmp/ep.tar.gz; \
    mkdir -p /opt/energyplus; \
    tar -xzf /tmp/ep.tar.gz -C /opt/energyplus --strip-components=1; \
    rm /tmp/ep.tar.gz; \
    ln -s /opt/energyplus/energyplus /usr/local/bin/energyplus

WORKDIR /opt/runner
COPY . /opt/runner
# Ubuntu 22.04 ships pip 22.0.2, which mis-parses modern PEP 621 / SPDX metadata and
# builds an empty "UNKNOWN-0.0.0" wheel (no deps, no console script). Upgrade first.
RUN python3 -m pip install --no-cache-dir --upgrade pip setuptools wheel \
 && python3 -m pip install --no-cache-dir /opt/runner

# Fail the build fast if the engine or entrypoint isn't wired up.
RUN command -v energyplus \
 && energyplus --version \
 && python3 -c "import synergy_runner" \
 && command -v synergy-runner

ENV SP_WORKSPACE=/tmp/synergy-runner

# Run as non-root (audit #7): the runner executes the EnergyPlus C++ engine on
# user-supplied .idf/.epw files, so a parser memory-safety bug must not become
# root-in-container. A numeric UID lets Kubernetes enforce runAsNonRoot. All the
# privileged build steps above (apt, pip, the self-check) run as root before this
# switch; the runner only needs to read its installed package and write the
# workspace it owns below.
RUN useradd --system --no-log-init --create-home --uid 10001 runner \
 && mkdir -p "${SP_WORKSPACE}" \
 && chown runner:runner "${SP_WORKSPACE}"
USER 10001
ENTRYPOINT ["synergy-runner"]
