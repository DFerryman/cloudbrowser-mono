import { createContext, useCallback, useContext, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cn } from './cn.js';
import { useFullscreenElement } from './fullscreen.js';

type Toast = { id: number; message: string; tone: 'info' | 'error' };
const Ctx = createContext<(message: string, tone?: Toast['tone']) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((message: string, tone: Toast['tone'] = 'info') => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-3), { id, message, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 5000);
  }, []);
  const fullscreen = useFullscreenElement();
  const list = (
    <div aria-live="polite" className="pointer-events-none fixed right-4 bottom-4 z-[60] flex w-[min(380px,calc(100vw-32px))] flex-col gap-2">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={cn(
            'pointer-events-auto border border-l-4 bg-bg px-4 py-3 text-sm shadow-[0_8px_24px_-12px_rgb(0_0_0/0.3)] [animation:cb-in_150ms_var(--ease-out)]',
            t.tone === 'error' ? 'border-error/40 border-l-error' : 'border-border-strong border-l-fg',
          )}
        >
          {t.message}
        </div>
      ))}
    </div>
  );
  return (
    <Ctx.Provider value={push}>
      {children}
      {/* A fullscreen element hides everything outside it, toasts included. */}
      {fullscreen ? createPortal(list, fullscreen) : list}
    </Ctx.Provider>
  );
}

export const useToast = () => useContext(Ctx);
