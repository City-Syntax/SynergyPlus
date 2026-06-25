import { getPortalUser } from "@/lib/session";
import { getDashboardData } from "@/lib/dashboard";

// Live activity feed for the dashboard. Polled by the client; never cached.
export const dynamic = "force-dynamic";

export async function GET() {
  const user = await getPortalUser();
  if (!user) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const data = await getDashboardData(user.userId);
  return Response.json(data, { headers: { "Cache-Control": "no-store" } });
}
