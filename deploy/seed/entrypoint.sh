#!/usr/bin/env sh
# Thin seed entrypoint: install deps if needed, then run the idempotent seeder.
set -e
exec python /app/seed.py
