import type { CustomerSafeRecap } from "@applywizz/domain/meeting-recap";

// M11 §9: a collapsible preview of the customer-safe version — render-only,
// no send button (no email infrastructure exists in this repo yet). Never
// shows internal-only data because it never receives any: this component
// only ever gets the already-filtered CustomerSafeRecap shape produced by
// deriveCustomerSafeRecap.
export function CustomerSafeRecapSection({
  recap,
}: {
  recap: CustomerSafeRecap;
}) {
  return (
    <section className="rounded-lg border border-zinc-200 dark:border-zinc-800">
      <details>
        <summary className="cursor-pointer list-none border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
          <h2 className="inline text-sm font-medium">
            Customer-safe version (preview)
          </h2>
        </summary>
        <div className="flex flex-col gap-3 px-4 py-3 text-sm leading-6 text-zinc-700 dark:text-zinc-300">
          <p>{recap.greeting}</p>
          <RecapList label="What we agreed" items={recap.whatWeAgreed} />
          <RecapList
            label="What ApplyWizz will do"
            items={recap.applyWizzWillDo}
          />
          <RecapList
            label="What you should provide"
            items={recap.customerShouldDo}
          />
          <p className="text-zinc-500 dark:text-zinc-400">{recap.nextStep}</p>
        </div>
      </details>
    </section>
  );
}

function RecapList({ label, items }: { label: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div>
      <p className="text-xs font-medium text-zinc-500 dark:text-zinc-400">
        {label}
      </p>
      <ul className="mt-1 list-inside list-disc">
        {items.map((item) => (
          <li key={item}>{item}</li>
        ))}
      </ul>
    </div>
  );
}
