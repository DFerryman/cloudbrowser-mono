import { cn } from '@cloudbrowser/ui';
import markUrl from '../assets/nevazu-mark.png';

/** A bounded box keeps the brand mark proportional in every navigation layout. */
export function BrandIcon({ className }: { className?: string }) {
  return (
    <img
      src={markUrl}
      alt=""
      aria-hidden="true"
      width={32}
      height={32}
      className={cn('size-8 shrink-0 object-contain', className)}
    />
  );
}
