import { useSyncExternalStore } from 'react';

const subscribe = (onChange: () => void) => {
  document.addEventListener('fullscreenchange', onChange);
  return () => document.removeEventListener('fullscreenchange', onChange);
};

/**
 * The element currently shown fullscreen, or undefined. While an element is fullscreen, only it
 * and its descendants are painted, so popups portaled to `document.body` (menus, dialogs, toasts)
 * must be portaled into it instead or they open invisibly.
 */
export function useFullscreenElement(): HTMLElement | undefined {
  return useSyncExternalStore(
    subscribe,
    () => (document.fullscreenElement as HTMLElement | null) ?? undefined,
    () => undefined,
  );
}
