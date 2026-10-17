import type { HTMLAttributes } from 'react';
import { cn } from './cn.js';

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('rounded-[var(--radius-card)] border border-border bg-bg', className)} {...props} />;
}

export function Section({ title, description, children, className }: { title: string; description?: string; children: React.ReactNode; className?: string }) {
  return (
    <Card className={cn('p-5', className)}>
      <h2 className="text-base font-semibold">{title}</h2>
      {description ? <p className="mt-1 text-sm text-muted">{description}</p> : null}
      <div className="mt-4">{children}</div>
    </Card>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('rounded-[var(--radius-control)] bg-surface-2 [animation:cb-pulse_1.5s_ease-in-out_infinite]', className)} />;
}
