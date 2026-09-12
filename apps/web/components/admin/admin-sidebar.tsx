"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
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
  { href: "/integrations", label: "Integrations", icon: IntegrationsIcon },
  { href: "/admin/policies", label: "Settings", icon: SettingsIcon },
];

export function AdminSidebar() {
  const pathname = usePathname();

  return (
    <nav className="flex w-64 shrink-0 flex-col border-r border-[#F5F5F5]/10 bg-[#1E1E1E]">
      <Link href="/admin/overview" className="px-6 py-6 flex items-center gap-2 hover:opacity-80 transition-opacity">
        <div className="h-8 w-8 rounded-lg bg-[#29FE29] flex items-center justify-center">
          <span className="text-sm font-bold text-[#1E1E1E]">AW</span>
        </div>
        <div className="flex flex-col">
          <span className="text-base font-bold tracking-tight text-white">
            Apply Wizz
          </span>
          <span className="text-xs font-medium text-[#29FE29]">Echo Admin</span>
        </div>
      </Link>

      <div className="flex flex-1 flex-col gap-1 px-3 py-2">
        {NAV_ITEMS.map(({ href, label, icon: Icon }) => {
          const active = pathname === href || pathname?.startsWith(`${href}/`);
          return (
            <Link
              key={href}
              href={href}
              className={`flex items-center gap-3 rounded-lg px-4 py-3 text-sm font-medium transition-all ${
                active
                  ? "bg-[#2C76FF] text-white shadow-lg shadow-[#2C76FF]/20"
                  : "text-[#F5F5F5]/70 hover:text-white hover:bg-white/5"
              }`}
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
    </nav>
  );
}
