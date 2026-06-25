/**
 * Production magic-link delivery over generic SMTP.
 *
 * Kept provider-agnostic on purpose: any SMTP endpoint works (SES SMTP, Resend,
 * Postmark, Mailgun, a self-hosted relay), so swapping providers is a config
 * change (SMTP_* / MAIL_FROM) with no code or image rebuild. In local dev the
 * link is surfaced in the UI instead (see ./dev-magic-link), so this module is
 * only exercised when devLoginEnabled is off — i.e. production.
 */

import nodemailer, { type Transporter } from "nodemailer";
import { env } from "./env";

// Lazily-built singleton: building the transport touches no network, but we
// defer it so importing this module never fails and a misconfigured SMTP setup
// surfaces a clear error at send time rather than at module load.
let transporter: Transporter | undefined;

function getTransporter(): Transporter {
  if (transporter) return transporter;

  if (!env.smtp.host) {
    throw new Error(
      "SMTP is not configured: set SMTP_HOST (and SMTP_PORT/SMTP_USER/SMTP_PASS) " +
        "to deliver magic-link email in production, or enable PORTAL_DEV_LOGIN " +
        "to surface links in the UI for non-production environments.",
    );
  }

  transporter = nodemailer.createTransport({
    host: env.smtp.host,
    port: env.smtp.port,
    secure: env.smtp.secure,
    // Omit auth entirely for relays that don't require it (e.g. an in-VPC relay).
    auth: env.smtp.user
      ? { user: env.smtp.user, pass: env.smtp.pass }
      : undefined,
  });

  return transporter;
}

/**
 * Deliver a magic-link sign-in email. Throws if SMTP is unconfigured or the
 * send fails, so Better Auth surfaces the failure to the caller rather than
 * silently dropping the link.
 */
export async function sendMagicLinkEmail(opts: {
  to: string;
  url: string;
}): Promise<void> {
  const { to, url } = opts;

  await getTransporter().sendMail({
    from: env.mailFrom,
    to,
    subject: "Your SynergyPlus sign-in link",
    text: [
      "Use the link below to sign in to SynergyPlus. It expires in 10 minutes",
      "and can be used once.",
      "",
      url,
      "",
      "If you didn't request this, you can safely ignore this email.",
    ].join("\n"),
    html: [
      `<p>Use the button below to sign in to SynergyPlus. It expires in 10 minutes and can be used once.</p>`,
      `<p><a href="${url}">Sign in to SynergyPlus</a></p>`,
      `<p>If the button doesn't work, paste this URL into your browser:<br><span>${url}</span></p>`,
      `<p style="color:#666">If you didn't request this, you can safely ignore this email.</p>`,
    ].join(""),
  });
}
