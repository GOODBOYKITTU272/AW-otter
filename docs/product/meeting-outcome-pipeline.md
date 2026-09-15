# Meeting Detail pipeline (Fathom-style tabs)

```
Teams → Vexa audio → STT (English→Whisper, else→Sarvam)
  → Canonical English
  → Meeting Outcome (reuse existing intelligence when present;
     otherwise one Outcome LLM prompt over Canonical English)
  → Meeting Detail tabs
```

Tabs: **Overview** (default) · **Audio** · **Video** · **Transcript** (Manager/Admin only) · **Insights**.

Overview cards (Summary, Key decisions, Action items, Open questions) render from:

1. `meeting_outcomes` when a row exists, or
2. existing `ai_runs` summary + `call_records` when the outcomes table is empty.

That is why `select * from meeting_outcomes` can return **Success. No rows returned** while Overview still has real content: the table is new and is backfilled by `/api/internal/meeting-intelligence/process` (existing cron) and `/api/internal/meeting-outcome/process`. Apply the `meeting_outcomes` migration first; the worker then writes rows from completed intelligence, or from the Outcome LLM when intelligence is not ready yet.

Account Managers never see the raw Transcript tab. Do not invent metrics that are not in recap / media / transcript data.
