import { createDb } from '@cloudbrowser/db';
import { describe, expect, it } from 'vitest';
import type { Message } from '../src/notifications/send.js';
import { renderEmail } from '../src/notifications/template.js';
import {
  closureCodeMessage, closureErasedMessage, closureStartedMessage, lowBalanceMessage, noticeMessage, retentionMessage, rewardMessage, runwayMessage,
  sendAlreadyRegistered, sendRegistrationLink, sendSignInCode,
} from '../src/notifications/user.js';
import { setup } from './helpers.js';

const url = 'https://nevazu.com';
const assertEmail = (message: Message) => {
  expect(message.text.length).toBeGreaterThan(100);
  expect(message.html).toContain('<html lang="en">');
  expect(message.html).toContain('Help &amp; support');
  expect(message.subject + message.text + message.html).not.toMatch(/[\u3400-\u9fff]/);
  expect(message.html).not.toMatch(/<script|<iframe|<form|<svg|javascript:|data:/i);
  expect(new TextEncoder().encode(message.html).length).toBeLessThan(100_000); // Avoid Gmail clipping.
};

describe('English transactional emails', () => {
  it('delivers both HTML and text for every authentication email without changing codes or registration links', async () => {
    const t = setup();
    t.env.APP_URL = url;
    const link = `${url}/sign-up/complete?token=single-use-token&source=email`;
    await sendSignInCode(t.env as never, 'person@example.com', '123456');
    await sendRegistrationLink(t.env as never, 'person@example.com', link, false);
    await sendRegistrationLink(t.env as never, 'person@example.com', link, true);
    await sendAlreadyRegistered(t.env as never, 'person@example.com');
    expect(t.emails).toHaveLength(4);
    t.emails.forEach(assertEmail);
    const [code, registration, fromSignIn, existing] = t.emails as (Message & { html: string })[];
    expect(code!.text).toContain('Your sign-in code is 123456');
    expect(code!.html).toContain('123456');
    expect(code!.text).toContain('Expires in 5 minutes');
    expect(code!.text).toContain('Never share your code');
    expect(registration!.text).toContain(`\n${link}\n`);
    expect(registration!.html).toContain('token=single-use-token&amp;source=email');
    expect(registration!.text).toContain('works once and expires in 30 minutes');
    expect(fromSignIn!.text).toContain('not linked to a Nevazu account');
    expect(existing!.text).toContain(`${url}/sign-in`);
    expect(existing!.text).not.toContain('/sign-up/complete');
  });

  it('preserves amounts, timing and retention consequences across balance warnings', () => {
    assertEmail(lowBalanceMessage(`${url}/billing`));
    for (const threshold of [1, 6, 24]) {
      const message = runwayMessage(threshold, 0.5, { availableMicros: 500_000, burnHourMicros: 1_000_000, fundedUntil: new Date('2026-10-22T12:30:00Z') }, `${url}/billing`);
      assertEmail(message);
      for (const fact of ['$0.50', '$1.00 per hour', '30 minutes', '2026-10-22 12:30 UTC', 'Never sleep', 'permanently deleted']) {
        expect(message.text).toContain(fact);
        expect(message.html).toContain(fact);
      }
    }
  });

  it.each(['d0', 'd3', 'final'] as const)('keeps exact per-browser deletion times and recovery conditions in the %s reminder', async (stage) => {
    const t = setup();
    const message = await retentionMessage(createDb(t.d1 as never), {
      retained: [
        { id: 'a', name: 'Work <one>', regionId: 'tyo1', deletesAt: new Date('2026-10-23T12:30:00Z') },
        { id: 'b', name: 'Research', regionId: 'unknown', deletesAt: new Date('2026-10-24T12:30:00Z') },
      ],
      depositsMicros: 3_000_000, minBalanceMicros: 1_000_000, restoreNeededMicros: 4_000_000,
    }, stage, `${url}/billing`);
    assertEmail(message);
    expect(message.text).toContain('Work <one> (Tokyo): 2026-10-23 12:30 UTC');
    expect(message.html).toContain('Work &lt;one&gt; (Tokyo)');
    expect(message.text).toContain('Research (unknown): 2026-10-24 12:30 UTC');
    for (const fact of ['add at least $4.00', '$3.00 in total', '$1.00 minimum balance', 'does not stop the deletion', 'None restarts by itself']) {
      expect(message.text).toContain(fact);
      expect(message.html).toContain(fact);
    }
  });

  it('escapes browser and reward names while keeping the original names in the text fallback', () => {
    const name = '<img src=x onerror="alert(1)"> & Notes';
    const messages = [
      noticeMessage('network_paused', { name }, `${url}/browsers/a`)!,
      ...['operator', 'suspended', 'frozen'].map((reason) => noticeMessage('stopped', { name, reason }, `${url}/browsers/a`)!),
      rewardMessage([{ taskId: 'task', title: { en: name, 'zh-CN': '不应发送' }, rewardMicros: 2_000_000 }], 7_000_000, `${url}/billing`),
      rewardMessage([{ taskId: 'Legacy task', title: null, rewardMicros: 1_000_000 }], null, `${url}/billing`),
    ];
    for (const message of messages) {
      assertEmail(message);
      expect(message.html).not.toContain('<img src=x');
    }
    expect(messages[0]!.text).toContain(name);
    expect(messages[0]!.html).toContain('&lt;img src=x');
    expect(messages[0]!.text).toContain('does not resume by itself');
    expect(messages[2]!.text).toContain('cannot start until the suspension is lifted');
    expect(messages[3]!.text).toContain('Nothing can run until support resolves the hold');
    expect(messages[2]!.text).not.toContain('open it to resume');
    expect(messages[4]!.text).toContain('balance is now $7.00');
    expect(messages[5]!.text).not.toContain('balance is now');
  });

  it('states the closure code, what closing deleted, where to ask about a refund, and the erasure', () => {
    const code = closureCodeMessage(url, '042917');
    assertEmail(code);
    expect(code.subject).toBe('Your Nevazu account closure code: 042917');
    expect(code.text).toContain('Your account closure code is 042917');
    expect(code.text).toContain('Expires in 5 minutes');
    expect(code.text).toContain('Nothing has changed yet');
    const started = closureStartedMessage(url, { browsers: 2, eraseDays: 30, supportEmail: 'support@nevazu.com' });
    assertEmail(started);
    for (const fact of ['signed out everywhere', 'your 2 browsers and their data are being permanently deleted', 'does not refund your credit by itself', 'write to support@nevazu.com from this address within 30 days', 'After 30 days']) {
      expect(started.text).toContain(fact);
    }
    const none = closureStartedMessage(url, { browsers: 0, eraseDays: 30, supportEmail: 'support@nevazu.com' });
    assertEmail(none);
    expect(none.text).toContain('you had no browsers to delete');
    const erased = closureErasedMessage(url, { supportEmail: 'support@nevazu.com' });
    assertEmail(erased);
    expect(erased.text).toContain('last email we send to this address');
    expect(erased.text).toContain('Questions: support@nevazu.com');
  });

  it('rejects executable action URLs and safely escapes every display field', () => {
    const content = { subject: '<subject>', category: '<category>', title: '<title>', preview: '<preview>', paragraphs: ['<paragraph>'], action: { label: '<button>', url: `${url}/?q="quoted"&a=b` }, note: '<note>' };
    const message = renderEmail(url, content);
    for (const field of ['subject', 'category', 'title', 'preview', 'paragraph', 'button', 'note']) {
      expect(message.html).toContain(`&lt;${field}&gt;`);
      if (field !== 'title') expect(message.html).not.toContain(`<${field}>`); // The document itself has a title element.
    }
    expect(message.html).toContain('q=&quot;quoted&quot;&amp;a=b');
    expect(() => renderEmail(url, { ...content, action: { label: 'Unsafe', url: 'javascript:alert(1)' } })).toThrow('HTTP or HTTPS');
    expect(() => renderEmail('data:text/html,bad', content)).toThrow('HTTP or HTTPS');
  });
});
