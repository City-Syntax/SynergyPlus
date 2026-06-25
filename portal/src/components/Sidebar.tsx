"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Logo } from "./Logo";
import { ThemeToggle } from "./ThemeToggle";
import { signOut } from "@/lib/auth-client";
import { useRouter } from "next/navigation";

const NAV = [
  { href: "/dashboard", label: "Dashboard", icon: GridIcon },
  { href: "/keys", label: "API Keys", icon: KeyIcon },
  { href: "/getting-started", label: "Getting Started", icon: BookIcon },
];

export function Sidebar({ email, name }: { email: string; name: string }) {
  const pathname = usePathname();
  const router = useRouter();

  async function handleSignOut() {
    await signOut();
    router.push("/login");
    router.refresh();
  }

  return (
    <aside className="sticky top-0 flex h-screen w-64 flex-col border-r border-border bg-panel px-3 py-4">
      <div className="px-2 pb-5">
        <Logo />
      </div>

      <nav className="flex-1 space-y-1">
        {NAV.map((item) => {
          const active =
            pathname === item.href || pathname.startsWith(item.href + "/");
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition ${
                active
                  ? "bg-brand/12 text-brand"
                  : "text-muted hover:bg-panel-2 hover:text-fg"
              }`}
            >
              <Icon active={active} />
              {item.label}
            </Link>
          );
        })}
      </nav>

      <div className="space-y-3 border-t border-border pt-3">
        <div className="flex items-center gap-2.5 px-1">
          <div className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-brand/15 text-xs font-semibold uppercase text-brand">
            {name.slice(0, 2)}
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-xs font-medium text-fg">{name}</div>
            <div className="truncate text-[11px] text-muted">{email}</div>
          </div>
          <ThemeToggle />
        </div>
        <button
          type="button"
          onClick={handleSignOut}
          className="w-full rounded-lg border border-border px-3 py-2 text-xs font-medium text-muted transition hover:border-red-500/40 hover:text-red-400"
        >
          Sign out
        </button>
      </div>
    </aside>
  );
}

function GridIcon({ active }: { active?: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill={active ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden opacity={active ? 0.9 : 1}>
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </svg>
  );
}

function KeyIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="7.5" cy="15.5" r="4.5" />
      <path d="m10.5 12.5 8-8M16 6l2 2M19 3l2 2" />
    </svg>
  );
}

function BookIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
      <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
    </svg>
  );
}
