import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { auth } from "./auth";
import { upsertAppUser } from "./db";

export type PortalUser = {
  /** Canonical platform user_id (= app.users.id). */
  userId: string;
  email: string;
  name: string;
};

/**
 * Resolve the current portal user from the Better Auth session and map it to
 * the canonical `app.users.id` (CONTRACT §2). Upserts app.users on every call
 * so the platform user_id always exists and matches the auth identity.
 *
 * Returns null when there is no valid session.
 */
export async function getPortalUser(): Promise<PortalUser | null> {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user?.email) return null;

  const userId = await upsertAppUser(session.user.email);
  return {
    userId,
    email: session.user.email,
    name: session.user.name || session.user.email.split("@")[0],
  };
}

/**
 * Like `getPortalUser()` but redirects to "/login" when there is no valid
 * session, so callers never receive null and can skip the non-null assertion.
 */
export async function getRequiredPortalUser(): Promise<PortalUser> {
  const user = await getPortalUser();
  if (!user) redirect("/login");
  return user;
}
