/**
 * Delivers new operator alerts (page 10: "alerts go to email and a chat webhook") from the api's
 * 5-minute cron. Each alert is sent once; the console keeps listing it until acknowledged.
 */
import { schema, type Db } from '@cloudbrowser/db';
import { asc, eq, inArray, isNull } from 'drizzle-orm';
import type { Env } from '../env.js';

const { alerts } = schema;

export async function deliverAlerts(env: Env, db: Db, now = new Date()): Promise<number> {
  const pending = await db.select().from(alerts).where(isNull(alerts.sentAt)).orderBy(asc(alerts.createdAt)).limit(50);
  if (!pending.length) return 0;
  const lines = pending.map((a) => `[${a.severity.toUpperCase()}] ${a.source}: ${a.title}`);
  const link = env.ADMIN_URL ? new URL('/alerts', env.ADMIN_URL).href : `${env.APP_URL}/admin/alerts`;
  const emails = (env.ALERT_EMAILS ?? '').split(',').map((e) => e.trim()).filter(Boolean);
  const critical = pending.some((a) => a.severity === 'critical');
  try {
    if (env.ALERT_WEBHOOK_URL) {
      // Slack-compatible incoming webhook payload (also accepted by Mattermost, Discord's /slack, Feishu bots).
      const res = await fetch(env.ALERT_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: `${lines.join('\n')}\n${link}` }),
      });
      if (!res.ok) throw new Error(`alert webhook HTTP ${res.status}`);
    }
    if (emails.length && env.EMAIL) {
      for (const to of emails) {
        await env.EMAIL.send({
          from: { email: env.EMAIL_FROM ?? 'no-reply@example.com', name: 'Nevazu alerts' },
          to,
          subject: `${critical ? '[CRITICAL] ' : ''}Nevazu: ${pending.length} new alert${pending.length > 1 ? 's' : ''}`,
          text: `${lines.join('\n')}\n\n${link}`,
        });
      }
    }
  } catch (e) {
    console.error('alert delivery failed; retrying next sweep', e);
    return 0;
  }
  await db.update(alerts).set({ sentAt: now }).where(inArray(alerts.id, pending.map((a) => a.id)));
  return pending.length;
}

export async function acknowledgeAlert(db: Db, id: number, by: string, now = new Date()) {
  await db.update(alerts).set({ acknowledgedAt: now, acknowledgedBy: by }).where(eq(alerts.id, id));
}
