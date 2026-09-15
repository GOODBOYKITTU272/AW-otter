# ApplyWizz Echo Authentication Operations Guide

This guide covers the production setup and configuration required for the ApplyWizz Echo authentication system.

## Overview

Echo uses a two-factor authentication system:
1. **Email OTP** - One-time password sent via email for identity verification
2. **TOTP (Time-based One-Time Password)** - Microsoft Authenticator app with display name "AW Echo"

## Security Policies

- **Domain Restriction**: Only `@applywizz.ai` email addresses are permitted to sign in
- **No Password Authentication**: The system does not use traditional passwords
- **Invite-Only**: No public self-signup; users must be invited by administrators
- **MFA Required**: All users must enroll Microsoft Authenticator before gaining access

## Supabase Dashboard Configuration

### 1. Enable MFA (Multi-Factor Authentication)

Navigate to your Supabase project dashboard:

1. Go to **Authentication** → **Providers**
2. Scroll down to **Multi-Factor Authentication**
3. Enable **TOTP (Authenticator App)**
   - Toggle **Enable TOTP enrollment** to ON
   - Toggle **Enable TOTP verification** to ON
   - Set **Max enrolled factors per user** to 10 (default)

### 2. Configure Email Provider (SMTP)

To use a custom email sender (`noreply@applywizz.ai`) instead of Supabase's default:

1. Go to **Authentication** → **Providers** → **Email**
2. Click **Enable Custom SMTP**
3. Configure your SMTP settings:
   ```
   SMTP Host: [Your SMTP host, e.g., smtp.sendgrid.net]
   SMTP Port: 587 (or your provider's port)
   SMTP User: [Your SMTP username]
   SMTP Password: [Your SMTP password]
   Sender Email: noreply@applywizz.ai
   Sender Name: Apply Wizz
   ```

#### Recommended Email Providers

- **SendGrid**: Reliable transactional email service
  - Sign up at https://sendgrid.com
  - Create an API key with "Mail Send" permissions
  - Use `apikey` as SMTP user and your API key as password
  
- **AWS SES**: Cost-effective for high volume
  - Requires domain verification
  - SMTP credentials available in AWS Console
  
- **Postmark**: Developer-friendly with good deliverability
  - SMTP credentials in Server Settings

### 3. Customize Email Templates

1. Go to **Authentication** → **Email Templates**
2. Customize the **Magic Link** template (used for OTP emails):

```html
<h2>Your Sign-in Code for Echo</h2>
<p>Enter this code to sign in to ApplyWizz Echo:</p>
<h1 style="font-size: 32px; font-weight: bold; color: #2C76FF;">{{ .Token }}</h1>
<p>This code expires in 60 minutes.</p>
<p>If you didn't request this code, you can safely ignore this email.</p>
```

3. Update the **Confirm Signup** template if using invite flows:

```html
<h2>Welcome to ApplyWizz Echo</h2>
<p>You've been invited to join ApplyWizz Echo. Click the link below to set up your account:</p>
<p><a href="{{ .ConfirmationURL }}">Set up your account</a></p>
<p>This link expires in 24 hours.</p>
```

### 4. Configure Site URL and Redirect URLs

1. Go to **Authentication** → **URL Configuration**
2. Set **Site URL** to: `https://echo.applywizz.ai`
3. Add **Redirect URLs** (one per line):
   ```
   https://echo.applywizz.ai
   https://echo.applywizz.ai/**
   https://echo.applywizz.ai/auth/callback
   https://echo.applywizz.ai/auth/help
   ```

### 5. Rate Limiting (Optional but Recommended)

1. Go to **Authentication** → **Rate Limits**
2. Recommended settings for production:
   - **Email sent per hour**: 10 (prevents abuse)
   - **Token verifications per 5 minutes**: 30 (allows multiple login attempts)
   - **Sign in attempts per 5 minutes**: 20 (protects against brute force)

### 6. Disable Unused Providers

To reduce attack surface:

1. Go to **Authentication** → **Providers**
2. Ensure all OAuth providers are **disabled** (Google, GitHub, etc.)
3. Keep **Email** enabled (required for OTP)
4. Keep **Phone** disabled (not used)

## User Invitation Workflow

### Inviting a New User

Administrators can invite users using the Supabase dashboard or API:

#### Via Dashboard:
1. Go to **Authentication** → **Users**
2. Click **Invite user**
3. Enter the user's `@applywizz.ai` email address
4. The user will receive an email with instructions

#### Via API (for automated invites):
```typescript
const { data, error } = await supabase.auth.admin.inviteUserByEmail(
  'user@applywizz.ai'
);
```

### User First-Time Setup Flow

1. User clicks invite link in email
2. System redirects to login page
3. User enters email → receives OTP
4. User verifies email OTP
5. System prompts for Microsoft Authenticator enrollment
6. User scans QR code and names account "AW Echo"
7. User enters first TOTP code to verify enrollment
8. Setup complete - user is logged in

### Subsequent Login Flow

1. User navigates to login page
2. User enters email → receives OTP
3. User verifies email OTP
4. System prompts for Microsoft Authenticator code
5. User enters 6-digit code from "AW Echo" account
6. User is logged in

## Help Flow (Lost Authenticator)

If a user loses access to their Microsoft Authenticator:

1. User clicks "Get help" link on login page
2. User enters email → receives OTP
3. User verifies email OTP
4. System unenrolls old TOTP factor and generates new QR code
5. User scans new QR code with Microsoft Authenticator
6. User enters first TOTP code to verify new enrollment
7. User can now log in with new authenticator

## Monitoring and Maintenance

### Check Email Deliverability

Monitor email delivery in your SMTP provider's dashboard:
- **SendGrid**: Analytics → Email Activity
- **AWS SES**: Sending Statistics
- **Postmark**: Activity → Messages

### Monitor Failed Login Attempts

1. Go to **Authentication** → **Users**
2. Check **Last sign in** timestamps
3. Use Supabase Logs to investigate failed authentications

### Rotate SMTP Credentials

Best practice: rotate SMTP credentials every 90 days
1. Generate new credentials in your email provider
2. Update in Supabase **Authentication** → **Providers** → **Email** → **SMTP**
3. Test by sending yourself a test OTP

## Security Considerations

### Email Domain Validation

The application enforces `@applywizz.ai` domain restriction at the application level. This is **not** enforced by Supabase RLS or auth policies - it's validated in the frontend and should be considered a UX policy rather than a security boundary.

### MFA Enforcement

- TOTP enrollment is **mandatory** after email verification
- Users cannot access the application without completing TOTP enrollment
- Old TOTP factors are automatically unenrolled during the help flow

### Session Management

- JWT tokens expire after 1 hour (configurable in Supabase config)
- Refresh tokens are valid for 30 days
- Users must re-authenticate with email OTP + TOTP after token expiry

## Troubleshooting

### User not receiving OTP emails

1. Check SMTP configuration in Supabase dashboard
2. Verify sender domain is not blacklisted
3. Check user's spam folder
4. Test SMTP credentials with your email provider
5. Review Supabase logs for email delivery errors

### QR code not scanning in Microsoft Authenticator

1. Ensure QR code is displayed at sufficient size (current: 192x192px)
2. Check for good lighting conditions
3. Try manual entry: user can type the secret code instead
4. Ensure Microsoft Authenticator app is up to date

### TOTP codes not working

1. Check device time sync (TOTP requires accurate time)
2. Verify user is using the "AW Echo" account in their authenticator
3. Confirm factor is verified (check Supabase Users table)
4. Check if factor was accidentally unenrolled

### Rate limiting triggered

If legitimate users are being rate limited:
1. Review **Authentication** → **Rate Limits** settings
2. Consider increasing limits for production use
3. Check for potential abuse or bot traffic

## Rollback Plan

If issues arise with the new auth system:

1. The old password-based auth routes are deprecated but not deleted
2. Emergency rollback requires:
   - Reverting to previous git commit
   - Disabling MFA in Supabase dashboard
   - Re-enabling password authentication
3. **Note**: Rolling back will require users to reset passwords

## Support Contacts

- **Supabase Support**: https://supabase.com/support
- **SendGrid Support**: https://support.sendgrid.com
- **Microsoft Authenticator Issues**: Standard user device troubleshooting

## Appendix: Environment Variables

Required environment variables for the application:

```bash
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
```

These should be set in your deployment environment (Vercel, Railway, etc.) and match your Supabase project settings.

---

**Last Updated**: 2026-09-14  
**Document Version**: 1.0  
**Maintained By**: Engineering Team
