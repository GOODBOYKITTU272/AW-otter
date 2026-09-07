import type { BadgeTone } from "./status-badge";

const VALUE_TONE_CLASSES: Record<BadgeTone, string> = {
  success: "text-green-700 dark:text-green-400",
  warning: "text-amber-700 dark:text-amber-400",
  critical: "text-red-700 dark:text-red-400",
  info: "text-blue-700 dark:text-blue-400",
  neutral: "text-zinc-900 dark:text-zinc-50",
};

export function MetricCard({
  label,
  value,
  tone = "neutral",
}: {
  label: string;
  value: number;
  tone?: BadgeTone;
}) {
  return (
    <div className="rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
      <p className="text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400">{label}</p>
      <p className={`mt-1 text-2xl font-semibold ${VALUE_TONE_CLASSES[tone]}`}>{value}</p>
    </div>
  );
}
