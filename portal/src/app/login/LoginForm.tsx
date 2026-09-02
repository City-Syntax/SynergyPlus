"use client";

import { useState } from "react";
import { authClient } from "@/lib/auth-client";
import { BUTTON_LINK, BUTTON_PRIMARY, INPUT_TEXT } from "@/components/ui";
import { allowedDomainsLabel, isEmailDomainAllowed } from "@/lib/allowed-domains";

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
    return isEmailDomainAllowed(value, allowedDomains);
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
        <div className="mx-auto mb-4 grid h-12 w-12 place-items-center rounded-full bg-surface-success text-icon-success">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <rect x="2" y="4" width="20" height="16" rx="2" />
            <path d="m22 7-10 5L2 7" />
          </svg>
        </div>
        <h2 className="header-normal">Check your inbox</h2>
        <p className="mt-1.5 text-body-large text-text-secondary">
          We sent a magic sign-in link to{" "}
          <span className="font-medium text-text">{email.trim().toLowerCase()}</span>.
        </p>

        {devLink && (
          <div className="mt-5 rounded-card bg-surface-warning p-4 text-left">
            <div className="mb-1.5 flex items-center gap-2 header-subtitle uppercase tracking-wide text-text-warning">
              <span className="grid h-4 w-4 place-items-center rounded-full bg-fill-warning-secondary">!</span>
              Dev mode
            </div>
            <p className="mb-3 text-body-medium text-text-warning">
              No email is sent locally. The link below was also printed to the
              server console.
            </p>
            <a
              href={devLink.url}
              className={`w-full ${BUTTON_PRIMARY}`}
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
          className={`mt-5 ${BUTTON_LINK}`}
        >
          Use a different email
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <div>
        <label htmlFor="email" className="mb-1.5 block header-subtitle">
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
          className={INPUT_TEXT}
        />
      </div>

      {error && (
        <p className="rounded-control bg-surface-critical px-3 py-2 text-body-medium text-text-critical">
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={status === "sending"}
        className={`w-full ${BUTTON_PRIMARY}`}
      >
        {status === "sending" ? "Sending link…" : "Send magic link"}
      </button>
    </form>
  );
}
