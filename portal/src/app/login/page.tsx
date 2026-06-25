import { LoginForm } from "./LoginForm";
import { Logo } from "@/components/Logo";
import { ThemeToggle } from "@/components/ThemeToggle";
import { ALLOWED_DOMAINS, allowedDomainsLabel, env } from "@/lib/env";

export default function LoginPage() {
  const domainsLabel = allowedDomainsLabel(ALLOWED_DOMAINS);
  return (
    <main className="relative grid min-h-screen place-items-center overflow-hidden px-4">
      {/* ambient glow */}
      <div
        aria-hidden
        className="pointer-events-none absolute left-1/2 top-0 h-[420px] w-[720px] -translate-x-1/2 rounded-full bg-brand/15 blur-[120px]"
      />
      <div className="absolute right-5 top-5">
        <ThemeToggle />
      </div>

      <div className="relative w-full max-w-md">
        <div className="mb-8 flex flex-col items-center text-center">
          <Logo className="mb-5 scale-110" />
          <h1 className="text-2xl font-semibold tracking-tight">
            Developer Portal
          </h1>
          <p className="mt-2 text-sm text-muted">
            Sign in to manage API keys and run simulations.
          </p>
        </div>

        <div className="rounded-2xl border border-border bg-panel p-6 shadow-2xl shadow-black/20">
          <LoginForm devLoginEnabled={env.devLoginEnabled} allowedDomains={ALLOWED_DOMAINS} />
        </div>

        {domainsLabel && (
          <p className="mt-5 text-center text-xs text-muted">
            Access is restricted to{" "}
            <span className="font-medium text-fg">{domainsLabel}</span> accounts.
          </p>
        )}
      </div>
    </main>
  );
}
