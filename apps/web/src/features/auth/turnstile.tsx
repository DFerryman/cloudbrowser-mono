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
    nevazuTurnstileReady?: () => void;
  }
}

const SCRIPT = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=nevazuTurnstileReady';
let loading: Promise<Turnstile> | null = null;
function loadTurnstile(): Promise<Turnstile> {
  if (window.turnstile) return Promise.resolve(window.turnstile);
  if (!loading) {
    loading = new Promise<Turnstile>((resolve, reject) => {
      const s = document.createElement('script');
      const fail = () => {
        window.clearTimeout(timer);
        s.remove();
        delete window.nevazuTurnstileReady;
        reject(new Error('turnstile'));
      };
      const timer = window.setTimeout(fail, 15_000);
      s.src = SCRIPT;
      s.async = true;
      // Wait for the API's ready callback, rather than just the script download event.
      window.nevazuTurnstileReady = () => {
        window.clearTimeout(timer);
        if (window.turnstile) {
          delete window.nevazuTurnstileReady;
          resolve(window.turnstile);
        } else fail();
      };
      s.onerror = fail;
      document.head.appendChild(s);
    }).then((ts) => {
      loading = null;
      return ts;
    }).catch((err) => {
      loading = null;
      throw err;
    });
  }
  return loading;
}

/** A challenge exists only while a visitor is requesting an email. */
export function useTurnstile() {
  const { locale } = useI18n();
  const { theme } = useTheme();
  const options = useQuery({
    queryKey: ['sign-in-options'],
    queryFn: () => api<{ turnstileSiteKey: string | null }>('GET', '/api/auth/sign-in/options'),
    enabled: false,
  });
  const siteKey = options.data?.turnstileSiteKey ?? null;
  const ref = useRef<HTMLDivElement | null>(null);
  const [active, setActive] = useState(false);
  const [failed, setFailed] = useState(false);
  const [checking, setChecking] = useState(false);
  const [loadingWidget, setLoadingWidget] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [size, setSize] = useState<'flexible' | 'compact'>('flexible');
  const mounted = useRef(true);
  const pending = useRef<{ resolve: (value: string) => void; reject: (error: Error) => void } | null>(null);

  useEffect(() => {
    if (!active || !ref.current) return;
    const el = ref.current;
    const measure = () => setSize(el.clientWidth >= 300 ? 'flexible' : 'compact');
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [active]);

  useEffect(() => {
    if (!active || !siteKey || !ref.current) return;
    let cancelled = false;
    let widget: string | undefined;
    let instance: Turnstile | undefined;
    const el = ref.current;
    setLoadingWidget(true);
    loadTurnstile().then((ts) => {
      if (cancelled) return;
      instance = ts;
      widget = ts.render(el, {
        sitekey: siteKey,
        theme: theme === 'system' ? 'auto' : theme,
        language: locale === 'zh-CN' ? 'zh-cn' : 'en',
        size,
        appearance: 'always',
        retry: 'auto',
        'refresh-expired': 'auto',
        'refresh-timeout': 'auto',
        callback: (value: string) => {
          if (cancelled) return;
          pending.current?.resolve(value);
          pending.current = null;
          setFailed(false);
        },
        'error-callback': () => { if (!cancelled) setFailed(true); },
      });
      if (!widget) throw new Error('Security check did not render');
      setLoadingWidget(false);
    }).catch(() => {
      if (!cancelled) { setLoadingWidget(false); setFailed(true); }
    });
    return () => {
      cancelled = true;
      if (widget !== undefined) instance?.remove(widget);
    };
  }, [active, siteKey, locale, theme, attempt, size]);

  const retry = useCallback(() => {
    setLoadingWidget(true);
    setFailed(false);
    setAttempt((n) => n + 1);
  }, []);

  useEffect(() => {
    if (!active || !failed) return;
    const timer = window.setTimeout(retry, 8_000);
    return () => window.clearTimeout(timer);
  }, [active, failed, retry]);

  // Remove the widget after success or failure. A later email request starts a fresh challenge.
  const finish = useCallback(() => {
    pending.current?.reject(new Error('Security check cancelled'));
    pending.current = null;
    setActive(false);
    setLoadingWidget(false);
    setChecking(false);
    setFailed(false);
  }, []);

  const headers = useCallback(async (): Promise<Record<string, string>> => {
    const fresh = await options.refetch();
    if (!mounted.current) throw new Error('Security check cancelled');
    if (!fresh.isSuccess) throw new Error('Could not load security check settings');
    if (!fresh.data.turnstileSiteKey) return {};
    if (pending.current) throw new Error('Security check already in progress');
    setActive(true);
    setLoadingWidget(true);
    setChecking(true);
    try {
      const value = await new Promise<string>((resolve, reject) => {
        const timer = window.setTimeout(() => {
          pending.current = null;
          reject(new ApiError(403, { type: 'forbidden', title: 'Security check required', status: 403 }, 'CAPTCHA_FAILED'));
        }, 120_000);
        pending.current = {
          resolve: (value) => { window.clearTimeout(timer); resolve(value); },
          reject: (error) => { window.clearTimeout(timer); reject(error); },
        };
      });
      return { 'cf-turnstile-response': value };
    } finally {
      if (mounted.current) setChecking(false);
    }
  }, [options.refetch]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      pending.current?.reject(new Error('Security check cancelled'));
      pending.current = null;
    };
  }, []);

  return {
    widget: active && siteKey ? <div ref={ref} className={size === 'flexible' ? 'min-h-[65px] w-full [&>div]:w-full' : 'flex min-h-[140px] w-full justify-center'} /> : null,
    active,
    failed: active && (failed || options.isError),
    checking,
    loadingWidget,
    retry,
    finish,
    headers,
  };
}
