"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  ExceptionsIcon,
  IntegrationsIcon,
  MeetingsIcon,
  OverviewIcon,
  PeopleIcon,
  SettingsIcon,
} from "./icons";

const NAV_ITEMS = [
  { href: "/admin/overview", label: "Overview", icon: OverviewIcon },
  { href: "/admin/meetings", label: "Meetings", icon: MeetingsIcon },
  { href: "/admin/people", label: "Team", icon: PeopleIcon },
  { href: "/admin/exceptions", label: "Review Queue", icon: ExceptionsIcon },
  { href: "/integrations", label: "Integrations", icon: IntegrationsIcon },
  { href: "/admin/policies", label: "Settings", icon: SettingsIcon },
];

export function AdminSidebar() {
  const pathname = usePathname();

  return (
    <nav className="flex w-60 shrink-0 flex-col border-r border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
      <div className="px-5 py-5 flex items-center justify-between">
        <span className="text-lg font-bold tracking-tight">
          <span className="text-blue-600 dark:text-blue-400">Apply Wizz</span> Echo
        </span>
      </div>

      <div className="flex flex-1 flex-col gap-1 px-3">
        {NAV_ITEMS.map(({ href, label, icon: Icon }) => {
          const active = pathname === href || pathname?.startsWith(`${href}/`);
          return (
            <Link
              key={href}
              href={href}
              className={`flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                active
                  ? "bg-blue-50 text-blue-700 dark:bg-blue-950/70 dark:text-blue-300"
                  : "text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-900"
              }`}
            >
              <Icon className="h-4 w-4 shrink-0" />
              {label}
            </Link>
          );
        })}
      </div>

      <div className="p-4 border-t border-zinc-100 text-xs text-zinc-400 dark:border-zinc-900">
        Apply Wizz Echo · v1.0
      </div>
    </nav>
  );
}
