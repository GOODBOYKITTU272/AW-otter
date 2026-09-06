import { describe, expect, it } from "vitest";
import { decryptToken, encryptToken } from "./crypto";

describe("encryptToken / decryptToken", () => {
  it("round-trips a token", () => {
    const encrypted = encryptToken(
      "super-secret-access-token",
      "test-encryption-key",
    );
    expect(encrypted).not.toContain("super-secret-access-token");
    expect(decryptToken(encrypted, "test-encryption-key")).toBe(
      "super-secret-access-token",
    );
  });

  it("produces a different ciphertext each time (random IV)", () => {
    const a = encryptToken("same-plaintext", "key");
    const b = encryptToken("same-plaintext", "key");
    expect(a).not.toBe(b);
  });

  it("fails to decrypt with the wrong key", () => {
    const encrypted = encryptToken("token", "correct-key");
    expect(() => decryptToken(encrypted, "wrong-key")).toThrow();
  });
});
