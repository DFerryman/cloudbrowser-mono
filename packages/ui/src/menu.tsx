import * as M from '@radix-ui/react-dropdown-menu';
import type { ReactNode } from 'react';
import { cn } from './cn.js';
import { useFullscreenElement } from './fullscreen.js';

export function Menu({ trigger, children, align = 'end', className }: { trigger: ReactNode; children: ReactNode; align?: 'start' | 'end'; className?: string }) {
  const container = useFullscreenElement();
  return (
    <M.Root>
      <M.Trigger asChild>{trigger}</M.Trigger>
      <M.Portal container={container}>
        <M.Content
          align={align}
          sideOffset={4}
          collisionPadding={8}
          className={cn(
            'z-50 max-h-[var(--radix-dropdown-menu-content-available-height)] min-w-48 overflow-y-auto overscroll-contain border border-border bg-bg p-1 shadow-pop [animation:cb-in_150ms_var(--ease-out)]',
            className,
          )}
        >
          {children}
        </M.Content>
      </M.Portal>
    </M.Root>
  );
}

export function MenuItem({
  children,
  onSelect,
  danger,
  disabled,
}: {
  children: ReactNode;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
}) {
  return (
    <M.Item
      disabled={disabled}
      onSelect={onSelect}
      className={cn(
        'flex cursor-default items-center gap-2.5 px-2.5 py-2 text-sm outline-none select-none transition-colors data-[disabled]:opacity-40 data-[highlighted]:bg-surface-2 [&_svg]:size-4 [&_svg]:shrink-0',
        danger ? 'text-error data-[highlighted]:bg-error/8' : '[&_svg]:text-subtle data-[highlighted]:[&_svg]:text-fg',
      )}
    >
      {children}
    </M.Item>
  );
}

export const MenuSeparator = () => <M.Separator className="-mx-1 my-1 h-px bg-border" />;

/** A small heading inside a menu, e.g. a continent above its regions. */
export const MenuLabel = ({ children }: { children: ReactNode }) => (
  <M.Label className="px-2.5 pt-2.5 pb-1 text-[11px] font-semibold tracking-[0.12em] text-subtle uppercase">{children}</M.Label>
);
