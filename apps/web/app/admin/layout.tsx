import { AdminSidebar } from "@/components/admin/admin-sidebar";
import { SignOutButton } from "@/components/sign-out-button";
import { requireRole } from "@/lib/require-role";

export default async function AdminLayout({ children }: LayoutProps<"/admin">) {
  const membership = await requireRole(["admin"]);

  return (
    <div className="flex flex-1 bg-[#0B1D33]">
      <AdminSidebar />
      <div className="flex flex-1 flex-col bg-[#F5F5F5] min-h-screen min-w-0 w-full overflow-x-hidden">
        <header className="sticky top-0 z-30 flex items-center justify-between lg:justify-end gap-2 sm:gap-4 border-b border-zinc-200 bg-white px-4 pl-16 lg:pl-8 sm:px-8 py-3.5 shadow-sm min-w-0">
          <span className="text-xs sm:text-sm text-zinc-700 truncate">
            {membership.displayName} <span className="text-zinc-500">· Admin</span>
          </span>
          <SignOutButton />
        </header>
        {children}
      </div>
    </div>
  );
}
