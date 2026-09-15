import { describe, it, expect } from "vitest";
import {
  validateEmailDomain,
  isAllowedEmailDomain,
  InvalidEmailDomainError,
} from "./email-validation";

describe("email-validation", () => {
  describe("validateEmailDomain", () => {
    it("should allow @applywizz.ai emails", () => {
      expect(() =>
        validateEmailDomain("user@applywizz.ai"),
      ).not.toThrow();
      expect(() =>
        validateEmailDomain("test.user@applywizz.ai"),
      ).not.toThrow();
      expect(() =>
        validateEmailDomain("admin@applywizz.ai"),
      ).not.toThrow();
    });

    it("should be case insensitive", () => {
      expect(() =>
        validateEmailDomain("User@ApplyWizz.Ai"),
      ).not.toThrow();
      expect(() =>
        validateEmailDomain("TEST@APPLYWIZZ.AI"),
      ).not.toThrow();
    });

    it("should trim whitespace", () => {
      expect(() =>
        validateEmailDomain("  user@applywizz.ai  "),
      ).not.toThrow();
    });

    it("should reject non-applywizz.ai domains", () => {
      expect(() =>
        validateEmailDomain("user@gmail.com"),
      ).toThrow(InvalidEmailDomainError);
      expect(() =>
        validateEmailDomain("user@example.com"),
      ).toThrow(InvalidEmailDomainError);
      expect(() =>
        validateEmailDomain("user@applywizz.com"),
      ).toThrow(InvalidEmailDomainError);
    });

    it("should reject malformed emails", () => {
      expect(() => validateEmailDomain("notanemail")).toThrow(
        InvalidEmailDomainError,
      );
      expect(() => validateEmailDomain("user@")).toThrow(
        InvalidEmailDomainError,
      );
    });
  });

  describe("isAllowedEmailDomain", () => {
    it("should return true for @applywizz.ai emails", () => {
      expect(isAllowedEmailDomain("user@applywizz.ai")).toBe(
        true,
      );
      expect(isAllowedEmailDomain("test.user@applywizz.ai")).toBe(
        true,
      );
    });

    it("should return false for other domains", () => {
      expect(isAllowedEmailDomain("user@gmail.com")).toBe(false);
      expect(isAllowedEmailDomain("user@example.com")).toBe(false);
      expect(isAllowedEmailDomain("notanemail")).toBe(false);
    });

    it("should be case insensitive", () => {
      expect(isAllowedEmailDomain("User@ApplyWizz.Ai")).toBe(
        true,
      );
    });

    it("should trim whitespace", () => {
      expect(isAllowedEmailDomain("  user@applywizz.ai  ")).toBe(
        true,
      );
    });
  });
});
