/**
 * Two-factor sign-in with an authenticator app (TOTP, RFC 6238), on Better Auth's two-factor
 * plugin. Users set it up in Settings → Security by scanning a QR code; afterwards every email-code
 * sign-in asks for a current 6-digit code (or a one-time backup code) before a session exists.
 *
 * Accounts here have no password, so the plugin runs passwordless. In exchange, changes to an
 * enabled second factor need a current code from it: a stolen session alone can neither switch 2FA
 * off, mint new backup codes, nor read the authenticator secret again.
 */
import { createOTP } from '@better-auth/utils/otp';
import { APIError, createAuthMiddleware, getSessionFromCtx } from 'better-auth/api';
import { symmetricDecrypt } from 'better-auth/crypto';
import { twoFactor } from 'better-auth/plugins';

/**
 * Sign-in endpoints whose new session waits for the second factor. Email codes are ours; so are
 * registration links, which only ever go to addresses without an account, but a second link from
 * the same sign-up could be opened after the new account turned two-step verification on.
 * Passkey sign-ins are exempt: they require user verification (auth.ts), two factors in one.
 */
const FIRST_FACTOR_PATHS = new Set(['/sign-in/email-otp', '/magic-link/verify', '/sign-in/email', '/sign-in/username', '/sign-in/phone-number']);
const TOTP = { digits: 6, period: 30 } as const;
/** The plugin's own account lock for failed codes: 10 in a row lock it for 15 minutes. */
const MAX_FAILED_CODES = 10;
const LOCK_MS = 15 * 60_000;

type TwoFactorRow = { id: string; secret: string; backupCodes: string; verified?: boolean | null; failedVerificationCount?: number | null; lockedUntil?: Date | null };

export function twoFactorPlugin() {
  const plugin = twoFactor({ issuer: 'Nevazu', allowPasswordless: true, totpOptions: TOTP });
  // The plugin challenges password sign-ins only. Email codes are this app's first factor, so its
  // challenge (session withheld until a TOTP or backup code is verified) must cover them as well.
  return {
    ...plugin,
    hooks: { after: plugin.hooks.after.map((hook) => ({ ...hook, matcher: (ctx: { path?: string }) => FIRST_FACTOR_PATHS.has(ctx.path ?? '') })) },
  };
}

/** Changes to an enabled second factor require a current code from it (see the module comment). */
export const twoFactorGuard = createAuthMiddleware(async (ctx) => {
  // The authenticator secret is shown once, while setting up; it is never readable again.
  if (ctx.path === '/two-factor/get-totp-uri') throw new APIError('NOT_FOUND');
  if (ctx.path !== '/two-factor/disable' && ctx.path !== '/two-factor/generate-backup-codes') return;
  const session = await getSessionFromCtx(ctx);
  if (!session) throw new APIError('UNAUTHORIZED');
  const row = await ctx.context.adapter.findOne<TwoFactorRow>({ model: 'twoFactor', where: [{ field: 'userId', value: session.user.id }] });
  // Nothing confirmed yet (setup abandoned half-way): cancelling needs no code.
  if (!row || row.verified === false) return;
  if (row.lockedUntil && new Date(row.lockedUntil).getTime() > Date.now()) {
    throw new APIError('TOO_MANY_REQUESTS', { message: 'Too many incorrect codes. Try again in 15 minutes.', code: 'ACCOUNT_TEMPORARILY_LOCKED' });
  }
  const code = typeof (ctx.body as { code?: unknown } | undefined)?.code === 'string' ? (ctx.body as { code: string }).code.trim() : '';
  const ok = /^\d{6}$/.test(code)
    ? await createOTP(await symmetricDecrypt({ key: ctx.context.secretConfig, data: row.secret }), TOTP).verify(code)
    : ctx.path === '/two-factor/disable' && code.length > 0 && (await backupCodes(ctx.context.secretConfig, row.backupCodes)).includes(code);
  if (!ok) {
    const failed = (row.failedVerificationCount ?? 0) + 1;
    await ctx.context.adapter.update({
      model: 'twoFactor',
      where: [{ field: 'id', value: row.id }],
      update: { failedVerificationCount: failed, ...(failed >= MAX_FAILED_CODES ? { lockedUntil: new Date(Date.now() + LOCK_MS) } : {}) },
    });
    throw new APIError('BAD_REQUEST', {
      message: ctx.path === '/two-factor/disable' ? 'Enter a current code from your authenticator app, or one of your backup codes.' : 'Enter a current code from your authenticator app.',
      code: 'INVALID_TWO_FACTOR_CODE',
    });
  }
  if (row.failedVerificationCount || row.lockedUntil) {
    await ctx.context.adapter.update({ model: 'twoFactor', where: [{ field: 'id', value: row.id }], update: { failedVerificationCount: 0, lockedUntil: null } });
  }
});

/** The plugin stores backup codes as encrypted JSON (its default `storeBackupCodes: 'encrypted'`). */
async function backupCodes(key: Parameters<typeof symmetricDecrypt>[0]['key'], stored: string): Promise<string[]> {
  try {
    const codes: unknown = JSON.parse(await symmetricDecrypt({ key, data: stored }));
    return Array.isArray(codes) ? codes.filter((c): c is string => typeof c === 'string') : [];
  } catch {
    return [];
  }
}
