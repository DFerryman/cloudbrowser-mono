import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { cn } from './cn.js';

function readWidth(key: string, fallback: number, min: number, max: number) {
  try {
    const saved = Number(localStorage.getItem(key));
    if (Number.isFinite(saved) && saved > 0) return Math.min(max, Math.max(min, saved));
  } catch {
    // Storage blocked: start from the default.
  }
  return fallback;
}

/**
 * A width the user drags between `min` and `max`, remembered per browser under `key`. `edge`
 * says which side of the element the handle sits on: a left sidebar grows to the right, a
 * right-hand panel grows to the left. Arrow keys move it in 16 px steps; Home/End jump to the
 * limits; double-clicking the handle restores the default.
 */
export function useResizableWidth({ key, min, max, initial, edge }: { key: string; min: number; max: number; initial: number; edge: 'left' | 'right' }) {
  const [width, setWidthState] = useState(() => readWidth(key, initial, min, max));
  const [dragging, setDragging] = useState(false);
  const start = useRef<{ x: number; width: number } | null>(null);

  const setWidth = useCallback((w: number) => {
    const clamped = Math.round(Math.min(max, Math.max(min, w)));
    setWidthState(clamped);
    try {
      localStorage.setItem(key, String(clamped));
    } catch {
      // Not remembered; the width still applies now.
    }
  }, [key, min, max]);

  useEffect(() => {
    if (!dragging) return;
    const previous = { cursor: document.body.style.cursor, select: document.body.style.userSelect };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    return () => {
      document.body.style.cursor = previous.cursor;
      document.body.style.userSelect = previous.select;
    };
  }, [dragging]);

  const handleProps = {
    role: 'separator' as const,
    'aria-orientation': 'vertical' as const,
    'aria-valuemin': min,
    'aria-valuemax': max,
    'aria-valuenow': width,
    tabIndex: 0,
    onPointerDown: (e: PointerEvent<HTMLElement>) => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      start.current = { x: e.clientX, width };
      setDragging(true);
    },
    onPointerMove: (e: PointerEvent<HTMLElement>) => {
      if (!start.current) return;
      const dx = e.clientX - start.current.x;
      setWidth(start.current.width + (edge === 'right' ? dx : -dx));
    },
    onPointerUp: (e: PointerEvent<HTMLElement>) => {
      start.current = null;
      setDragging(false);
      if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    },
    onDoubleClick: () => setWidth(initial),
    onKeyDown: (e: KeyboardEvent<HTMLElement>) => {
      const grow = edge === 'right' ? 'ArrowRight' : 'ArrowLeft';
      const shrink = edge === 'right' ? 'ArrowLeft' : 'ArrowRight';
      if (e.key === grow) setWidth(width + 16);
      else if (e.key === shrink) setWidth(width - 16);
      else if (e.key === 'Home') setWidth(min);
      else if (e.key === 'End') setWidth(max);
      else return;
      e.preventDefault();
    },
  };
  return { width, setWidth, dragging, handleProps };
}

/** The thin drag handle itself: invisible until hovered, focused or dragged. */
export function ResizeHandle({ edge, dragging, label, className, ...props }: ReturnType<typeof useResizableWidth>['handleProps'] & { edge: 'left' | 'right'; dragging: boolean; label: string; className?: string }) {
  return (
    <div
      {...props}
      aria-label={label}
      title={label}
      className={cn(
        'group absolute inset-y-0 z-20 w-3 cursor-col-resize touch-none outline-none',
        edge === 'right' ? '-right-1.5' : '-left-1.5',
        className,
      )}
    >
      <span
        className={cn(
          'absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-transparent transition-colors duration-150',
          'group-hover:w-0.5 group-hover:bg-accent group-focus-visible:w-0.5 group-focus-visible:bg-accent',
          dragging && 'w-0.5 bg-accent',
        )}
      />
      <span
        className={cn(
          'absolute top-1/2 left-1/2 h-8 w-1 -translate-x-1/2 -translate-y-1/2 bg-border-strong opacity-0 transition-opacity',
          'group-hover:opacity-100 group-focus-visible:opacity-100',
          dragging && 'bg-accent opacity-100',
        )}
      />
    </div>
  );
}
