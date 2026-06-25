# SynergyPlus demo seeder — waits for Postgres+MinIO, creates buckets,
# uploads sample inputs, inserts the demo user + dev API key. Idempotent.
FROM python:3.12-slim

WORKDIR /app
COPY requirements.txt /app/
RUN pip install --no-cache-dir -r requirements.txt

COPY seed.py entrypoint.sh /app/
COPY sample /app/sample
RUN chmod +x /app/entrypoint.sh

ENTRYPOINT ["/app/entrypoint.sh"]
