import { getRequiredPortalUser } from "@/lib/session";
import { listApiKeys } from "@/lib/api-keys";
import { KeysManager } from "./KeysManager";

export default async function KeysPage() {
  const user = await getRequiredPortalUser();
  const keys = await listApiKeys(user.userId);

  return (
    <div className="space-y-7">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">API Keys</h1>
        <p className="mt-1.5 text-sm text-muted">
          Keys authenticate the SDK and CLI as{" "}
          <span className="font-medium text-fg">{user.email}</span>. Only a
          hash is stored — the raw key is shown once at creation.
        </p>
      </header>

      <KeysManager initialKeys={keys} />
    </div>
  );
}
