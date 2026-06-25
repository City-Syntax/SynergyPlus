# SynergyPlus Runner — real EnergyPlus image.
#
# Layers the Python pull-loop Runner on top of NREL's official EnergyPlus image
# so it actually invokes the `energyplus` binary. Build & tag per engine version:
#
#   docker build --build-arg EPLUS_VERSION=24.1.0 \
#     -t ghcr.io/synergyplus/energyplus-runner:24.1.0 runner/
#
# The base image already puts `energyplus` on PATH. We add python3 + pip and the
# synergy_runner package (psycopg + boto3) on top.
ARG EPLUS_VERSION=24.1.0
FROM nrel/energyplus:${EPLUS_VERSION}

# The NREL image is Ubuntu-based but ships no Python. Install a runtime Python.
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-pip python3-venv \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/runner

# Install deps/package. Copy metadata first for layer caching, then the package.
COPY pyproject.toml README.md LICENSE /opt/runner/
COPY synergy_runner /opt/runner/synergy_runner
RUN pip3 install --no-cache-dir --break-system-packages /opt/runner

# Fail the build fast if the engine isn't on PATH.
RUN command -v energyplus

ENV SP_WORKSPACE=/tmp/synergy-runner
ENTRYPOINT ["synergy-runner"]
