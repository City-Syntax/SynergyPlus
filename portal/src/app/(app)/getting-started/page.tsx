import { apiBaseUrlPublic } from "@/lib/env";
import { CodeBlock } from "@/components/CodeBlock";

export default function GettingStartedPage() {
  const api = apiBaseUrlPublic;

  const curlSubmit = `curl -X POST ${api}/v1/simulations \\
  -H "Authorization: Bearer $SYNERGY_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "engineVersion": "24.1.0",
    "model":   { "ref": "s3://models/sample.idf",   "sha256": "<model_sha256>" },
    "weather": { "ref": "s3://weather/sample.epw",   "sha256": "<weather_sha256>" },
    "priority": 1
  }'`;

  const curlStatus = `# Poll a simulation until it finishes
curl ${api}/v1/simulations/<id> \\
  -H "Authorization: Bearer $SYNERGY_API_KEY"

# Fetch extracted metrics + artifact when done
curl ${api}/v1/results/<id> \\
  -H "Authorization: Bearer $SYNERGY_API_KEY"`;

  const pySubmit = `from synergyplus import SynergyClient  # pip install synergyplus

# API key only — local files upload automatically via presigned URLs
# (no S3 credentials needed).
sp = SynergyClient("${api}", token="sp_live_...")   # or env SYNERGY_API_KEY

# Pass local paths: the SDK uploads them for you, content-addressed by
# sha256 (an identical file already on the platform is a cache hit).
sim = sp.submit_simulation(
    engine_version="24.1.0",
    model="./tower.idf",        # local path → uploaded automatically
    weather="./chicago.epw",    # local path → uploaded automatically
    priority=1,
)
print("submitted:", sim["id"], sim["state"])

sp.wait(sim["id"])                       # blocks until succeeded/failed
print(sp.get_metrics(sim["id"])["site_eui"])

sp.download_results(sim["id"], "./out")  # pull artifacts (.csv, .err, ...) locally`;

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

  return (
    <div className="space-y-9">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Getting Started</h1>
        <p className="mt-1.5 text-sm text-muted">
          Submit EnergyPlus simulations to the SynergyPlus API in a few lines.
          Every request authenticates with an API key as a{" "}
          <code className="rounded bg-panel-2 px-1 py-0.5 font-mono text-xs">
            Bearer
          </code>{" "}
          token.
        </p>
      </header>

      <Section
        step="1"
        title="Create an API key"
        body="Head to API Keys → Create key. Copy the raw key (shown once) and export it."
      >
        <CodeBlock
          title="shell"
          code={`export SYNERGY_API_KEY="sp_live_..."`}
        />
      </Section>

      <Section
        step="2"
        title="Check connectivity"
        body="The health endpoint needs no auth — use it to confirm the API base URL."
      >
        <CodeBlock title="shell" code={`curl ${api}/healthz\n# → 200 ok`} />
      </Section>

      <Section
        step="3"
        title="Submit a simulation (curl)"
        body="POST /v1/simulations returns 201 with the simulation id and state. The model/weather sha256 feed the content-addressed result cache (a cache hit returns instantly)."
      >
        <CodeBlock title="shell" code={curlSubmit} />
      </Section>

      <Section
        step="4"
        title="Poll status & fetch results (curl)"
        body="Statuses move queued → running → succeeded | failed. Results carry the verdict, Core Metrics, and an artifact URI."
      >
        <CodeBlock title="shell" code={curlStatus} />
      </Section>

      <Section
        step="5"
        title="Python SDK"
        body="Point the SDK at local .idf/.epw files — it uploads them for you (presigned URLs, just your API key) and wraps submit / wait / results so you can script sweeps end-to-end."
      >
        <div className="space-y-4">
          <CodeBlock title="python — single run" code={pySubmit} />
          <CodeBlock title="python — batch sweep" code={pyBatch} />
        </div>
      </Section>

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
