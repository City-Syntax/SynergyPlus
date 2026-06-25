import { redirect } from "next/navigation";
import { getPortalUser } from "@/lib/session";

export default async function Home() {
  const user = await getPortalUser();
  redirect(user ? "/dashboard" : "/login");
}
