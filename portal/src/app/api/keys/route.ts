import { NextRequest, NextResponse } from "next/server";
import { getPortalUser } from "@/lib/session";
import { createApiKey, listApiKeys } from "@/lib/api-keys";

export async function GET() {
  const user = await getPortalUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const keys = await listApiKeys(user.userId);
  return NextResponse.json({ keys });
}

export async function POST(req: NextRequest) {
  const user = await getPortalUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let name = "default";
  try {
    const body = (await req.json()) as { name?: string };
    if (typeof body?.name === "string" && body.name.trim()) name = body.name;
  } catch {
    /* allow empty body → default name */
  }

  const { id, rawKey } = await createApiKey(user.userId, name);
  // The raw key is returned EXACTLY ONCE here and never persisted.
  return NextResponse.json({ id, name: name.trim() || "default", rawKey }, { status: 201 });
}
