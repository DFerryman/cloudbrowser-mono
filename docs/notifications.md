# Notifications

All email goes through Cloudflare Email Service (`send_email` binding `EMAIL`, sender `EMAIL_FROM`).
The code is in `apps/api/src/notifications`:

| File | What |
|---|---|
| `send.ts` | Sending (`sendTo`, `sendToUser`) and `notification_state`, the key/value table that remembers what was last said so nothing repeats |
| `template.ts` | Shared English HTML layout and matching plain-text fallback; escapes all dynamic content |
| `user.ts` | **User-facing**: emails about the user's own account |
| `admin.ts` | **Administrator**: operator alerts and their delivery |

Authentication emails are sent on request. Everything else runs from the api Worker's 5-minute cron (`scheduled` in
`apps/api/src/index.ts`): billing sweep → promotions → reward emails → admin watchers → alert delivery.

## 1. User-facing notifications

Rule of thumb: an email the user must act on (security, money running out, data about to be
deleted, a browser stopped by someone else) is never held back; it is already rare. Advisory and
"good news" emails are throttled, because they are the ones that become annoying.

| Email | Trigger | Repeat rule |
|---|---|---|
| Sign-in code | User requests it (including sign-up with an existing address) | Rate limited (5/min per IP and address) |
| Registration link | New address requests sign-up | Single-use link, expires in 30 minutes; same authentication rate limits |
| Already registered | Legacy registration-link request for an existing account | Points to sign-in; does not sign the recipient in |
| Credit lasts < 24 h / 6 h / 1 h | Funded time at current spending crosses each mark | Once per mark while credit falls; re-armed only at 1.25× the mark |
| Low balance | Available credit drops below the console's low-balance threshold | Once per dip; skipped if a funded-time warning already went out; **at most once per 3 days** (`LOW_BALANCE_COOLDOWN_MS`) |
| Credit ran out / deletion reminders | Usable credit is gone; never during a payment-dispute hold, which stops browsers but pauses deletion | Exactly three: at the time, after 3 days, 1 day before deletion |
| Browser stopped / network paused | Engine stopped a browser (admin, suspension, frozen) or paused its network | Once per event; a failed send is retried for up to a day (`NOTICE_RETRY_MS`) |
| **Reward credited** (new) | A promotion reward reached the balance | Rewards are collected for 10 minutes and confirmed in **one** email; **at most one per 24 h** (`REWARD_COOLDOWN_MS`) — later rewards wait and join the next email, none is lost |
| **Account closure code** (new) | User asks to close their account (Account → Close account) | At most one a minute; expires in 5 minutes, 5 tries |
| **Account closed** (new) | The closure is accepted: browsers deleted, the credit forfeited | Once |
| **Account data erased** (new) | 30 days after the closure, the personal data is erased | Once; the last email to the address. Nothing else is sent to a closed account (`sendToUser`) |

Funded-time warnings, credit-ran-out and deletion reminders (the final one too), browser notices
and reward emails count as sent only once the email went out; a failed one is sent again by the
next sweep. Without an `EMAIL` binding (local development) they are recorded as before.

Rewards credited before this release are marked as already notified by migration `0028`, so the
deploy does not email past rewards.

### Email presentation

All user-facing emails use English copy, regardless of the web app's language setting. Browser
names remain as entered by the user; rewards use their English task titles. Every send includes
both HTML and a complete plain-text alternative generated from the same content.

The shared layout follows the web design: neutral surfaces, square cards, hairline borders,
strong headings and a solid black primary action. Sign-in codes have a large monospace block;
financial amounts, browser names and UTC deletion deadlines have their own detail rows. Emails
include a preview line, support/privacy links and a copyable URL below each action button.
Authentication expiry and safety notes remain explicit.

The layout uses presentation tables, inline CSS, system fonts and a responsive mobile inset.
The hosted brand mark is optional decoration: the wordmark and all useful content remain readable
with remote images blocked. There are no scripts, forms, embedded web fonts or tracking pixels.
All dynamic text and link attributes are escaped, and action URLs must use HTTP or HTTPS.
`test/email-content.test.ts` covers all user-email variants, English copy, HTML escaping, links,
codes, amounts, deadlines and text fallbacks. Tests capture messages locally and do not send mail.

## 2. Administrator notifications

Every administrator notification is an operator alert (`raiseAlert` in `@cloudbrowser/db`): listed
in the console under Alerts until acknowledged. `deliverAlerts` batches new alerts per sweep:
**only `critical` alerts are emailed** to `ALERT_EMAILS`; `info` and `warning` alerts are excluded
from both email subjects and bodies, including mixed batches. All severities still go to the
`ALERT_WEBHOOK_URL` chat webhook if configured. **When `ALERT_EMAILS` is empty, critical alerts go
to `ADMIN_EMAIL_ALLOWLIST`.** Processed alerts are marked with `sent_at`, including info/warning
alerts skipped by email when no webhook is configured, so they do not stay queued or repeat.

| Alert | Raised by | Repeat rule |
|---|---|---|
| **Region out of inventory** (new): available inventory < 1, with the reason (quota used up vs. sync/prices stale) | api cron | Once per shortage, even if acknowledged while still empty; one "inventory again" info alert when it recovers |
| **User milestones** (new): 10, 20, 50, 100, 500 (then 1k, 2k, 5k, 10k) | api cron | Once per milestone; if several are passed at once, one alert for the highest |
| **Promotion budget used up** (new) | api cron | Once per budget; again if the operator changes the limit |
| Circuit breaker, drift findings, spend 80% / 100% of budget | reconciler | Deduplicated while open |
| Missing price, failed IP check, launch/provider errors, purge failures | engine | Deduplicated while open |
| Stripe or Creem dispute (account frozen) | api billing webhooks | Once per dispute |
| Stripe refund failed after it was taken off the balance | api billing webhooks | Once per refund |
| Stripe checkout cannot show the Terms checkbox (no Terms URL in Stripe) | api billing | Deduplicated while open |

## Suggested next notifications

User-facing (keep these few and quiet):

1. **Security notices** — new passkey added, 2FA turned on/off, backup codes regenerated. Send always
   (one per change); they protect the account and users expect them.
2. **Sign-in from a new device/location** — once per new device, never for repeat sign-ins.
3. **Top-up confirmation** — only if the provider's own receipt (Stripe's or Creem's) is not enough; otherwise skip to avoid two
   emails per payment.
4. **Refund processed** — once per refund.
5. **Notification preferences** — a Settings switch to turn off advisory emails (low balance,
   rewards). Required if any marketing-like email (new regions, new promotions) is ever added.

Administrator:

1. **Daily digest** (one email at ~09:00 UTC): new users, top-ups and revenue, running browsers,
   open alerts — replaces many small info alerts.
2. **First top-up by a user** and **large top-up** (e.g. ≥ $100) — revenue signals.
3. **Region inventory low** (e.g. 1–2 left) before it reaches 0, so quota can be raised in time.
4. **Webhook backlog** — Stripe or Creem events failing for more than an hour.
5. **Email delivery failures** — sends failing repeatedly (Email Service quota or domain issue).
6. **Launch failure rate** — many failed creates in a region in an hour.
7. **Sign-up spike / abuse** — unusual sign-ups or code requests from one network.
