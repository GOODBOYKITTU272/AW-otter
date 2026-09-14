"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import {
  CustomerTruthIcon,
  ExceptionsIcon,
  IntegrationsIcon,
  MeetingsIcon,
  OverviewIcon,
  PeopleIcon,
  SettingsIcon,
} from "./icons";

const NAV_ITEMS = [
  { href: "/admin/overview", label: "Home", icon: OverviewIcon },
  { href: "/admin/meetings", label: "Meetings", icon: MeetingsIcon },
  { href: "/admin/people", label: "Team", icon: PeopleIcon },
  { href: "/admin/exceptions", label: "Review Queue", icon: ExceptionsIcon },
  { href: "/admin/customer-truth", label: "Customer Truth", icon: CustomerTruthIcon },
  { href: "/admin/integrations", label: "Integrations", icon: IntegrationsIcon },
  { href: "/admin/policies", label: "Settings", icon: SettingsIcon },
];

export function AdminSidebar() {
  const pathname = usePathname();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const sidebarContent = (
    <>
      <Link href="/admin/overview" className="px-6 py-6 flex items-center gap-2 hover:opacity-80 transition-opacity border-b border-[#F5F5F5]/10" onClick={() => setMobileMenuOpen(false)}>
        <div className="h-9 w-9 rounded-xl bg-gradient-to-br from-[#2C76FF] to-[#29FE29] flex items-center justify-center shadow-lg">
          <span className="text-sm font-bold text-white">AW</span>
        </div>
        <div className="flex flex-col leading-tight">
          <span className="text-base font-bold tracking-tight text-white">
            Wizz Echo
          </span>
          <span className="text-xs font-medium text-[#29FE29]">Admin</span>
        </div>
      </Link>

      <div className="flex flex-1 flex-col gap-1 px-3 py-2">
        {NAV_ITEMS.map(({ href, label, icon: Icon }) => {
          const active =
            pathname === href ||
            pathname?.startsWith(`${href}/`) ||
            (href === "/admin/meetings" && pathname?.startsWith("/meetings/"));
          return (
            <Link
              key={href}
              href={href}
              className={`flex items-center gap-3 rounded-lg px-4 py-3 text-sm font-medium transition-all min-h-[44px] ${
                active
                  ? "bg-[#2C76FF] text-white shadow-lg shadow-[#2C76FF]/20"
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

      <div className="p-4 border-t border-[#F5F5F5]/10 text-xs text-[#F5F5F5]/50">
        Echo Control Center · v1.0
      </div>
    </>
  );

  return (
    <>
      {/* Mobile hamburger button */}
      <button
        onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
        className="lg:hidden fixed top-4 left-4 z-50 min-h-[44px] min-w-[44px] flex items-center justify-center rounded-lg bg-[#0B1D33] text-white shadow-lg border border-[#F5F5F5]/10"
        aria-label="Toggle menu"
      >
        <svg
          className="h-6 w-6"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
        >
          {mobileMenuOpen ? (
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M6 18L18 6M6 6l12 12"
            />
          ) : (
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M4 6h16M4 12h16M4 18h16"
            />
          )}
        </svg>
      </button>

      {/* Desktop sidebar */}
      <nav className="hidden lg:flex w-64 shrink-0 flex-col border-r border-[#F5F5F5]/10 bg-[#0B1D33]">
        {sidebarContent}
      </nav>

      {/* Mobile sidebar drawer */}
      {mobileMenuOpen && (
        <>
          <div
            className="lg:hidden fixed inset-0 bg-black/50 z-40"
            onClick={() => setMobileMenuOpen(false)}
          />
          <nav className="lg:hidden fixed inset-y-0 left-0 z-40 w-64 flex flex-col border-r border-[#F5F5F5]/10 bg-[#0B1D33] shadow-2xl">
            {sidebarContent}
          </nav>
        </>
      )}
    </>
  );
}
