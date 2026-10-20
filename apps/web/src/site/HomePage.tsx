import { REGION_AREAS } from '@cloudbrowser/contracts';
import { Button, cn, Eyebrow } from '@cloudbrowser/ui';
import { ArrowRight, Check, Cloud, Globe2, HardDrive, Lock, MonitorSmartphone, MoonStar, ShieldCheck, Wallet, Zap } from 'lucide-react';
import { Link, useNavigate } from 'react-router';
import { regionPlace } from '../features/instances/region-names.js';
import { useI18n } from '../lib/i18n.js';
import type { MessageKey } from '../messages/en.js';
import { usePublicPricing, useSignedIn } from './hooks.js';
import { container } from './PublicShell.js';

/** The three promises in the slogan. */
const PILLARS = [
  { key: 'cloud', icon: Cloud },
  { key: 'persist', icon: HardDrive },
  { key: 'ip', icon: Globe2 },
] as const;

const FEATURES = [
  { key: 'view', icon: Zap },
  { key: 'sleep', icon: MoonStar },
  { key: 'billing', icon: Wallet },
  { key: 'devices', icon: MonitorSmartphone },
] as const;

/** The public homepage: the promise (cloud browser, persistent, static IP), how it works, and the way in. */
export function HomePage() {
  const { t, locale } = useI18n();
  const navigate = useNavigate();
  const pricing = usePublicPricing();
  // The live region list, by continent; the same cached answer the pricing page uses.
  const regions = (pricing.data?.regions ?? []).filter((r) => r.acceptingNew);
  const areas = REGION_AREAS.map((area) => [area, regions.filter((r) => r.area === area).map((r) => regionPlace(r, locale)).sort()] as const).filter(([, list]) => list.length);
  const signedIn = useSignedIn();
  const go = () => navigate(signedIn ? '/browsers' : '/sign-in');

  return (
    <>
      <section className="relative isolate overflow-hidden">
        <HeroBackdrop />
        <div className={`${container} grid items-center gap-10 pt-12 pb-14 md:gap-14 md:pt-24 md:pb-28 lg:grid-cols-[1.1fr_1fr]`}>
          <div>
            <p className="inline-flex items-center gap-2.5 border border-border bg-bg px-3 py-1.5 text-[12px] font-medium text-muted">
              <span className="size-1.5 rounded-full bg-running" aria-hidden />
              {t('home.eyebrow')}
            </p>
            <h1 className="mt-6 text-[34px] leading-[1.06] font-semibold tracking-[-0.035em] sm:text-[48px] md:text-[56px] md:leading-[1.03] xl:text-[60px]">
              {t('home.title.lead')}{' '}
              <span className="text-subtle">{t('home.title.accent')}</span>
            </h1>
            <p className="mt-5 max-w-xl text-base leading-relaxed text-muted md:mt-6 md:text-lg">{t('home.subtitle')}</p>
            <div className="mt-8 flex flex-wrap gap-3 md:mt-10">
              <Button variant="primary" size="lg" className="group" onClick={go}>
                {signedIn ? t('nav.dashboard') : t('home.ctaStart')} <ArrowRight className="transition-transform group-hover:translate-x-0.5" />
              </Button>
              <Button size="lg" onClick={() => navigate('/pricing')}>
                {t('home.ctaPricing')}
              </Button>
            </div>
            {pricing.data && !signedIn ? (
              <p className="mt-4 flex items-center gap-2 text-sm text-muted">
                <Check className="size-4 shrink-0 text-fg" aria-hidden />
                {t('home.trialNote', { minutes: pricing.data.trial.minutes })}
              </p>
            ) : null}
            <ul className="mt-8 hidden flex-wrap gap-x-5 gap-y-2 text-[13px] text-subtle sm:flex">
              {(['home.chip.chrome', 'home.chip.encrypted', 'home.chip.devices'] as const).map((k) => (
                <li key={k} className="flex items-center gap-1.5">
                  <ShieldCheck className="size-3.5" aria-hidden /> {t(k)}
                </li>
              ))}
            </ul>
          </div>
          <BrowserMock />
        </div>
      </section>

      <section className={`${container} pb-14 md:pb-24`}>
        <div className="mb-8 max-w-2xl md:mb-12">
          <Eyebrow>{t('home.pillars.eyebrow')}</Eyebrow>
          <h2 className="mt-3 text-[28px] leading-tight font-semibold tracking-[-0.03em] md:text-[40px]">{t('home.pillars.title')}</h2>
        </div>
        <div className="grid gap-px border border-border bg-border md:grid-cols-3">
          {PILLARS.map(({ key, icon: Icon }, n) => (
            <article key={key} className="group bg-bg p-6 transition-colors duration-200 hover:bg-surface md:p-8">
              <div className="flex items-center justify-between">
                <span className="grid size-10 shrink-0 place-items-center bg-fg text-bg" aria-hidden>
                  <Icon className="size-5" />
                </span>
                <span className="font-mono text-xs text-subtle" aria-hidden>{String(n + 1).padStart(2, '0')}</span>
              </div>
              <h3 className="mt-8 text-lg font-semibold tracking-tight md:mt-12 md:text-xl">{t(`home.p.${key}.title`)}</h3>
              <p className="mt-2 text-sm leading-relaxed text-muted">{t(`home.p.${key}.body`)}</p>
            </article>
          ))}
        </div>
        <div className="grid grid-cols-2 gap-px border-x border-b border-border bg-border lg:grid-cols-4">
          {FEATURES.map(({ key, icon: Icon }) => (
            <div key={key} className="bg-bg p-5 md:p-6">
              <Icon className="size-4 text-subtle" aria-hidden />
              <h3 className="mt-4 text-sm font-semibold md:mt-5 md:text-base">{t(`home.f.${key}.title`)}</h3>
              <p className="mt-1 hidden text-sm leading-relaxed text-muted sm:block">{t(`home.f.${key}.body`)}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="border-y border-border bg-surface">
        <div className={`${container} py-14 md:py-24`}>
          <Eyebrow>{t('home.how.eyebrow')}</Eyebrow>
          <h2 className="mt-3 text-[28px] leading-tight font-semibold tracking-[-0.03em] md:text-[40px]">{t('home.how.title')}</h2>
          <ol className="mt-8 grid gap-6 md:mt-12 md:grid-cols-3 md:gap-8">
            {([1, 2, 3] as const).map((n) => (
              <li key={n} className="flex gap-4 border-t border-fg pt-5 md:block md:pt-6">
                <span className="font-mono text-sm font-medium text-subtle">{String(n).padStart(2, '0')}</span>
                <div>
                  <h3 className="text-base font-semibold tracking-tight md:mt-4 md:text-lg">{t(`home.how.${n}.title`)}</h3>
                  <p className="mt-1.5 text-sm leading-relaxed text-muted">{t(`home.how.${n}.body`)}</p>
                </div>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {areas.length ? (
        <section className={`${container} grid gap-8 py-14 md:grid-cols-[1fr_1.5fr] md:gap-10 md:py-24`}>
          <div>
            <Eyebrow>{t('home.regions.eyebrow')}</Eyebrow>
            <h2 className="mt-3 text-[28px] leading-tight font-semibold tracking-[-0.03em] md:text-[40px]">{t('home.regions.title')}</h2>
            <p className="mt-4 max-w-sm text-sm leading-relaxed text-muted">{t('home.regions.body')}</p>
            <p className="mt-6 flex items-baseline gap-2">
              <span className="text-[44px] font-semibold leading-none tracking-[-0.03em] tabular-nums">{regions.length}</span>
              <span className="text-sm text-subtle">{t('home.regions.open')}</span>
            </p>
          </div>
          <ul className="border-t border-border">
            {areas.map(([area, places]) => (
              <li key={area} className="grid gap-1.5 border-b border-border py-4 sm:grid-cols-[180px_1fr] sm:gap-6 md:py-5">
                <p className="flex items-baseline gap-2 text-sm font-semibold">
                  {t(`area.${area}` as MessageKey)} <span className="text-xs font-normal text-subtle tabular-nums">{places.length}</span>
                </p>
                <p className="line-clamp-2 text-sm leading-relaxed text-muted sm:line-clamp-none">{places.join(locale === 'zh-CN' ? '、' : ' · ')}</p>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="relative isolate overflow-hidden bg-frame text-white">
        <div className="pointer-events-none absolute inset-0 -z-10 bg-[linear-gradient(to_right,rgb(255_255_255/0.06)_1px,transparent_1px),linear-gradient(to_bottom,rgb(255_255_255/0.06)_1px,transparent_1px)] bg-[size:56px_56px] [mask-image:radial-gradient(ellipse_at_top_right,black_10%,transparent_65%)]" aria-hidden />
        <div className={`${container} flex flex-col items-start justify-between gap-8 py-16 md:flex-row md:items-end md:py-24`}>
          <div>
            <h2 className="text-[32px] leading-[1.08] font-semibold tracking-[-0.03em] md:text-5xl md:leading-[1.05]">{t('home.cta.title')}</h2>
            <p className="mt-4 max-w-xl text-base text-white/65">{t('home.cta.body')}</p>
          </div>
          <div className="flex flex-wrap gap-3">
            <Button variant="ghost" size="lg" className="group bg-white text-frame hover:bg-white/90 hover:text-frame" onClick={go}>
              {signedIn ? t('nav.dashboard') : t('home.ctaStart')} <ArrowRight className="transition-transform group-hover:translate-x-0.5" />
            </Button>
            <Link to="/pricing">
              <Button variant="ghost" size="lg" className="border border-white/25 text-white hover:border-white/60 hover:bg-white/5 hover:text-white">{t('home.ctaPricing')}</Button>
            </Link>
          </div>
        </div>
      </section>
    </>
  );
}

/** A faint grid behind the hero, fading out from the top. */
function HeroBackdrop() {
  return (
    <div className="pointer-events-none absolute inset-0 -z-10" aria-hidden>
      <div className="absolute inset-0 bg-[linear-gradient(to_right,var(--color-border)_1px,transparent_1px),linear-gradient(to_bottom,var(--color-border)_1px,transparent_1px)] bg-[size:56px_56px] opacity-70 [mask-image:radial-gradient(ellipse_at_top,black_15%,transparent_65%)]" />
    </div>
  );
}

/** A drawing of the product: a browser window, the static IP websites see, and what persists. */
function BrowserMock() {
  const { t } = useI18n();
  return (
    <div className="relative mx-auto hidden w-full max-w-[560px] sm:block lg:mx-0" aria-hidden>
      <div className="relative border border-border bg-bg shadow-float">
        <div className="flex items-center gap-3 border-b border-border bg-surface px-4 py-2.5">
          <span className="flex gap-1.5">
            <span className="size-2.5 bg-border-strong" />
            <span className="size-2.5 bg-border-strong" />
            <span className="size-2.5 bg-border-strong" />
          </span>
          <span className="flex flex-1 items-center gap-2 truncate border border-border bg-bg px-3 py-1 font-mono text-[11px] text-muted">
            <Lock className="size-3 shrink-0" /> https://example.com
          </span>
          <span className="hidden items-center gap-1.5 font-mono text-[11px] text-muted sm:flex">
            <span className="size-1.5 rounded-full bg-running [animation:cb-pulse_1.6s_ease-in-out_infinite]" /> {t('home.mock.live')} · 32 ms
          </span>
        </div>
        <div className="p-5 sm:p-7">
          <Eyebrow>{t('home.mock.address')}</Eyebrow>
          <p className="mt-3 flex flex-wrap items-baseline gap-x-3 gap-y-2">
            <span className="font-mono text-[26px] font-medium tracking-tight sm:text-[36px]">203.0.113.24</span>
            <span className="border border-border px-1.5 py-0.5 font-mono text-[11px] font-medium text-muted">{t('home.mock.static')} · JP Tokyo</span>
          </p>
          <div className="mt-6 space-y-2.5">
            <div className="h-2.5 w-3/4 bg-surface-2" />
            <div className="h-2.5 w-full bg-surface-2" />
            <div className="h-2.5 w-5/6 bg-surface-2" />
          </div>
          <div className="mt-6 grid grid-cols-3 gap-3">
            <div className="h-14 bg-fg sm:h-16" />
            <div className="h-14 bg-surface-2 sm:h-16" />
            <div className="h-14 bg-surface-2 sm:h-16" />
          </div>
        </div>
      </div>
      <FloatCard className="-top-12 -right-3 hidden sm:flex" icon={<Globe2 className="size-4" />} label={t('home.mock.ipKept')} />
      <FloatCard className="-bottom-5 -left-4 hidden sm:flex [animation-delay:1.2s]" icon={<HardDrive className="size-4" />} label={t('home.mock.saved')} />
    </div>
  );
}

function FloatCard({ className, icon, label }: { className?: string; icon: React.ReactNode; label: string }) {
  return (
    <div className={cn('absolute items-center gap-2.5 border border-border bg-bg px-3 py-2 text-[13px] font-medium shadow-pop [animation:cb-float_5s_ease-in-out_infinite]', className)}>
      <span className="grid size-7 place-items-center bg-fg text-bg">{icon}</span>
      {label}
    </div>
  );
}
