import { cn, Menu, MenuItem } from '@cloudbrowser/ui';
import { Check, Languages, Monitor, Moon, Sun } from 'lucide-react';
import { useI18n } from '../lib/i18n.js';
import { useTheme, type Theme } from '../lib/theme.js';

const THEME_ICON = { system: Monitor, light: Sun, dark: Moon } as const;
const iconButton =
  'inline-flex h-8 min-w-8 items-center justify-center gap-1.5 px-2 text-[13px] font-medium text-muted transition-colors hover:bg-surface-2 hover:text-fg [&_svg]:size-4';

const LANGUAGES = [
  { locale: 'en', label: 'English', short: 'EN' },
  { locale: 'zh-CN', label: '简体中文', short: '中' },
] as const;

/** Language switch for the public pages: an icon that opens the list of languages. */
export function LanguageButton({ className, align = 'end' }: { className?: string; align?: 'start' | 'end' }) {
  const { locale, setLocale, t } = useI18n();
  return (
    <Menu
      align={align}
      className="min-w-40"
      trigger={
        <button type="button" className={cn(iconButton, className)} aria-label={t('nav.language')} title={t('nav.language')}>
          <Languages aria-hidden />
        </button>
      }
    >
      {LANGUAGES.map((l) => (
        <MenuItem key={l.locale} onSelect={() => setLocale(l.locale)}>
          <span className="w-6 font-mono text-[11px] text-subtle" aria-hidden>{l.short}</span>
          <span className="flex-1" lang={l.locale}>{l.label}</span>
          {locale === l.locale ? <Check className="text-indigo" aria-hidden /> : null}
        </MenuItem>
      ))}
    </Menu>
  );
}

/** System, light or dark. */
export function ThemeButton({ className }: { className?: string }) {
  const { theme } = useTheme();
  const { t } = useI18n();
  const Icon = THEME_ICON[theme];
  return (
    <Menu
      trigger={
        <button type="button" className={cn(iconButton, className)} aria-label={t('theme.label')}>
          <Icon aria-hidden />
        </button>
      }
    >
      <ThemeItems />
    </Menu>
  );
}

/** The three theme choices as menu items, for the account menu and the theme button. */
export function ThemeItems() {
  const { theme, setTheme } = useTheme();
  const { t } = useI18n();
  return (
    <>
      {(['system', 'light', 'dark'] as Theme[]).map((v) => {
        const Icon = THEME_ICON[v];
        return (
          <MenuItem key={v} onSelect={() => setTheme(v)}>
            <Icon /> <span className="flex-1">{t(`theme.${v}`)}</span>
            {theme === v ? <Check aria-hidden /> : null}
          </MenuItem>
        );
      })}
    </>
  );
}
