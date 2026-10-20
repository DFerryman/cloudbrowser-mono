import { REGION_AREAS } from '@cloudbrowser/contracts';
import { Button, Eyebrow } from '@cloudbrowser/ui';
import { ArrowRight, Globe2, HardDrive, Lock, MonitorSmartphone, MoonStar, Wallet, Zap } from 'lucide-react';
import { useNavigate } from 'react-router';
import { regionPlace } from '../features/instances/region-names.js';
import { useI18n } from '../lib/i18n.js';
import { SUPPORT_EMAIL } from '../lib/site.js';
import type { MessageKey } from '../messages/en.js';
import { usePublicPricing, useSignedIn } from './hooks.js';
import { container } from './PublicShell.js';

const FEATURES = [
  { key: 'ip', icon: Globe2 },
  { key: 'data', icon: Lock },
  { key: 'view', icon: Zap },
  { key: 'sleep', icon: MoonStar },
  { key: 'billing', icon: Wallet },
  { key: 'devices', icon: MonitorSmartphone },
] as const;

/** The public homepage: what the product is, how it works, and the way in. */
export function HomePage() {
  const { t, locale } = useI18n();
  const navigate = useNavigate();
  // The live region list, by continent; the same cached answer the pricing page uses.
  const regions = (usePublicPricing().data?.regions ?? []).filter((r) => r.acceptingNew);
  const areas = REGION_AREAS.map((area) => [area, regions.filter((r) => r.area === area).map((r) => regionPlace(r, locale)).sort()] as const).filter(([, list]) => list.length);
  const signedIn = useSignedIn();
  const primary = signedIn ? (
    <Button variant="primary" size="lg" onClick={() => navigate('/browsers')}>
      {t('nav.dashboard')} <ArrowRight />
    </Button>
  ) : (
    <Button variant="primary" size="lg" onClick={() => navigate('/sign-in')}>
      {t('nav.signIn')} <ArrowRight />
    </Button>
  );

  return (
    <>
      <section className={`${container} grid items-center gap-12 pt-16 pb-20 md:grid-cols-[1.15fr_1fr] md:pt-24 md:pb-28`}>
        <div>
          <Eyebrow className="flex items-center gap-2">
            <span className="size-1.5 bg-running" aria-hidden /> {t('home.eyebrow')}
          </Eyebrow>
          <h1 className="mt-6 text-[40px] leading-[1.04] font-semibold tracking-[-0.03em] md:text-[64px] md:leading-[1.02]">{t('home.title')}</h1>
          <p className="mt-6 max-w-xl text-lg leading-relaxed text-muted">{t('home.subtitle')}</p>
          <div className="mt-10 flex flex-wrap gap-3">
            {primary}
            <Button size="lg" onClick={() => navigate('/pricing')}>
              {t('home.ctaPricing')}
            </Button>
          </div>
          {!signedIn ? <p className="mt-5 text-xs text-subtle">{t('home.inviteOnly')}</p> : null}
        </div>
        <BrowserMock />
      </section>

      <section className={`${container} pb-20 md:pb-28`}>
        <div className="grid gap-px border border-border bg-border sm:grid-cols-2 lg:grid-cols-3">
          {FEATURES.map(({ key, icon: Icon }, i) => (
            <div key={key} className="bg-bg p-7 md:p-8">
              <div className="flex items-center justify-between">
                <Icon className="size-5" aria-hidden />
                <span className="font-mono text-[11px] text-subtle">{String(i + 1).padStart(2, '0')}</span>
              </div>
              <h2 className="mt-8 text-lg font-semibold tracking-tight">{t(`home.f.${key}.title`)}</h2>
              <p className="mt-2 text-sm leading-relaxed text-muted">{t(`home.f.${key}.body`)}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="border-t border-border bg-surface">
        <div className={`${container} py-20 md:py-24`}>
          <Eyebrow>{t('home.how.eyebrow')}</Eyebrow>
          <h2 className="mt-3 text-2xl font-semibold tracking-tight md:text-[40px] md:leading-tight">{t('home.how.title')}</h2>
          <ol className="mt-12 grid gap-10 md:grid-cols-3 md:gap-8">
            {([1, 2, 3] as const).map((n) => (
              <li key={n} className="border-t-2 border-fg pt-6">
                <span className="font-mono text-sm font-medium">{String(n).padStart(2, '0')}</span>
                <h3 className="mt-4 text-lg font-semibold tracking-tight">{t(`home.how.${n}.title`)}</h3>
                <p className="mt-2 text-sm leading-relaxed text-muted">{t(`home.how.${n}.body`)}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section className={`${container} grid gap-10 py-20 md:grid-cols-[1fr_1.5fr] md:py-24`}>
        <div>
          <Eyebrow>{t('home.regions.eyebrow')}</Eyebrow>
          <h2 className="mt-3 text-2xl font-semibold tracking-tight md:text-[40px] md:leading-tight">{t('home.regions.title')}</h2>
          <p className="mt-4 max-w-sm text-sm leading-relaxed text-muted">{t('home.regions.body')}</p>
        </div>
        <ul className="border-t border-border">
          {areas.map(([area, places]) => (
            <li key={area} className="grid gap-1 border-b border-border py-5 sm:grid-cols-[180px_1fr] sm:gap-6">
              <p className="text-sm font-semibold">
                {t(`area.${area}` as MessageKey)} <span className="ml-1 font-mono text-xs font-normal text-subtle">{places.length}</span>
              </p>
              <p className="text-sm leading-relaxed text-muted">{places.join(locale === 'zh-CN' ? '、' : ' · ')}</p>
            </li>
          ))}
        </ul>
      </section>

      <section className="bg-fg text-bg">
        <div className={`${container} flex flex-col items-start justify-between gap-8 py-20 md:flex-row md:items-end`}>
          <div>
            <h2 className="text-3xl font-semibold tracking-tight md:text-5xl md:leading-[1.05]">{t('home.cta.title')}</h2>
            <p className="mt-4 max-w-xl text-base text-bg/70">{t('home.cta.body')}</p>
          </div>
          <div className="flex flex-wrap gap-3">
            <Button variant="ghost" size="lg" className="bg-bg text-fg hover:bg-bg/85" onClick={() => navigate(signedIn ? '/browsers' : '/sign-in')}>
              {signedIn ? t('nav.dashboard') : t('nav.signIn')} <ArrowRight />
            </Button>
            {!signedIn ? (
              <a href={`mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent('Nevazu invitation')}`}>
                <Button variant="ghost" size="lg" className="border border-bg/40 text-bg hover:border-bg hover:bg-transparent">{t('home.cta.request')}</Button>
              </a>
            ) : null}
          </div>
        </div>
      </section>
    </>
  );
}

/** A small drawing of a browser in a window; the dedicated IP websites see is the point. */
function BrowserMock() {
  const { t } = useI18n();
  return (
    <div className="border border-fg bg-bg shadow-[16px_16px_0_0_var(--color-surface-2)]" aria-hidden>
      <div className="flex items-center gap-3 border-b border-fg px-4 py-3">
        <span className="flex gap-1.5">
          <span className="size-2.5 border border-fg" />
          <span className="size-2.5 border border-fg" />
          <span className="size-2.5 bg-fg" />
        </span>
        <span className="flex-1 truncate border border-border px-3 py-1 font-mono text-[11px] text-muted">https://example.com</span>
      </div>
      <div className="p-6">
        <Eyebrow>{t('home.mock.address')}</Eyebrow>
        <p className="mt-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <span className="font-mono text-[28px] font-medium tracking-tight sm:text-[34px]">203.0.113.24</span>
          <span className="border border-fg px-1.5 py-0.5 font-mono text-[11px] font-medium">JP · Tokyo</span>
        </p>
        <div className="mt-6 space-y-2.5">
          <div className="h-2.5 w-3/4 bg-surface-2" />
          <div className="h-2.5 w-full bg-surface-2" />
          <div className="h-2.5 w-5/6 bg-surface-2" />
        </div>
        <div className="mt-6 grid grid-cols-3 gap-3">
          <div className="h-16 bg-fg" />
          <div className="h-16 bg-surface-2" />
          <div className="h-16 bg-surface-2" />
        </div>
        <div className="mt-6 flex items-center gap-3 text-xs text-muted">
          <HardDrive className="size-3.5" /> <span className="h-1 flex-1 bg-surface-2"><span className="block h-full w-1/3 bg-accent" /></span>
        </div>
      </div>
    </div>
  );
}
