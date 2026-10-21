import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api.js';
import { useI18n } from '../../lib/i18n.js';
import { useTheme } from '../../lib/theme.js';

type Turnstile = {
  render(el: HTMLElement, opts: Record<string, unknown>): string;
  reset(id: string): void;
  remove(id: string): void;
};
declare global {
  interface Window {
    turnstile?: Turnstile;
  }
}

const SCRIPT = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
let loading: Promise<Turnstile> | null = null;
function loadTurnstile(): Promise<Turnstile> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  loading ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = SCRIPT;
    s.async = true;
    s.onload = () => (window.turnstile ? resolve(window.turnstile) : reject(new Error('turnstile')));
    s.onerror = () => {
      loading = null;
      reject(new Error('turnstile'));
    };
    document.head.appendChild(s);
  });
  return loading;
}

/**
 * Cloudflare Turnstile on the forms that send an email (sign-in and sign-up). Off when the api has
 * no site key (local development, tests). Each token works once: `headers()` hands out the current
 * one and resets the widget for the next request.
 */
export function useTurnstile() {
  const { locale } = useI18n();
  const { theme } = useTheme();
  const options = useQuery({
    queryKey: ['sign-in-options'],
    queryFn: () => api<{ turnstileSiteKey: string | null }>('GET', '/api/auth/sign-in/options'),
    staleTime: Infinity,
  });
  const siteKey = options.data?.turnstileSiteKey ?? null;
  const ref = useRef<HTMLDivElement | null>(null);
  const widget = useRef<string | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!siteKey || !ref.current) return;
    let cancelled = false;
    const el = ref.current;
    loadTurnstile()
      .then((ts) => {
        if (cancelled) return;
        widget.current = ts.render(el, {
          sitekey: siteKey,
          theme: theme === 'system' ? 'auto' : theme,
          language: locale === 'zh-CN' ? 'zh-cn' : 'en',
          size: 'flexible',
          appearance: 'interaction-only',
          callback: (t: string) => {
            setToken(t);
            setFailed(false);
          },
          'expired-callback': () => setToken(null),
          'error-callback': () => {
            setToken(null);
            setFailed(true);
          },
        });
      })
      .catch(() => setFailed(true));
    return () => {
      cancelled = true;
      if (widget.current) window.turnstile?.remove(widget.current);
      widget.current = null;
    };
  }, [siteKey, locale, theme]);

  const headers = useCallback((): Record<string, string> => {
    if (!siteKey || !token) return {};
    setToken(null);
    if (widget.current) window.turnstile?.reset(widget.current);
    return { 'cf-turnstile-response': token };
  }, [siteKey, token]);

  return {
    /** Where the widget renders (usually invisible; it shows only if a check needs the visitor). */
    widget: siteKey ? <div ref={ref} className="min-h-0 empty:hidden" /> : null,
    /** False while a required token is not there yet: the form waits for it. */
    ready: options.isSuccess && (!siteKey || !!token),
    failed,
    headers,
  };
}
