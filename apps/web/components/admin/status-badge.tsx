// Blueprint's visual system: green only for healthy/completed, amber for
// waiting/review, red for failure/high-risk — never color alone (label text
// always accompanies it).
const TONE_CLASSES = {
  success: "bg-green-50 text-green-700 dark:bg-green-950 dark:text-green-300",
  warning: "bg-amber-50 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
  critical: "bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-300",
  info: "bg-blue-50 text-blue-700 dark:bg-blue-950 dark:text-blue-300",
  neutral: "bg-zinc-100 text-zinc-600 dark:bg-zinc-900 dark:text-zinc-400",
} as const;

export type BadgeTone = keyof typeof TONE_CLASSES;

export function StatusBadge({ tone, children }: { tone: BadgeTone; children: React.ReactNode }) {
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${TONE_CLASSES[tone]}`}>
      {children}
    </span>
  );
}
