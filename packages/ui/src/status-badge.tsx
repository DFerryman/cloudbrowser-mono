import { AlertTriangle, CircleDot, Hourglass, Loader2, Moon, Trash2, type LucideIcon } from 'lucide-react';
import { cn } from './cn.js';

export type StatusTone = 'running' | 'progress' | 'sleeping' | 'waiting' | 'error' | 'deleted';

const TONES: Record<StatusTone, { icon: LucideIcon; color: string; pill: string; spin?: boolean }> = {
  running: { icon: CircleDot, color: 'text-running', pill: 'bg-running/10 text-running' },
  progress: { icon: Loader2, color: 'text-starting', pill: 'bg-starting/10 text-starting', spin: true },
  waiting: { icon: Hourglass, color: 'text-starting', pill: 'bg-starting/10 text-starting' },
  sleeping: { icon: Moon, color: 'text-subtle', pill: 'bg-surface-2 text-muted' },
  error: { icon: AlertTriangle, color: 'text-error', pill: 'bg-error/10 text-error' },
  deleted: { icon: Trash2, color: 'text-subtle', pill: 'bg-surface-2 text-subtle' },
};


/** Every status has an icon, a word and a color; never color alone (page 1). `pill` sets it on a tint. */
export function StatusBadge({ tone, label, icon, className, pill }: { tone: StatusTone; label: string; icon?: LucideIcon; className?: string; pill?: boolean }) {
  const t = TONES[tone];
  const Icon = icon ?? t.icon;
  return (
    <span className={cn('inline-flex items-center gap-1.5 text-sm font-medium', pill && cn('h-6 px-2 text-xs font-medium', t.pill), className)}>
      <Icon className={cn(pill ? 'size-3.5' : 'size-4', !pill && t.color, t.spin && 'animate-spin')} aria-hidden />
      <span>{label}</span>
    </span>
  );
}
