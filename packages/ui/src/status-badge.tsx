import { AlertTriangle, CircleDot, Hourglass, Loader2, Moon, Trash2, type LucideIcon } from 'lucide-react';
import { cn } from './cn.js';

export type StatusTone = 'running' | 'progress' | 'sleeping' | 'waiting' | 'error' | 'deleted';

const TONES: Record<StatusTone, { icon: LucideIcon; color: string; spin?: boolean }> = {
  running: { icon: CircleDot, color: 'text-running' },
  progress: { icon: Loader2, color: 'text-starting', spin: true },
  waiting: { icon: Hourglass, color: 'text-starting' },
  sleeping: { icon: Moon, color: 'text-sleeping' },
  error: { icon: AlertTriangle, color: 'text-error' },
  deleted: { icon: Trash2, color: 'text-sleeping' },
};


/** Every status has an icon, a word and a color; never color alone (page 1). */
export function StatusBadge({ tone, label, icon, className }: { tone: StatusTone; label: string; icon?: LucideIcon; className?: string }) {
  const t = TONES[tone];
  const Icon = icon ?? t.icon;
  return (
    <span className={cn('inline-flex items-center gap-1.5 text-sm font-medium', className)}>
      <Icon className={cn('size-4', t.color, t.spin && 'animate-spin')} aria-hidden />
      <span>{label}</span>
    </span>
  );
}
