import { LoginForm } from "./LoginForm";
import { Logo } from "@/components/Logo";
import { ALLOWED_DOMAINS, allowedDomainsLabel, env } from "@/lib/env";

// Render at request time, not build time. ALLOWED_DOMAINS comes from the runtime
// env (ALLOWED_EMAIL_DOMAINS); if this page is statically prerendered during the
// CI image build — where that env var is unset — the allow-list bakes in EMPTY,
// and the client form then rejects every address ("approved work email"). Forcing
// dynamic rendering makes it read the real value from the pod at request time.
export const dynamic = "force-dynamic";

export default function LoginPage() {
  const domainsLabel = allowedDomainsLabel(ALLOWED_DOMAINS);
  return (
    <main className="grid min-h-screen place-items-center px-4">
      <div className="w-full max-w-md">
        <div className="mb-8 flex flex-col items-center text-center">
          <Logo className="mb-5 scale-110" />
          <h1 className="header-xlarge">Developer Portal</h1>
          <p className="mt-2 text-body-large text-text-secondary">
            Sign in to manage API keys and run simulations.
          </p>
        </div>

        <div className="rounded-modal bg-surface p-6 shadow-modal">
          <LoginForm devLoginEnabled={env.devLoginEnabled} allowedDomains={ALLOWED_DOMAINS} />
        </div>

        {domainsLabel && (
          <p className="mt-5 text-center text-body-medium text-text-secondary">
            Access is restricted to{" "}
            <span className="font-medium text-text">{domainsLabel}</span>{" "}
            accounts.
          </p>
        )}
      </div>
    </main>
  );
}
