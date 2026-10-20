import * as D from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { cn } from './cn.js';
import { useFullscreenElement } from './fullscreen.js';
import { ResizeHandle, useResizableWidth } from './resizable.js';

function useViewportWidth() {
  const [w, setW] = useState(() => (typeof window === 'undefined' ? 1280 : window.innerWidth));
  useEffect(() => {
    const on = () => setW(window.innerWidth);
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  return w;
}

/**
 * A panel that slides in from the right edge, over a lightly dimmed page. From `sm` up the user
 * drags its left edge to make it wider or narrower (remembered under `storageKey`); on phones it
 * fills the screen. The body scrolls on its own, so the `footer` always stays in view.
 */
export function SidePanel({
  open,
  onOpenChange,
  title,
  description,
  icon,
  children,
  footer,
  closeLabel = 'Close',
  resizeLabel = 'Resize',
  storageKey,
  minWidth = 440,
  maxWidth = 980,
  defaultWidth = 600,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  icon?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  closeLabel?: string;
  resizeLabel?: string;
  storageKey: string;
  minWidth?: number;
  maxWidth?: number;
  defaultWidth?: number;
}) {
  const container = useFullscreenElement();
  const viewport = useViewportWidth();
  const max = Math.max(minWidth, Math.min(maxWidth, viewport - 72));
  const { width, dragging, handleProps } = useResizableWidth({ key: storageKey, min: minWidth, max, initial: Math.min(defaultWidth, max), edge: 'left' });
  const desktop = viewport >= 640;
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal container={container}>
        <D.Overlay className="fixed inset-0 z-40 bg-black/40 [animation:cb-fade_150ms_var(--ease-out)]" />
        <D.Content
          style={desktop ? { width: Math.min(width, max) } : undefined}
          className={cn(
            'fixed inset-y-0 right-0 z-50 flex w-full flex-col border-l border-border bg-bg shadow-float outline-none',
            'pb-[env(safe-area-inset-bottom)] [animation:cb-panel_220ms_var(--ease-out)]',
          )}
        >
          <div className="relative shrink-0 overflow-hidden border-b border-border px-5 pt-5 pb-4 pr-14 sm:px-7">
            <div className="relative flex items-center gap-3">
              {icon ? <span className="grid size-9 shrink-0 place-items-center border border-border bg-surface text-fg [&_svg]:size-4">{icon}</span> : null}
              <div className="min-w-0">
                <D.Title className="truncate text-lg font-semibold tracking-tight">{title}</D.Title>
                {description ? <D.Description className="truncate text-xs text-muted">{description}</D.Description> : <D.Description className="sr-only">{title}</D.Description>}
              </div>
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-5 sm:px-7">{children}</div>
          {footer ? <div className="shrink-0 border-t border-border bg-surface px-5 py-4 sm:px-7">{footer}</div> : null}
          {desktop ? <ResizeHandle {...handleProps} edge="left" dragging={dragging} label={resizeLabel} /> : null}
          <D.Close aria-label={closeLabel} className="absolute top-5 right-5 p-1.5 text-muted transition-colors hover:bg-surface-2 hover:text-fg">
            <X className="size-4" />
          </D.Close>
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}
