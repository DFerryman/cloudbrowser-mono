import * as D from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from './cn.js';
import { useFullscreenElement } from './fullscreen.js';

/**
 * A modal dialog. On phones it is a sheet along the bottom edge; from `sm` up it is centered.
 * The body scrolls on its own, so a `footer` (the dialog's actions) always stays in view.
 */
export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  footer,
  closeLabel = 'Close',
  size = 'md',
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
  /** Actions pinned below the scrolling body, e.g. Cancel and the primary button. */
  footer?: ReactNode;
  closeLabel?: string;
  /** `lg` for wide content (e.g. a form with a summary next to it). */
  size?: 'md' | 'lg';
}) {
  const container = useFullscreenElement();
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal container={container}>
        <D.Overlay className="fixed inset-0 z-40 bg-black/40 [animation:cb-fade_150ms_var(--ease-out)]" />
        <D.Content
          className={cn(
            'fixed z-50 flex flex-col overflow-hidden border border-border bg-bg shadow-xl',
            'inset-x-0 bottom-0 max-h-[92dvh] rounded-t-[var(--radius-card)] [animation:cb-sheet_200ms_var(--ease-out)]',
            'sm:inset-x-auto sm:bottom-auto sm:top-1/2 sm:left-1/2 sm:max-h-[90vh] sm:w-[calc(100vw-32px)] sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-[var(--radius-card)] sm:[animation:cb-in_150ms_var(--ease-out)]',
            size === 'lg' ? 'sm:max-w-[880px]' : 'sm:max-w-[520px]',
          )}
        >
          <div className={cn('shrink-0 px-6 pt-6 pr-12', footer ? 'border-b border-border pb-4' : null)}>
            <D.Title className="text-lg font-semibold">{title}</D.Title>
            {description ? <D.Description className="mt-1 text-sm text-muted">{description}</D.Description> : <D.Description className="sr-only">{title}</D.Description>}
          </div>
          <div className={cn('min-h-0 flex-1 overflow-y-auto overscroll-contain px-6 pt-5', footer ? 'pb-5' : 'pb-6')}>{children}</div>
          {footer ? <div className="shrink-0 border-t border-border bg-surface px-6 py-4 pb-[max(1rem,env(safe-area-inset-bottom))]">{footer}</div> : null}
          <D.Close aria-label={closeLabel} className="absolute top-4 right-4 rounded-md p-1 text-muted hover:bg-surface-2">
            <X className="size-4" />
          </D.Close>
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}
