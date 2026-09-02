"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { Logo } from "./Logo";
import { signOut } from "@/lib/auth-client";
import { BUTTON_SECONDARY } from "@/components/ui";
import { useRouter } from "next/navigation";

const NAV = [
  { href: "/dashboard", label: "Dashboard", icon: GridIcon },
  { href: "/keys", label: "API Keys", icon: KeyIcon },
  { href: "/getting-started", label: "Getting Started", icon: BookIcon },
];

const ICON_BUTTON =
  "grid place-items-center rounded-control text-icon-secondary transition-colors duration-[120ms] cursor-pointer hover:bg-fill-transparent-hover hover:text-icon active:bg-fill-transparent-active outline-none focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-border-focus focus-visible:outline-offset-1";

export function Sidebar({ email, name }: { email: string; name: string }) {
  const pathname = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);

  // Auto-hide the drawer whenever the route changes (e.g. after a nav click).
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  // Prevent background scroll while the mobile drawer is open.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  async function handleSignOut() {
    await signOut();
    router.push("/login");
    router.refresh();
  }

  return (
    <>
      {/* Mobile top bar with hamburger — hidden on md+ where the sidebar is always visible. */}
      <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-border bg-surface px-4 md:hidden">
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label="Open navigation menu"
          aria-expanded={open}
          aria-controls="portal-sidebar"
          className={`h-8 w-8 ${ICON_BUTTON}`}
        >
          <MenuIcon />
        </button>
        <Logo />
      </header>

      {/* Backdrop — only rendered on mobile while the drawer is open. */}
      {open && (
        <div
          onClick={() => setOpen(false)}
          aria-hidden
          className="fixed inset-0 z-40 bg-bg-overlay md:hidden"
        />
      )}

      <aside
        id="portal-sidebar"
        className={`fixed inset-y-0 left-0 z-50 flex h-screen w-64 flex-col border-r border-border bg-surface px-3 py-4 transition-transform duration-200 ease-out md:sticky md:top-0 md:z-auto md:translate-x-0 ${
          open ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="flex items-center justify-between px-2 pb-5">
          <Logo />
          <button
            type="button"
            onClick={() => setOpen(false)}
            aria-label="Close navigation menu"
            className={`h-8 w-8 md:hidden ${ICON_BUTTON}`}
          >
            <CloseIcon />
          </button>
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
                className={`flex items-center gap-2.5 rounded-control p-2 text-body-medium transition-colors duration-[120ms] outline-none focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-border-focus focus-visible:outline-offset-1 ${
                  active
                    ? "bg-surface-selected font-semibold text-text"
                    : "font-medium text-text-secondary hover:bg-fill-hover hover:text-text active:bg-fill-active"
                }`}
              >
                <span className={active ? "text-icon" : "text-icon-secondary"}>
                  <Icon active={active} />
                </span>
                {item.label}
              </Link>
            );
          })}
        </nav>

        <div className="space-y-3 border-t border-border pt-3">
          <div className="flex items-center gap-2.5 px-1">
            <div className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-avatar-fill text-body-medium font-semibold uppercase text-avatar-text">
              {name.slice(0, 2)}
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-body-medium font-medium text-text">
                {name}
              </div>
              <div className="truncate text-body-small text-text-secondary">
                {email}
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={handleSignOut}
            className={`w-full text-text-secondary not-disabled:hover:text-text-critical ${BUTTON_SECONDARY}`}
          >
            Sign out
          </button>
        </div>
      </aside>
    </>
  );
}

function MenuIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <line x1="3" y1="6" x2="21" y2="6" />
      <line x1="3" y1="12" x2="21" y2="12" />
      <line x1="3" y1="18" x2="21" y2="18" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
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
