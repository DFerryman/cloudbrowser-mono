import { cn, Menu, MenuItem } from '@cloudbrowser/ui';
import { Check, Globe, Monitor, Moon, Sun } from 'lucide-react';
import { useI18n } from '../lib/i18n.js';
import { useTheme, type Theme } from '../lib/theme.js';

const THEME_ICON = { system: Monitor, light: Sun, dark: Moon } as const;
const iconButton =
  'inline-flex h-8 items-center gap-1.5 px-2 text-[13px] font-medium text-muted transition-colors hover:bg-surface-2 hover:text-fg [&_svg]:size-4';

/** Language switch: one click toggles between the two supported languages. */
export function LanguageButton({ className }: { className?: string }) {
  const { locale, setLocale, t } = useI18n();
  return (
    <button type="button" className={cn(iconButton, className)} onClick={() => setLocale(locale === 'en' ? 'zh-CN' : 'en')} aria-label={t('nav.language')}>
      <Globe aria-hidden /> <span>{locale === 'en' ? '中文' : 'EN'}</span>
    </button>
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
