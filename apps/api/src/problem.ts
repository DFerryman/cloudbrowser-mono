import type { ErrorType, Problem } from '@cloudbrowser/contracts';

const TITLES: Record<ErrorType, string> = {
  unauthenticated: 'Sign in required',
  not_invited: 'This email has not been invited',
  forbidden: 'Not allowed',
  not_found: 'Not found',
  validation_failed: 'Invalid request',
  idempotency_key_required: 'Idempotency-Key header required',
  idempotency_key_reused: 'Idempotency-Key was used for a different request',
  operation_in_progress: 'Another action is in progress for this browser',
  invalid_state: 'Not possible in the current state',
  plan_limit: 'Plan limit reached',
  region_unavailable: 'New browsers are temporarily unavailable in this region',
  capacity_unavailable: 'Waiting for capacity',
  spend_guard_active: 'Temporarily unavailable',
  creation_frozen: 'Temporarily unavailable',
  viewer_unavailable: 'Live view unavailable',
  rate_limited: 'Too many requests',
  hours_exhausted: 'Active hours used up',
  billing_unavailable: 'Billing is not available',
  too_many_browsers: 'Delete browsers first',
  suspended: 'Suspended',
  step_up_required: 'Confirm with your passkey',
  insufficient_balance: 'Add credit first',
  price_unavailable: 'Prices are being updated',
  price_changed: 'Prices changed',
  account_frozen: 'Account on hold',
  internal: 'Something went wrong',
};

/** RFC 9457 problem details with a stable `type` code. */
export class ProblemError extends Error {
  constructor(
    readonly status: number,
    readonly type: ErrorType,
    readonly detail?: string,
    readonly extra: Partial<Pick<Problem, 'operationId' | 'limit'>> = {},
  ) {
    super(detail ?? type);
  }

  toResponse(): Response {
    const body: Problem = { type: this.type, title: TITLES[this.type], status: this.status, ...this.extra };
    if (this.detail) body.detail = this.detail;
    return new Response(JSON.stringify(body), {
      status: this.status,
      headers: { 'content-type': 'application/problem+json' },
    });
  }
}

export const problem = (status: number, type: ErrorType, detail?: string, extra?: ProblemError['extra']) =>
  new ProblemError(status, type, detail, extra);
