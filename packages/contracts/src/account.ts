import { z } from 'zod';

/**
 * Closing an account (Terms sections 8 and 9): every browser is deleted, the unused paid credit is
 * refunded, and the personal data is erased once the refund is recorded or after 30 days.
 */

/** Why the user is leaving, when they say. Optional; kept with the closure record. */
export const ClosureReason = z.enum(['terms', 'price', 'not_needed', 'other']);
export type ClosureReason = z.infer<typeof ClosureReason>;

/**
 * Why the account cannot be closed from the app: a payment dispute hold (a refund would pay twice),
 * a browser an operator suspended (its records may be needed), or an operator's own account.
 */
export const ClosureBlocker = z.enum(['dispute', 'suspended', 'operator']);
export type ClosureBlocker = z.infer<typeof ClosureBlocker>;

/** How long a closure code works; the email says 5 minutes. */
export const CLOSURE_CODE_SECONDS = 300;
/** Wrong codes allowed before the code stops working and a new one must be sent. */
export const CLOSURE_CODE_ATTEMPTS = 5;
/** The personal data of a closed account is erased by then at the latest (Privacy Policy). */
export const CLOSURE_ERASE_DAYS = 30;
/** The refund the closed page and emails promise. */
export const CLOSURE_REFUND_DAYS = 14;

/** What closing would do now: shown before the user confirms. */
export const ClosurePreview = z.object({
  blocker: ClosureBlocker.nullable(),
  /** The browsers that would be permanently deleted. */
  browsers: z.array(z.object({ id: z.string(), name: z.string() })),
  balanceMicros: z.number().int(),
  /** Unused paid credit refunded to the original payment method; fixed once every browser is deleted. */
  refundMicros: z.number().int(),
  /** Credit that is not refunded: promotional, signup and courtesy credit. */
  forfeitMicros: z.number().int(),
});
export type ClosurePreview = z.infer<typeof ClosurePreview>;

export const CloseAccountBody = z.object({
  code: z.string().regex(/^\d{6}$/),
  reason: ClosureReason.optional(),
  /** The user ticked "I understand my browsers and their data are deleted permanently". */
  confirm: z.literal(true),
});
export type CloseAccountBody = z.infer<typeof CloseAccountBody>;

export const ClosureResult = z.object({
  browsers: z.number().int(),
  refundMicros: z.number().int(),
});
export type ClosureResult = z.infer<typeof ClosureResult>;
