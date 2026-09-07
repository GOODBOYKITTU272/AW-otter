import { AdminSidebar } from "@/components/admin/admin-sidebar";
import { SignOutButton } from "@/components/sign-out-button";
import { requireRole } from "@/lib/require-role";

export default async function AdminLayout({ children }: LayoutProps<"/admin">) {
  const membership = await requireRole(["admin"]);

  return (
    <div className="flex flex-1">
      <AdminSidebar />
      <div className="flex flex-1 flex-col">
        <header className="flex items-center justify-end gap-4 border-b border-zinc-200 px-8 py-3 dark:border-zinc-800">
          <span className="text-sm text-zinc-500 dark:text-zinc-400">
            {membership.displayName} <span className="text-zinc-400 dark:text-zinc-600">· Admin</span>
          </span>
          <SignOutButton />
        </header>
        {children}
      </div>
    </div>
  );
}
