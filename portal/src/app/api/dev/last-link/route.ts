import { NextRequest, NextResponse } from "next/server";
import { env } from "@/lib/env";
import { getDevLink } from "@/lib/dev-magic-link";

/**
 * Dev-only: returns the most recent magic link for an email so the login UI can
 * surface it without a real mailbox. Disabled entirely in production.
 */
export async function GET(req: NextRequest) {
  if (!env.devLoginEnabled) {
    return NextResponse.json({ error: "disabled" }, { status: 404 });
  }
  const email = req.nextUrl.searchParams.get("email")?.toLowerCase();
  if (!email) return NextResponse.json({ error: "email required" }, { status: 400 });

  const link = getDevLink(email);
  if (!link) return NextResponse.json({ link: null });
  return NextResponse.json({ link: { url: link.url, token: link.token, at: link.at } });
}
