import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// M11: real recap route regression guard. The M11 fixture prep must never
// leak onto the production route — a plain source check is the simplest
// thing that actually fails if someone re-adds the fixture import.
describe("meetings/[id]/recap page", () => {
  it("never imports the fixture-only recap data", () => {
    const source = readFileSync(
      fileURLToPath(new URL("./page.tsx", import.meta.url)),
      "utf8",
    );
    expect(source).not.toContain("getMeetingRecapFixture");
    expect(source).not.toContain("fixtures/meeting-intelligence");
    expect(source).toContain("getMeetingRecapData");
  });
});
