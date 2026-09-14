import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const pageSource = readFileSync(join(here, "page.tsx"), "utf8");
const cssSource = readFileSync(join(here, "meeting-detail.module.css"), "utf8");
const layoutSource = readFileSync(join(here, "..", "layout.tsx"), "utf8");

describe("Meeting Detail Overview presentation", () => {
  it("forces light Apply Wizz content canvas (no OS dark-mode flip)", () => {
    expect(cssSource).toContain("--bg: #f5f5f5");
    expect(cssSource).toContain("--surface: #ffffff");
    expect(cssSource).toContain("--accent: #2c76ff");
    expect(cssSource).toContain("--cta: #29fe29");
    expect(cssSource).not.toContain("prefers-color-scheme: dark");
  });

  it("wraps Admin Meeting Detail in ops-dark sidebar + light shell", () => {
    expect(layoutSource).toContain('bg-[#0B1D33]');
    expect(layoutSource).toContain('bg-[#F5F5F5]');
    expect(layoutSource).toContain("AdminSidebar");
  });

  it("does not render MediaPlayer on Overview", () => {
    const overviewStart = pageSource.indexOf("function OverviewTab");
    const transcriptStart = pageSource.indexOf("function TranscriptTab");
    const overview = pageSource.slice(overviewStart, transcriptStart);
    expect(overview).not.toContain("MediaPlayer");
    expect(overview).not.toContain("bot_status");
    expect(overview).not.toContain("provider_bot_id");
  });

  it("exposes Admin Regenerate outcome control on Overview", () => {
    expect(pageSource).toContain("RegenerateOutcomeButton");
    expect(pageSource).toContain("isAdmin");
  });

  it("uses claim-aware evidence snippets", () => {
    expect(pageSource).toContain("extractClaimSnippet");
    expect(pageSource).toContain("firstEvidenceQuote(q.evidenceSegmentIds, segmentById, q.question)");
  });
});
