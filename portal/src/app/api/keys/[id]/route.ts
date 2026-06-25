import { NextResponse } from "next/server";
import { getPortalUser } from "@/lib/session";
import { revokeApiKey } from "@/lib/api-keys";

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const user = await getPortalUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { id } = await params;
  const ok = await revokeApiKey(user.userId, id);
  if (!ok) {
    return NextResponse.json(
      { error: "not found or already revoked" },
      { status: 404 },
    );
  }
  return NextResponse.json({ ok: true });
}
