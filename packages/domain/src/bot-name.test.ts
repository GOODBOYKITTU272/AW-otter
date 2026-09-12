import { describe, it, expect } from "vitest";
import { generateBotDisplayName } from "./bot-name";

describe("generateBotDisplayName", () => {
  it("should generate bot name with first name from display name", () => {
    expect(generateBotDisplayName("John Doe")).toBe("AW Echo · John");
    expect(generateBotDisplayName("Jane Smith")).toBe("AW Echo · Jane");
    expect(generateBotDisplayName("Alice")).toBe("AW Echo · Alice");
  });

  it("should handle multiple spaces between names", () => {
    expect(generateBotDisplayName("John   Doe")).toBe("AW Echo · John");
  });

  it("should handle leading and trailing whitespace", () => {
    expect(generateBotDisplayName("  John Doe  ")).toBe("AW Echo · John");
    expect(generateBotDisplayName("  Alice  ")).toBe("AW Echo · Alice");
  });

  it("should fall back to default name when display name is null", () => {
    expect(generateBotDisplayName(null)).toBe("AW Echo");
  });

  it("should fall back to default name when display name is undefined", () => {
    expect(generateBotDisplayName(undefined)).toBe("AW Echo");
  });

  it("should fall back to default name when display name is empty string", () => {
    expect(generateBotDisplayName("")).toBe("AW Echo");
    expect(generateBotDisplayName("   ")).toBe("AW Echo");
  });

  it("should handle single character names", () => {
    expect(generateBotDisplayName("J Doe")).toBe("AW Echo · J");
  });

  it("should handle names with special characters", () => {
    expect(generateBotDisplayName("Jean-Pierre Martin")).toBe("AW Echo · Jean-Pierre");
    expect(generateBotDisplayName("O'Brien Smith")).toBe("AW Echo · O'Brien");
  });
});
