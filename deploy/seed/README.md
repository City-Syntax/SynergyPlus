# Demo seeder (`deploy/seed`)

Idempotent one-shot that prepares a local SynergyPlus demo. Run after Postgres
(schema applied by the apiserver) and MinIO are up.

It:
1. Waits for Postgres + MinIO.
2. Creates buckets `models`, `weather`, `results`.
3. Uploads the sample inputs to the **exact refs** the smoke test / SDK examples use:
   - `s3://models/sample/baseline.idf`
   - `s3://weather/sample/chicago.epw`
4. Inserts demo user `demo@urbanflow.co` and the dev API key **`synergy-dev-key`**
   (stored as `key_hash = sha256_hex("synergy-dev-key")`, the same scheme the Go
   apiserver validates).

Re-runnable safely (every step is create-if-missing / `ON CONFLICT DO NOTHING`).

## Run

```bash
pip install -r deploy/seed/requirements.txt
export DATABASE_URL="postgres://synergy:synergy@localhost:5432/synergy?sslmode=disable"
export S3_ENDPOINT="http://localhost:9000" S3_REGION=us-east-1
export S3_ACCESS_KEY=synergy S3_SECRET_KEY=synergypass
python deploy/seed/seed.py
```

Or via Docker: `docker build -t synergyplus/seed deploy/seed && docker run --rm \
  -e DATABASE_URL=... -e S3_ENDPOINT=... synergyplus/seed`.

The sample inputs are **real and validated for EnergyPlus 24.1.0**:
- `baseline.idf` — the upstream EnergyPlus ExampleFile `1ZoneUncontrolled.idf`
  (shipped in `nrel/energyplus:24.1.0` at `/var/simdata`), with
  `Output:SQLite,SimpleAndTabular;` appended so the run emits `eplusout.sql` with
  the `AnnualBuildingUtilityPerformanceSummary` the Runner extracts.
- `chicago.epw` — the canonical `USA_IL_Chicago-OHare.Intl.AP.725300_TMY3` full
  8760-hour weather file.

A real `energyplus -w chicago.epw -d out/ -r baseline.idf` completes in <1s and
yields non-null Core Metrics (verified: site_eui 354.82, source_eui 1123.7,
total_site_energy 82.41 GJ, total_source_energy 260.99 GJ).
```
Dev API key:  synergy-dev-key
Model ref:    s3://models/sample/baseline.idf
Weather ref:  s3://weather/sample/chicago.epw
```
