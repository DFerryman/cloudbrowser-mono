import type { Env } from './env.js';

/**
 * Sign-in emails. The plan names AWS SES; on Cloudflare this initial version uses Resend's HTTP
 * API, and logs the code in development so the stack runs without an email account.
 */
export async function sendSignInCode(env: Env, to: string, code: string) {
  if (!env.RESEND_API_KEY) {
    if (env.ENVIRONMENT === 'development') {
      console.log(`[dev] sign-in code for ${to}: ${code}`);
      return;
    }
    throw new Error('RESEND_API_KEY is not configured');
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      from: env.EMAIL_FROM ?? 'CloudBrowser <no-reply@example.com>',
      to: [to],
      subject: `Your CloudBrowser sign-in code: ${code}`,
      text: `Your sign-in code is ${code}\n\nIt expires in 5 minutes. If you did not ask for it, ignore this email.\n\n你的登录验证码是 ${code}，5 分钟内有效。`,
    }),
  });
  if (!res.ok) throw new Error(`email provider returned ${res.status}: ${await res.text()}`);
}
