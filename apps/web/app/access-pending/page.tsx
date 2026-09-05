export default function AccessPendingPage() {
  return (
    <main className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
      <h1 className="text-xl font-semibold tracking-tight">Access pending</h1>
      <p className="max-w-sm text-sm text-zinc-500 dark:text-zinc-400">
        Your account isn&apos;t linked to an active ApplyWizz organization yet.
        Contact your Admin.
      </p>
    </main>
  );
}
