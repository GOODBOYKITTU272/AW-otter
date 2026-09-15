import type { BadgeTone } from "./status-badge";

const VALUE_TONE_CLASSES: Record<BadgeTone, string> = {
  success: "text-emerald-600",
  warning: "text-amber-600",
  critical: "text-red-600",
  info: "text-[#2C76FF]",
  neutral: "text-zinc-800",
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
    <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-sm">
      <p className="text-xs font-semibold uppercase tracking-wider text-zinc-500">{label}</p>
      <p className={`mt-1 text-2xl font-bold ${VALUE_TONE_CLASSES[tone]}`}>{value}</p>
    </div>
  );
}
