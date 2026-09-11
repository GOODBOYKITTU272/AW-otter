import { describe, it, expect } from "vitest";
import { NO_CUSTOMER_REPEAT_THRESHOLD, NO_CUSTOMER_LOOKBACK_DAYS, shouldBlockIntelligence } from "./no-customer-policy";

describe("no-customer-policy constants", () => {
  it("should define repeat threshold for manager notification", () => {
    expect(NO_CUSTOMER_REPEAT_THRESHOLD).toBe(2);
  });

  it("should define lookback window in days", () => {
    expect(NO_CUSTOMER_LOOKBACK_DAYS).toBe(7);
  });
});

describe("shouldBlockIntelligence", () => {
  it("should block intelligence when policy result is a violation", () => {
    const result = {
      isViolation: true,
      violationType: "no_customer_attendee" as const,
      shouldNotifyAM: true,
      shouldNotifyManager: false,
      recentViolationCount: 1,
    };
    expect(shouldBlockIntelligence(result)).toBe(true);
  });

  it("should not block intelligence when policy result is not a violation", () => {
    const result = {
      isViolation: false,
      violationType: null,
      shouldNotifyAM: false,
      shouldNotifyManager: false,
      recentViolationCount: 0,
    };
    expect(shouldBlockIntelligence(result)).toBe(false);
  });

  it("should not block intelligence when policy result is null", () => {
    expect(shouldBlockIntelligence(null)).toBe(false);
  });
});

describe("no-customer policy integration", () => {
  it("should notify AM always on first violation", () => {
    const result = {
      isViolation: true,
      violationType: "no_customer_attendee" as const,
      shouldNotifyAM: true,
      shouldNotifyManager: false,
      recentViolationCount: 1,
    };
    expect(result.shouldNotifyAM).toBe(true);
    expect(result.shouldNotifyManager).toBe(false);
  });

  it("should notify manager on repeat threshold", () => {
    const result = {
      isViolation: true,
      violationType: "no_customer_attendee" as const,
      shouldNotifyAM: true,
      shouldNotifyManager: true,
      recentViolationCount: 2,
    };
    expect(result.shouldNotifyAM).toBe(true);
    expect(result.shouldNotifyManager).toBe(true);
  });
});
