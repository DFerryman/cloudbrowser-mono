import type { Message } from './send.js';

/** Transactional email content is plain data: never interpolate caller-supplied HTML. */
export type EmailContent = {
  subject: string;
  category: string;
  title: string;
  preview: string;
  paragraphs: string[];
  code?: string;
  /** The text version's words before the code; sign-in codes by default. */
  codeLabel?: string;
  details?: { label: string; value: string }[];
  afterDetails?: string[];
  action?: { label: string; url: string };
  note?: string;
};

const escape = (value: string) => value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
function webUrl(value: string) {
  const url = new URL(value);
  if (!['https:', 'http:'].includes(url.protocol)) throw new Error('Email links must use HTTP or HTTPS');
  return value;
}

/** Inline styles and presentation tables work without remote fonts, scripts, or loaded images. */
export function renderEmail(appUrl: string, content: EmailContent): Message & { html: string } {
  const base = new URL(webUrl(appUrl)).origin;
  const action = content.action && { ...content.action, url: webUrl(content.action.url) };
  const paragraph = (s: string) => `<p style="margin:0 0 18px;color:#525252;font-size:15px;line-height:1.7">${escape(s)}</p>`;
  const details = content.details?.length ? `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:6px 0 24px;border-top:1px solid #e5e5e5">${content.details.map((row) => `<tr><td style="padding:14px 12px 14px 0;border-bottom:1px solid #e5e5e5;color:#525252;font-size:13px;line-height:1.6;vertical-align:top;overflow-wrap:anywhere">${escape(row.label)}</td><td align="right" style="padding:14px 0;border-bottom:1px solid #e5e5e5;color:#0a0a0a;font-size:14px;font-weight:600;line-height:1.6;vertical-align:top;overflow-wrap:anywhere">${escape(row.value)}</td></tr>`).join('')}</table>` : '';
  const text = [
    'Nevazu', content.title, ...content.paragraphs,
    ...(content.code ? [`${content.codeLabel ?? 'Your sign-in code is'} ${content.code}`, 'Expires in 5 minutes. Do not share this code.'] : []),
    ...(content.details?.map((d) => `${d.label}: ${d.value}`) ?? []),
    ...(content.afterDetails ?? []),
    ...(action ? [`${action.label}\n${action.url}`] : []),
    ...(content.note ? [content.note] : []),
    `Need a hand? ${base}/contact`, `Nevazu · Your browser, in the cloud.\n${base}/privacy`,
  ].join('\n\n');
  return {
    subject: content.subject,
    text,
    html: `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light"><title>${escape(content.subject)}</title><style>@media only screen and (max-width:600px){.email-wrap{padding:24px 12px!important}.email-body{padding:28px 24px!important}.email-title{font-size:28px!important}.email-code{font-size:32px!important;letter-spacing:6px!important}}</style></head>
<body style="margin:0;padding:0;background-color:#f8f8f8;color:#0a0a0a;font-family:Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;-webkit-text-size-adjust:100%">
<div style="display:none;font-size:1px;line-height:1px;color:#f8f8f8;max-height:0;max-width:0;opacity:0;overflow:hidden;mso-hide:all">${escape(content.preview)}</div>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" bgcolor="#f8f8f8"><tr><td class="email-wrap" align="center" style="padding:48px 20px">
<table role="presentation" width="560" cellspacing="0" cellpadding="0" style="width:100%;max-width:560px">
<tr><td style="padding:0 0 24px"><a href="${escape(base)}" style="color:#0a0a0a;text-decoration:none;font-size:20px;font-weight:700;letter-spacing:-0.5px"><img src="${escape(base)}/apple-touch-icon.png" width="32" height="32" alt="" style="display:inline-block;border:0;vertical-align:middle;margin-right:10px">Nevazu</a></td></tr>
<tr><td class="email-body" bgcolor="#ffffff" style="padding:40px;border:1px solid #e5e5e5">
<p style="margin:0 0 16px;font-size:11px;line-height:1.5;letter-spacing:2px;color:#737373;font-weight:600;text-transform:uppercase">${escape(content.category)}</p>
<h1 class="email-title" style="margin:0 0 24px;font-size:32px;line-height:1.15;letter-spacing:-1px;font-weight:600;color:#0a0a0a">${escape(content.title)}</h1>
${content.paragraphs.map(paragraph).join('')}
${content.code ? `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="margin:8px 0 24px"><tr><td align="center" bgcolor="#f8f8f8" style="padding:24px 12px;border:1px solid #e5e5e5"><div class="email-code" style="font-family:'SFMono-Regular',Consolas,'Liberation Mono',monospace;font-size:40px;line-height:1.4;letter-spacing:10px;font-weight:600;color:#0a0a0a">${escape(content.code)}</div><div style="margin-top:10px;font-size:12px;line-height:1.5;color:#737373">Expires in 5 minutes · Do not share this code</div></td></tr></table>` : ''}
${details}${(content.afterDetails ?? []).map(paragraph).join('')}
${action ? `<table role="presentation" cellspacing="0" cellpadding="0" style="margin:26px 0"><tr><td bgcolor="#0a0a0a" align="center" style="mso-padding-alt:14px 24px"><a href="${escape(action.url)}" style="display:inline-block;padding:14px 24px;border:1px solid #0a0a0a;background-color:#0a0a0a;color:#ffffff;text-decoration:none;font-size:14px;line-height:20px;font-weight:600;mso-padding-alt:0">${escape(action.label)} &rarr;</a></td></tr></table>` : ''}
${content.note ? `<p style="margin:24px 0 0;padding-top:20px;border-top:1px solid #e5e5e5;font-size:12px;line-height:1.7;color:#737373">${escape(content.note)}</p>` : ''}
${action ? `<p style="margin:18px 0 0;font-size:11px;line-height:1.7;color:#737373;overflow-wrap:anywhere;word-break:break-all">If the button does not work, copy this link into your browser:<br><a href="${escape(action.url)}" style="color:#525252;text-decoration:underline">${escape(action.url)}</a></p>` : ''}
</td></tr><tr><td style="padding:24px 0 0;font-size:12px;line-height:1.8;color:#737373">Nevazu · Your browser, in the cloud.<br><a href="${escape(base)}/contact" style="color:#525252;text-decoration:underline">Help &amp; support</a><span style="padding:0 8px">·</span><a href="${escape(base)}/privacy" style="color:#525252;text-decoration:underline">Privacy</a></td></tr>
</table></td></tr></table></body></html>`,
  };
}
