import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../../lib/api.js';
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
  if (!loading) {
    loading = new Promise<Turnstile>((resolve, reject) => {
      const s = document.createElement('script');
      const fail = () => {
        window.clearTimeout(timer);
        s.remove();
        reject(new Error('turnstile'));
      };
      const timer = window.setTimeout(fail, 15_000);
      s.src = SCRIPT;
      s.async = true;
      s.onload = () => {
        window.clearTimeout(timer);
        if (window.turnstile) resolve(window.turnstile);
        else fail();
      };
      s.onerror = fail;
      document.head.appendChild(s);
    }).catch((err) => {
      loading = null;
      throw err;
    });
  }
  return loading;
}

/**
 * Cloudflare Turnstile on the forms that send an email (sign-in and sign-up). Off when the api has
 * no site key (local development, tests). Consume each token once, then reset only after the
 * protected request completes so its token remains valid while the server checks it.
 */
export function useTurnstile() {
  const { locale } = useI18n();
  const { theme } = useTheme();
  const options = useQuery({
    queryKey: ['sign-in-options'],
    queryFn: () => api<{ turnstileSiteKey: string | null }>('GET', '/api/auth/sign-in/options'),
    staleTime: 0,
    refetchOnMount: 'always',
    refetchOnWindowFocus: 'always',
  });
  const siteKey = options.data?.turnstileSiteKey ?? null;
  const ref = useRef<HTMLDivElement | null>(null);
  const widget = useRef<string | null>(null);
  const widgetSiteKey = useRef<string | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const currentToken = useRef<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [checking, setChecking] = useState(false);
  const [size, setSize] = useState<'flexible' | 'compact'>('compact');
  const pending = useRef<{ resolve: (value: string) => void; reject: (error: Error) => void } | null>(null);

  // Flexible widgets need at least 300px; use the compact widget inside narrower cards.
  useEffect(() => {
    if (!siteKey || !ref.current) return;
    const el = ref.current;
    const measure = () => setSize(el.clientWidth >= 300 ? 'flexible' : 'compact');
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [siteKey]);

  useEffect(() => {
    currentToken.current = null;
    setToken(null);
    setFailed(false);
    if (!siteKey || !ref.current) return;
    let cancelled = false;
    const el = ref.current;
    widgetSiteKey.current = siteKey;
    loadTurnstile()
      .then((ts) => {
        if (cancelled) return;
        widget.current = ts.render(el, {
          sitekey: siteKey,
          theme: theme === 'system' ? 'auto' : theme,
          language: locale === 'zh-CN' ? 'zh-cn' : 'en',
          size,
          appearance: 'always',
          retry: 'auto',
          'refresh-expired': 'auto',
          'refresh-timeout': 'auto',
          callback: (t: string) => {
            if (cancelled) return;
            if (pending.current) {
              pending.current.resolve(t);
              pending.current = null;
            } else {
              currentToken.current = t;
              setToken(t);
            }
            setFailed(false);
          },
          'expired-callback': () => {
            if (cancelled) return;
            currentToken.current = null;
            setToken(null);
          },
          'timeout-callback': () => {
            if (cancelled) return;
            currentToken.current = null;
            setToken(null);
          },
          'error-callback': () => {
            if (cancelled) return;
            currentToken.current = null;
            setToken(null);
            setFailed(true);
          },
        });
      })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => {
      cancelled = true;
      if (widget.current) window.turnstile?.remove(widget.current);
      widget.current = null;
      widgetSiteKey.current = null;
    };
  }, [siteKey, locale, theme, attempt, size]);

  const retry = useCallback(() => {
    currentToken.current = null;
    setToken(null);
    setFailed(false);
    void options.refetch();
    setAttempt((n) => n + 1);
  }, [options.refetch]);

  // Recover failed script loads and widget errors without asking for a page reload.
  useEffect(() => {
    if (!failed) return;
    const timer = window.setTimeout(retry, 8_000);
    return () => window.clearTimeout(timer);
  }, [failed, retry]);

  const reset = useCallback(() => {
    currentToken.current = null;
    setToken(null);
    if (widget.current) window.turnstile?.reset(widget.current);
    // A page opened before Turnstile was enabled may still have the old options.
    if (!siteKey) void options.refetch();
  }, [siteKey, options.refetch]);

  const headers = useCallback(async (): Promise<Record<string, string>> => {
    const fresh = await options.refetch();
    if (!fresh.isSuccess) throw new Error('Could not load security check settings');
    if (!fresh.data.turnstileSiteKey) return {};
    let value = widgetSiteKey.current === fresh.data.turnstileSiteKey ? currentToken.current : null;
    currentToken.current = null;
    setToken(null);
    if (!value) {
      setChecking(true);
      try {
        value = await new Promise<string>((resolve, reject) => {
          const timer = window.setTimeout(() => {
            pending.current = null;
            reject(new ApiError(403, { type: 'forbidden', title: 'Security check required', status: 403 }, 'CAPTCHA_FAILED'));
          }, 120_000);
          pending.current = {
            resolve: (value) => { window.clearTimeout(timer); resolve(value); },
            reject: (error) => { window.clearTimeout(timer); reject(error); },
          };
        });
      } finally {
        setChecking(false);
      }
    }
    return { 'cf-turnstile-response': value };
  }, [options.refetch]);

  useEffect(() => () => {
    pending.current?.reject(new Error('Security check cancelled'));
    pending.current = null;
  }, []);

  return {
    widget: siteKey ? <div ref={ref} className="mx-auto flex min-h-0 w-full justify-center" /> : null,
    ready: options.isSuccess && !options.isFetching && (!siteKey || !!token),
    failed: failed || options.isError,
    checking,
    retry,
    reset,
    headers,
  };
}
