"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  AuditIcon,
  ExceptionsIcon,
  IntegrationsIcon,
  MeetingsIcon,
  OverviewIcon,
  PeopleIcon,
  PoliciesIcon,
  SettingsIcon,
  TeamsIcon,
} from "./icons";

const NAV_ITEMS = [
  { href: "/admin/overview", label: "Overview", icon: OverviewIcon },
  { href: "/admin/meetings", label: "Meetings", icon: MeetingsIcon },
  { href: "/admin/people", label: "People", icon: PeopleIcon },
  { href: "/integrations", label: "Integrations", icon: IntegrationsIcon },
];

// Real IA from the blueprint's page map, not yet built — shown so the
// product's shape is honest and visible, not linked to anything fake.
const SOON_ITEMS = [
  { label: "Teams", icon: TeamsIcon },
  { label: "Exceptions", icon: ExceptionsIcon },
  { label: "Policies", icon: PoliciesIcon },
  { label: "Audit", icon: AuditIcon },
  { label: "Settings", icon: SettingsIcon },
];

export function AdminSidebar() {
  const pathname = usePathname();

  return (
    <nav className="flex w-60 shrink-0 flex-col border-r border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
      <div className="px-5 py-5">
        <span className="text-lg font-semibold tracking-tight">
          <span className="text-blue-700 dark:text-blue-400">ApplyWizz</span> Signal
        </span>
      </div>

      <div className="flex flex-1 flex-col gap-0.5 px-3">
        {NAV_ITEMS.map(({ href, label, icon: Icon }) => {
          const active = pathname === href || pathname?.startsWith(`${href}/`);
          return (
            <Link
              key={href}
              href={href}
              className={`flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                active
                  ? "bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-300"
                  : "text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-900"
              }`}
            >
              <Icon className="h-4 w-4 shrink-0" />
              {label}
            </Link>
          );
        })}

        <div className="mt-4 flex flex-col gap-0.5 border-t border-zinc-100 pt-4 dark:border-zinc-900">
          {SOON_ITEMS.map(({ label, icon: Icon }) => (
            <div
              key={label}
              className="flex items-center justify-between gap-3 rounded-md px-3 py-2 text-sm text-zinc-400 dark:text-zinc-600"
            >
              <span className="flex items-center gap-3">
                <Icon className="h-4 w-4 shrink-0" />
                {label}
              </span>
              <span className="rounded-full bg-zinc-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-zinc-400 dark:bg-zinc-900 dark:text-zinc-600">
                Soon
              </span>
            </div>
          ))}
        </div>
      </div>
    </nav>
  );
}
