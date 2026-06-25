import { redirect } from "next/navigation";
import { Sidebar } from "@/components/Sidebar";
import { getPortalUser } from "@/lib/session";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await getPortalUser();
  if (!user) redirect("/login");

  return (
    <div className="flex min-h-screen">
      <Sidebar email={user.email} name={user.name} />
      <main className="flex-1 overflow-x-hidden">
        <div className="mx-auto max-w-4xl px-8 py-10">{children}</div>
      </main>
    </div>
  );
}
