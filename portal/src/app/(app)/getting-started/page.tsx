import { apiBaseUrlPublic } from "@/lib/env";
import { CodeBlock } from "@/components/CodeBlock";

export default function GettingStartedPage() {
  const api = apiBaseUrlPublic;

  // --- Python: the primary path ------------------------------------------
  // The same run shown two ways. In a notebook a bare trailing expression
  // renders inline; in a script you print and guard __main__.
  const pyNotebook = `# Cell 1 — install the SDK into this kernel (run once)
%pip install synergyplus

# Cell 2 — connect. API key only: local files upload via presigned URLs,
# so there are no S3 credentials to manage.
from synergyplus import SynergyClient

sp = SynergyClient("${api}", token="sp_live_...")
sp.healthz()          # True once the API is reachable

# Cell 3 — submit a local model + weather, then block until it finishes.
sim = sp.submit_simulation(
    engine_version="24.1.0",
    model="./baseline.idf",     # local path → uploaded for you
    weather="./chicago.epw",
    priority=1,
)
sp.wait(sim["id"])              # queued → running → succeeded
sim["id"]

# Cell 4 — a bare expression renders inline, so the metrics show as a dict.
sp.get_metrics(sim["id"])
# {'site_eui': 354.82, 'source_eui': 1123.7,
#  'total_site_energy': 82.41, 'total_source_energy': 260.99,
#  'unmet_heating_hours': 0, 'unmet_cooling_hours': 0, 'run_seconds': 1.907}

# Cell 5 — pull the raw artifacts (.err, .csv, .sql, …) beside the notebook.
sp.download_results(sim["id"], "./out")`;

  const pyScript = `"""run_simulation.py — submit one EnergyPlus run and report its metrics."""
import os

from synergyplus import SynergyClient


def main() -> None:
    # API key only — the SDK uploads local files via presigned URLs (no S3 creds).
    sp = SynergyClient("${api}", token=os.environ["SYNERGY_API_KEY"])

    sim = sp.submit_simulation(
        engine_version="24.1.0",
        model="./baseline.idf",     # local path → uploaded automatically
        weather="./chicago.epw",
        priority=1,
    )
    print("submitted:", sim["id"], sim["state"])

    sp.wait(sim["id"])              # blocks until succeeded / failed
    metrics = sp.get_metrics(sim["id"])
    print("site EUI:", metrics["site_eui"])

    sp.download_results(sim["id"], "./out")   # artifacts → ./out


if __name__ == "__main__":
    main()`;

  const pyScriptRun = `export SYNERGY_API_KEY="sp_live_..."
python run_simulation.py
# submitted: afc98645-… queued
# site EUI: 354.82`;

  const pyBatch = `from synergyplus import Variant

# A parameter sweep as one batch — variant models can be local paths too.
# A model repeated across variants is hashed + uploaded only once.
batch = sp.submit_batch(
    engine_version="24.1.0",
    weather="./chicago.epw",
    variants=[Variant(model=f"./variants/v{i}.idf", name=f"v{i}") for i in range(20)],
    priority=1,
    idempotency_key="sweep-2026-06-24",
)
print(batch["batchId"], batch["state"])

status = sp.get_batch(batch["batchId"])
print(f'{status["succeeded"]}/{status["total"]} done, {status["failed"]} failed')`;

  // --- REST: only when you're not in Python ------------------------------
  const curlSubmit = `# Inputs are referenced by object-storage URI + sha256. Upload them first
# (the Python SDK does this for you from a local path).
curl -X POST ${api}/v1/simulations \\
  -H "Authorization: Bearer $SYNERGY_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "engineVersion": "24.1.0",
    "model":   { "ref": "s3://models/sample.idf",  "sha256": "<model_sha256>" },
    "weather": { "ref": "s3://weather/sample.epw",  "sha256": "<weather_sha256>" },
    "priority": 1
  }'`;

  const curlStatus = `# Poll a simulation until it reaches a terminal state
curl ${api}/v1/simulations/<id> \\
  -H "Authorization: Bearer $SYNERGY_API_KEY"

# Fetch the verdict, Core Metrics, and artifact URI when done
curl ${api}/v1/results/<id> \\
  -H "Authorization: Bearer $SYNERGY_API_KEY"`;

  return (
    <div className="space-y-9">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Getting Started</h1>
        <p className="mt-1.5 text-sm text-muted">
          Run EnergyPlus simulations from Python in a few lines. The{" "}
          <code className="rounded bg-panel-2 px-1 py-0.5 font-mono text-xs">
            synergyplus
          </code>{" "}
          SDK uploads your local{" "}
          <code className="font-mono">.idf</code>/<code className="font-mono">.epw</code>{" "}
          files and pulls results back with just an API key — no S3 credentials.
          Not in Python? The same API is one{" "}
          <code className="rounded bg-panel-2 px-1 py-0.5 font-mono text-xs">
            curl
          </code>{" "}
          away.
        </p>
      </header>

      <Section
        step="1"
        title="Create an API key"
        body="Head to API Keys → Create key. Copy the raw key (shown once) and export it so the SDK and curl can read it."
      >
        <CodeBlock title="shell" code={`export SYNERGY_API_KEY="sp_live_..."`} />
      </Section>

      <Section
        step="2"
        title="Install the SDK"
        body="The default backend is API-key-only and uses plain HTTP — no boto3, no S3 credentials. Requires Python 3.9+."
      >
        <CodeBlock title="shell" code={`pip install synergyplus`} />
      </Section>

      <Section
        step="3"
        title="Run your first simulation"
        body="Point the SDK at local .idf/.epw files — it uploads them via presigned URLs and wraps submit → wait → results. Here is the same run two ways: an interactive notebook, then a runnable script."
      >
        <div className="space-y-4">
          <CodeBlock title="python — notebook (Jupyter)" code={pyNotebook} />
          <CodeBlock title="python — script (run_simulation.py)" code={pyScript} />
          <CodeBlock title="shell — run the script" code={pyScriptRun} />
        </div>
      </Section>

      <Section
        step="4"
        title="Sweep parameters as a batch"
        body="Submit a parametric set of variants as one Batch and track it as a unit. A model reused across variants is content-addressed, so it uploads only once."
      >
        <CodeBlock title="python — batch sweep" code={pyBatch} />
      </Section>

      <section className="space-y-3 rounded-xl border border-border bg-panel p-5">
        <div>
          <h2 className="text-base font-semibold">Not using Python? Call the REST API directly</h2>
          <p className="mt-1 text-sm leading-relaxed text-muted">
            Every endpoint is plain HTTP with a{" "}
            <code className="font-mono">Bearer</code> token, so any language
            works. The SDK is just a wrapper over these calls — reach for{" "}
            <code className="font-mono">curl</code> only when you are not in
            Python. (Check connectivity any time with{" "}
            <code className="font-mono">curl {api}/healthz</code>, which needs no
            auth.)
          </p>
        </div>
        <div className="space-y-4">
          <CodeBlock title="shell — submit" code={curlSubmit} />
          <CodeBlock title="shell — poll & fetch results" code={curlStatus} />
        </div>
      </section>

      <div className="rounded-xl border border-border bg-panel p-5">
        <h3 className="text-sm font-semibold">Core Metrics you get back</h3>
        <p className="mt-1.5 text-xs leading-relaxed text-muted">
          Every result includes{" "}
          <code className="font-mono">site_eui</code>,{" "}
          <code className="font-mono">source_eui</code>,{" "}
          <code className="font-mono">total_site_energy</code>,{" "}
          <code className="font-mono">total_source_energy</code>,{" "}
          <code className="font-mono">unmet_heating_hours</code>,{" "}
          <code className="font-mono">unmet_cooling_hours</code>, and{" "}
          <code className="font-mono">run_seconds</code>. Add an{" "}
          <code className="font-mono">extractionSpec</code> to pull more.
        </p>
      </div>
    </div>
  );
}

function Section({
  step,
  title,
  body,
  children,
}: {
  step: string;
  title: string;
  body: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full bg-brand/15 text-xs font-semibold text-brand">
          {step}
        </span>
        <div>
          <h2 className="text-base font-semibold">{title}</h2>
          <p className="mt-1 text-sm leading-relaxed text-muted">{body}</p>
        </div>
      </div>
      <div className="pl-9">{children}</div>
    </section>
  );
}
