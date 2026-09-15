"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, type ReactNode } from "react";
import { SignOutButton } from "./sign-out-button";

// Role-specific navigation configurations
const AM_NAV_ITEMS = [
  { href: "/home", label: "My day", icon: HomeIcon },
  { href: "/meetings", label: "Meetings", icon: CalendarIcon },
  { href: "/actions", label: "Actions", icon: CheckCircleIcon },
  { href: "/customers", label: "Customers", icon: UsersIcon },
  { href: "/integrations", label: "Integrations", icon: IntegrationsIcon },
];

const MANAGER_NAV_ITEMS = [
  { href: "/manager/overview", label: "Overview", icon: DashboardIcon },
  { href: "/manager/board", label: "AM Board", icon: GridIcon },
  { href: "/manager/team", label: "Team", icon: UsersIcon },
  { href: "/manager/meetings", label: "Meetings", icon: CalendarIcon },
  { href: "/manager/exceptions", label: "Exceptions", icon: AlertIcon },
];

interface RoleShellProps {
  children: ReactNode;
  role: "am" | "manager";
  userName: string;
  roleLabel: string;
}

export function RoleShell({ children, role, userName, roleLabel }: RoleShellProps) {
  const pathname = usePathname();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  
  const navItems = role === "am" ? AM_NAV_ITEMS : MANAGER_NAV_ITEMS;
  const homeHref = role === "am" ? "/home" : "/manager/overview";

  const sidebarContent = (
    <>
      <Link
        href={homeHref}
        className="px-6 py-5 flex items-center gap-3 hover:opacity-80 transition-opacity border-b border-[#F5F5F5]/10"
        onClick={() => setMobileMenuOpen(false)}
      >
        <div className="h-9 w-9 rounded-lg bg-gradient-to-br from-[#2C76FF] to-[#29FE29] flex items-center justify-center shrink-0">
          <span className="text-sm font-bold text-white">AW</span>
        </div>
        <div className="flex flex-col leading-tight">
          <span className="text-base font-bold tracking-tight text-white">
            Wizz Echo
          </span>
          <span className="text-[10px] font-medium text-[#29FE29] uppercase tracking-wide">
            {role === "am" ? "AM" : "Manager"}
          </span>
        </div>
      </Link>

      <div className="flex flex-1 flex-col gap-1 px-3 py-4">
        {navItems.map(({ href, label, icon: Icon }) => {
          const active =
            pathname === href ||
            pathname?.startsWith(`${href}/`) ||
            (href === "/meetings" && pathname?.startsWith("/meetings/"));
          return (
            <Link
              key={href}
              href={href}
              className={`flex items-center gap-3 rounded-lg px-4 py-3 text-sm font-medium transition-all min-h-[44px] ${
                active
                  ? "bg-[#29FE29] text-[#1E1E1E] shadow-lg shadow-[#29FE29]/20"
                  : "text-[#F5F5F5]/70 hover:text-white hover:bg-white/5"
              }`}
              onClick={() => setMobileMenuOpen(false)}
            >
              <Icon className="h-5 w-5 shrink-0" />
              {label}
            </Link>
          );
        })}
      </div>

      <div className="p-4 border-t border-[#F5F5F5]/10">
        <div className="flex items-center gap-3 mb-3">
          <div className="h-8 w-8 rounded-full bg-[#2C76FF]/20 flex items-center justify-center shrink-0">
            <span className="text-xs font-bold text-[#2C76FF]">
              {userName.split(' ').map(n => n[0]).join('').slice(0,2).toUpperCase()}
            </span>
          </div>
          <div className="flex flex-col leading-tight min-w-0">
            <span className="text-sm font-medium text-white truncate">{userName}</span>
            <span className="text-xs text-[#F5F5F5]/50">{roleLabel}</span>
          </div>
        </div>
        <SignOutButton className="w-full" />
      </div>
    </>
  );

  return (
    <div className="flex min-h-screen bg-[#0B1D33]">
      {/* Desktop sidebar */}
      <nav className="hidden lg:flex w-64 shrink-0 flex-col border-r border-[#F5F5F5]/10 bg-[#1E1E1E]">
        {sidebarContent}
      </nav>

      {/* Mobile sidebar drawer */}
      {mobileMenuOpen && (
        <>
          <div
            className="lg:hidden fixed inset-0 bg-black/60 z-40 backdrop-blur-xs"
            onClick={() => setMobileMenuOpen(false)}
          />
          <nav className="lg:hidden fixed inset-y-0 left-0 z-50 w-64 flex flex-col border-r border-[#F5F5F5]/10 bg-[#1E1E1E] shadow-2xl">
            {sidebarContent}
          </nav>
        </>
      )}

      {/* Main content column */}
      <div className="flex-1 flex flex-col min-w-0 w-full overflow-x-hidden">
        {/* Mobile top app bar */}
        <header className="lg:hidden sticky top-0 z-30 flex items-center justify-between px-4 py-3 bg-[#1E1E1E] text-white border-b border-[#F5F5F5]/10 shadow-md">
          <div className="flex items-center gap-3">
            <button
              onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
              className="min-h-[40px] min-w-[40px] flex items-center justify-center rounded-lg bg-white/5 hover:bg-white/10 text-white border border-white/10 transition-colors"
              aria-label="Toggle menu"
            >
              <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                {mobileMenuOpen ? (
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                ) : (
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
                )}
              </svg>
            </button>
            <Link href={homeHref} className="flex items-center gap-2">
              <div className="h-7 w-7 rounded-md bg-gradient-to-br from-[#2C76FF] to-[#29FE29] flex items-center justify-center shrink-0">
                <span className="text-xs font-bold text-white">AW</span>
              </div>
              <span className="text-sm font-bold text-white tracking-tight">Wizz Echo</span>
              <span className="text-[10px] font-semibold text-[#29FE29] uppercase px-1.5 py-0.5 rounded bg-[#29FE29]/10">
                {role === "am" ? "AM" : "Manager"}
              </span>
            </Link>
          </div>
          <div className="flex items-center gap-2">
            <SignOutButton />
          </div>
        </header>

        {/* Main content area */}
        <main className="flex-1 flex flex-col min-w-0 w-full overflow-x-hidden">
          {children}
        </main>
      </div>
    </div>
  );
}

// Icon components
function HomeIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" />
    </svg>
  );
}

function CalendarIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
    </svg>
  );
}

function CheckCircleIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  );
}

function UsersIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z" />
    </svg>
  );
}

function IntegrationsIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 4a2 2 0 114 0v1a1 1 0 001 1h3a1 1 0 011 1v3a1 1 0 01-1 1h-1a2 2 0 100 4h1a1 1 0 011 1v3a1 1 0 01-1 1h-3a1 1 0 01-1-1v-1a2 2 0 10-4 0v1a1 1 0 01-1 1H7a1 1 0 01-1-1v-3a1 1 0 00-1-1H4a2 2 0 110-4h1a1 1 0 001-1V7a1 1 0 011-1h3a1 1 0 001-1V4z" />
    </svg>
  );
}

function DashboardIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
    </svg>
  );
}

function GridIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM14 6a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2H6a2 2 0 01-2-2v-2zM14 16a2 2 0 012-2h2a2 2 0 012 2v2a2 2 0 01-2 2h-2a2 2 0 01-2-2v-2z" />
    </svg>
  );
}

function AlertIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
    </svg>
  );
}
