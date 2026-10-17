import { Check, Copy } from 'lucide-react';
import { useState } from 'react';
import { cn } from './cn.js';

/**
 * Region and IP are the browser's identity and use the same format everywhere (page 1):
 * "JP · Tokyo · 203.0.113.24", IP in monospace, with a "Dedicated" label.
 */
export function RegionIpChip({
  country,
  city,
  ip,
  dedicatedLabel,
  copyLabel = 'Copy IP',
  pendingLabel = 'Reserving IP…',
  tone = 'default',
  className,
}: {
  country: string;
  city: string;
  ip: string | null;
  dedicatedLabel?: string;
  copyLabel?: string;
  pendingLabel?: string;
  tone?: 'default' | 'dark';
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    if (!ip) return;
    try {
      await navigator.clipboard.writeText(ip);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard permission denied; the IP is still selectable.
    }
  };
  return (
    <span
      className={cn(
        'inline-flex min-w-0 items-center gap-1.5 text-sm',
        tone === 'dark' ? 'text-zinc-300' : 'text-muted',
        className,
      )}
    >
      <span className="whitespace-nowrap">
        {country} · {city}
      </span>
      <span aria-hidden>·</span>
      {ip ? (
        <span className={cn('font-mono select-all', tone === 'dark' ? 'text-zinc-100' : 'text-fg')}>{ip}</span>
      ) : (
        <span className="italic">{pendingLabel}</span>
      )}
      {ip ? (
        <button type="button" onClick={copy} aria-label={copyLabel} title={copyLabel} className="rounded p-0.5 hover:bg-surface-2/60">
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
        </button>
      ) : null}
      {dedicatedLabel && ip ? (
        <span
          className={cn(
            'rounded border px-1.5 py-px text-xs font-medium',
            tone === 'dark' ? 'border-zinc-700 text-zinc-300' : 'border-border text-muted',
          )}
        >
          {dedicatedLabel}
        </span>
      ) : null}
    </span>
  );
}
