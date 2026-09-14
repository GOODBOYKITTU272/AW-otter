/**
 * Email domain validation for ApplyWizz Echo authentication.
 * Only @applywizz.ai email addresses are permitted to sign in.
 */

const ALLOWED_DOMAIN = "applywizz.ai";

export class InvalidEmailDomainError extends Error {
  constructor(email: string) {
    super(
      `Only @${ALLOWED_DOMAIN} email addresses are permitted to sign in. Received: ${email}`,
    );
    this.name = "InvalidEmailDomainError";
  }
}

/**
 * Validates that an email address belongs to the allowed domain.
 * @throws {InvalidEmailDomainError} if the email domain is not allowed
 */
export function validateEmailDomain(email: string): void {
  const normalized = email.trim().toLowerCase();
  if (!normalized.endsWith(`@${ALLOWED_DOMAIN}`)) {
    throw new InvalidEmailDomainError(email);
  }
}

/**
 * Checks if an email address belongs to the allowed domain without throwing.
 * @returns true if the email is from the allowed domain, false otherwise
 */
export function isAllowedEmailDomain(email: string): boolean {
  const normalized = email.trim().toLowerCase();
  return normalized.endsWith(`@${ALLOWED_DOMAIN}`);
}
