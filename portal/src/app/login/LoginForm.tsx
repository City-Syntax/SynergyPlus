"use client";

import { useState } from "react";
import { authClient } from "@/lib/auth-client";
import { allowedDomainsLabel } from "@/lib/allowed-domains";

type DevLink = { url: string; token: string };

export function LoginForm({
  devLoginEnabled,
  allowedDomains,
}: {
  devLoginEnabled: boolean;
  allowedDomains: string[];
}) {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [devLink, setDevLink] = useState<DevLink | null>(null);

  const domainsLabel = allowedDomainsLabel(allowedDomains);

  function clientDomainOk(value: string): boolean {
    const domain = value.split("@")[1]?.toLowerCase();
    return !!domain && allowedDomains.includes(domain);
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setDevLink(null);

    const trimmed = email.trim().toLowerCase();
    if (!clientDomainOk(trimmed)) {
      setStatus("error");
      setError(
        domainsLabel
          ? `Please use an ${domainsLabel} email address.`
          : "Please use an approved work email address.",
      );
      return;
    }

    setStatus("sending");
    const { error: signInError } = await authClient.signIn.magicLink({
      email: trimmed,
      callbackURL: "/dashboard",
    });

    if (signInError) {
      setStatus("error");
      setError(
        signInError.message ||
          "Could not send a sign-in link. Please try again.",
      );
      return;
    }

    setStatus("sent");

    // Dev only: pull the just-generated link so testing needs no mailbox.
    if (devLoginEnabled) {
      try {
        const res = await fetch(
          `/api/dev/last-link?email=${encodeURIComponent(trimmed)}`,
        );
        const data = await res.json();
        if (data?.link?.url) {
          setDevLink({ url: data.link.url, token: data.link.token });
        }
      } catch {
        /* non-fatal */
      }
    }
  }

  if (status === "sent") {
    return (
      <div className="text-center">
        <div className="mx-auto mb-4 grid h-12 w-12 place-items-center rounded-full bg-brand/15 text-brand">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <rect x="2" y="4" width="20" height="16" rx="2" />
            <path d="m22 7-10 5L2 7" />
          </svg>
        </div>
        <h2 className="text-base font-semibold">Check your inbox</h2>
        <p className="mt-1.5 text-sm text-muted">
          We sent a magic sign-in link to{" "}
          <span className="font-medium text-fg">{email.trim().toLowerCase()}</span>.
        </p>

        {devLink && (
          <div className="mt-5 rounded-xl border border-amber-500/30 bg-amber-500/10 p-4 text-left">
            <div className="mb-1.5 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-amber-400">
              <span className="grid h-4 w-4 place-items-center rounded-full bg-amber-500/20">!</span>
              Dev mode
            </div>
            <p className="mb-3 text-xs text-muted">
              No email is sent locally. The link below was also printed to the
              server console.
            </p>
            <a
              href={devLink.url}
              className="block w-full rounded-lg bg-brand px-3 py-2.5 text-center text-sm font-medium text-brand-fg transition hover:opacity-90"
            >
              Sign in now →
            </a>
          </div>
        )}

        <button
          type="button"
          onClick={() => {
            setStatus("idle");
            setDevLink(null);
          }}
          className="mt-5 text-xs text-muted underline-offset-2 hover:text-fg hover:underline"
        >
          Use a different email
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <div>
        <label htmlFor="email" className="mb-1.5 block text-sm font-medium">
          Work email
        </label>
        <input
          id="email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder={`you@${allowedDomains[0] ?? "example.org"}`}
          className="w-full rounded-lg border border-border bg-panel-2 px-3.5 py-2.5 text-sm text-fg outline-none transition placeholder:text-muted focus:border-brand focus:ring-2 focus:ring-brand/30"
        />
      </div>

      {error && (
        <p className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-400">
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={status === "sending"}
        className="w-full rounded-lg bg-brand px-3 py-2.5 text-sm font-semibold text-brand-fg transition hover:opacity-90 disabled:opacity-60"
      >
        {status === "sending" ? "Sending link…" : "Send magic link"}
      </button>
    </form>
  );
}
