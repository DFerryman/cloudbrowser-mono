import type { Env } from './env.js';

/**
 * Sign-in emails through Cloudflare Email Service (the `send_email` binding `EMAIL`). The plan
 * named AWS SES; Email Service needs no credentials in the Worker and lives in the same account.
 * `wrangler dev` simulates sends locally, so in development the code is also logged.
 */
export async function sendSignInCode(env: Env, to: string, code: string) {
  if (env.ENVIRONMENT === 'development') console.log(`[dev] sign-in code for ${to}: ${code}`);
  if (!env.EMAIL) {
    if (env.ENVIRONMENT === 'development') return;
    throw new Error('send_email binding EMAIL is not configured');
  }
  const from = env.EMAIL_FROM ?? 'no-reply@example.com';
  try {
    await env.EMAIL.send({
      from: { email: from, name: 'CloudBrowser' },
      to,
      subject: `Your CloudBrowser sign-in code: ${code}`,
      text: `Your sign-in code is ${code}\n\nIt expires in 5 minutes. If you did not ask for it, ignore this email.\n\n你的登录验证码是 ${code}，5 分钟内有效。如果不是你本人操作，请忽略此邮件。`,
      html: `<p>Your sign-in code is</p><p style="font-size:24px;font-weight:600;letter-spacing:4px;font-family:monospace">${code}</p><p>It expires in 5 minutes. If you did not ask for it, ignore this email.</p><hr><p>你的登录验证码是 <b>${code}</b>，5 分钟内有效。如果不是你本人操作，请忽略此邮件。</p>`,
    });
  } catch (e) {
    const code = (e as { code?: string }).code;
    throw new Error(`Email Service send failed${code ? ` (${code})` : ''}: ${(e as Error).message}`);
  }
}
