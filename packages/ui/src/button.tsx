import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { cn } from './cn.js';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
type Size = 'sm' | 'md' | 'lg' | 'icon';

/**
 * Primary is solid ink, the one action that matters on a screen; secondary is a hairline outline;
 * ghost is for quiet icon actions, which stay soft until hovered.
 */
const variants: Record<Variant, string> = {
  primary: 'bg-fg text-bg hover:bg-fg/88',
  secondary: 'border border-border-strong bg-bg hover:border-fg/50 hover:bg-surface',
  ghost: 'text-muted hover:bg-surface-2 hover:text-fg',
  danger: 'bg-error text-white hover:bg-error/90',
};
const sizes: Record<Size, string> = {
  sm: 'h-8 px-3 text-[13px]',
  md: 'h-10 px-4 text-sm',
  lg: 'h-12 px-6 text-[15px]',
  icon: 'h-8 w-8 justify-center',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', className, type = 'button', ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cn(
        'inline-flex shrink-0 items-center gap-2 font-medium tracking-[-0.005em] whitespace-nowrap transition-[color,background-color,border-color,transform] duration-150 ease-out active:translate-y-px',
        'disabled:pointer-events-none disabled:opacity-40 [&_svg]:size-4 [&_svg]:shrink-0',
        variants[variant],
        sizes[size],
        className,
      )}
      {...props}
    />
  );
});
