import { describe, it, expect } from "vitest";
import { generateBotDisplayName } from "./bot-name";

describe("generateBotDisplayName", () => {
  it("should generate bot name with first name from display name", () => {
    expect(generateBotDisplayName("John Doe")).toBe("AI Note Maker · John");
    expect(generateBotDisplayName("Jane Smith")).toBe("AI Note Maker · Jane");
    expect(generateBotDisplayName("Alice")).toBe("AI Note Maker · Alice");
  });

  it("should handle multiple spaces between names", () => {
    expect(generateBotDisplayName("John   Doe")).toBe("AI Note Maker · John");
  });

  it("should handle leading and trailing whitespace", () => {
    expect(generateBotDisplayName("  John Doe  ")).toBe("AI Note Maker · John");
    expect(generateBotDisplayName("  Alice  ")).toBe("AI Note Maker · Alice");
  });

  it("should fall back to default name when display name is null", () => {
    expect(generateBotDisplayName(null)).toBe("AI Note Maker");
  });

  it("should fall back to default name when display name is undefined", () => {
    expect(generateBotDisplayName(undefined)).toBe("AI Note Maker");
  });

  it("should fall back to default name when display name is empty string", () => {
    expect(generateBotDisplayName("")).toBe("AI Note Maker");
    expect(generateBotDisplayName("   ")).toBe("AI Note Maker");
  });

  it("should handle single character names", () => {
    expect(generateBotDisplayName("J Doe")).toBe("AI Note Maker · J");
  });

  it("should handle names with special characters", () => {
    expect(generateBotDisplayName("Jean-Pierre Martin")).toBe("AI Note Maker · Jean-Pierre");
    expect(generateBotDisplayName("O'Brien Smith")).toBe("AI Note Maker · O'Brien");
  });
});
