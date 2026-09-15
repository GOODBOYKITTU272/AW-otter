import { describe, it, expect } from "vitest";
import { isAllowedEmailDomain } from "@applywizz/auth";

describe("Login email validation", () => {
  it("should accept @applywizz.ai emails", () => {
    expect(isAllowedEmailDomain("user@applywizz.ai")).toBe(true);
    expect(isAllowedEmailDomain("admin@applywizz.ai")).toBe(true);
    expect(isAllowedEmailDomain("test.user@applywizz.ai")).toBe(true);
  });

  it("should reject non-applywizz.ai emails", () => {
    expect(isAllowedEmailDomain("user@gmail.com")).toBe(false);
    expect(isAllowedEmailDomain("user@example.com")).toBe(false);
    expect(isAllowedEmailDomain("user@applywizz.com")).toBe(false);
  });

  it("should be case insensitive", () => {
    expect(isAllowedEmailDomain("User@ApplyWizz.Ai")).toBe(true);
    expect(isAllowedEmailDomain("TEST@APPLYWIZZ.AI")).toBe(true);
  });

  it("should trim whitespace", () => {
    expect(isAllowedEmailDomain("  user@applywizz.ai  ")).toBe(true);
  });
});
