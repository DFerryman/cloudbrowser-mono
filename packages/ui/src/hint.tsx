import type { HTMLAttributes } from 'react';
import { cn } from './cn.js';

/** A secondary explanation: small and soft, but still readable. Put the essentials in it, details in Docs. */
export function Hint({ className, ...props }: HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn('text-xs leading-relaxed text-subtle', className)} {...props} />;
}
