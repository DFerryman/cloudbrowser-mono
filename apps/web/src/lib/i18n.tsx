import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { en, type MessageKey } from '../messages/en.js';
import { zhCN } from '../messages/zh-CN.js';
import { ApiError } from './api.js';

export type Locale = 'en' | 'zh-CN';
const MESSAGES = { en, 'zh-CN': zhCN } as const;
const STORAGE_KEY = 'cb.locale';

function initialLocale(): Locale {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'en' || saved === 'zh-CN') return saved;
  } catch {
    // Storage blocked: fall back to the browser language.
  }
  return navigator.language.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en';
}

type Translate = (key: MessageKey, vars?: Record<string, string | number>) => string;
type I18n = { locale: Locale; setLocale: (l: Locale) => void; t: Translate; errorMessage: (e: unknown) => string };

const Ctx = createContext<I18n | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(initialLocale);
  const setLocale = useCallback((l: Locale) => {
    setLocaleState(l);
    document.documentElement.lang = l;
    try {
      localStorage.setItem(STORAGE_KEY, l);
    } catch {
      // Not persisted; the choice still applies to this tab.
    }
  }, []);
  const value = useMemo<I18n>(() => {
    const t: Translate = (key, vars) => {
      let s: string = MESSAGES[locale][key] ?? en[key] ?? key;
      if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v));
      return s;
    };
    const errorMessage = (e: unknown) => {
      if (e instanceof ApiError) {
        // Prefer a translated explanation for the specific limit when one is available.
        const limitKey = `error.${e.problem.type}.${e.problem.limit}` as MessageKey;
        const key = limitKey in en ? limitKey : `error.${e.problem.type}` as MessageKey;
        return locale === 'en' && e.problem.detail ? e.problem.detail : t(key in en ? key : 'error.internal');
      }
      return t('error.internal');
    };
    return { locale, setLocale, t, errorMessage };
  }, [locale, setLocale]);
  document.documentElement.lang = locale;
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useI18n() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useI18n outside I18nProvider');
  return v;
}

export function useRelativeTime() {
  const { t } = useI18n();
  return (iso: string | null) => {
    if (!iso) return null;
    const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
    if (mins < 1) return t('time.justNow');
    if (mins < 60) return t('time.minutes', { n: mins });
    const hours = Math.floor(mins / 60);
    if (hours < 24) return t('time.hours', { n: hours });
    const days = Math.floor(hours / 24);
    return days === 1 ? t('time.yesterday') : t('time.days', { n: days });
  };
}
