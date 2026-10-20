import { forwardRef, type InputHTMLAttributes, type SelectHTMLAttributes } from 'react';
import { cn } from './cn.js';

const control =
  'h-10 w-full border border-border-strong bg-bg px-3 text-sm outline-none transition-[border-color,box-shadow] duration-150 placeholder:text-subtle hover:border-fg/40 focus:border-fg focus:shadow-[0_0_0_1px_var(--color-fg)] disabled:opacity-50';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...props }, ref) {
  return <input ref={ref} className={cn(control, className)} {...props} />;
});

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select({ className, ...props }, ref) {
  return <select ref={ref} className={cn(control, 'cb-select cursor-pointer pr-9', className)} {...props} />;
});

export function Label({ htmlFor, children }: { htmlFor?: string; children: React.ReactNode }) {
  return (
    <label htmlFor={htmlFor} className="mb-1.5 block text-[13px] font-medium">
      {children}
    </label>
  );
}
