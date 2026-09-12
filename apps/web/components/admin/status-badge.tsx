// Apply Wizz brand colors for status badges
// - Fluorescent Green #29FE29 for success
// - Yellow #FFDE59 for warnings
// - Coral Red #FF5C5C for critical/danger
// - Bright Blue #2C76FF for info
// - Soft Gray for neutral
const TONE_CLASSES = {
  success: "bg-[#29FE29]/10 text-[#166534] border border-[#29FE29]/20",
  warning: "bg-[#FFDE59]/10 text-[#92400E] border border-[#FFDE59]/20",
  critical: "bg-[#FF5C5C]/10 text-[#991B1B] border border-[#FF5C5C]/20",
  info: "bg-[#2C76FF]/10 text-[#1E40AF] border border-[#2C76FF]/20",
  neutral: "bg-zinc-100 text-zinc-700 border border-zinc-200",
} as const;

export type BadgeTone = keyof typeof TONE_CLASSES;

export function StatusBadge({ tone, children }: { tone: BadgeTone; children: React.ReactNode }) {
  return (
    <span className={`inline-flex items-center rounded-lg px-2.5 py-1 text-xs font-semibold ${TONE_CLASSES[tone]}`}>
      {children}
    </span>
  );
}
