import { REGION_AREAS } from '@cloudbrowser/contracts';
import { Button, cn, Eyebrow } from '@cloudbrowser/ui';
import { ArrowRight, Check, Cloud, Globe2, HardDrive, Lock, MonitorSmartphone, MoonStar, ShieldCheck, Wallet, Zap } from 'lucide-react';
import { Link, useNavigate } from 'react-router';
import { regionPlace } from '../features/instances/region-names.js';
import { useI18n } from '../lib/i18n.js';
import type { MessageKey } from '../messages/en.js';
import { TONE, TONES, type Tone } from '../lib/tones.js';
import { usePublicPricing, useSignedIn } from './hooks.js';
import { container } from './PublicShell.js';

/** The three promises in the slogan, each with its own color through the page. */
const PILLARS = [
  { key: 'cloud', icon: Cloud, tone: 'indigo' },
  { key: 'persist', icon: HardDrive, tone: 'violet' },
  { key: 'ip', icon: Globe2, tone: 'teal' },
] as const;

const FEATURES = [
  { key: 'view', icon: Zap, tone: 'amber' },
  { key: 'sleep', icon: MoonStar, tone: 'sky' },
  { key: 'billing', icon: Wallet, tone: 'rose' },
  { key: 'devices', icon: MonitorSmartphone, tone: 'indigo' },
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
            <p className="inline-flex items-center gap-2 border border-border bg-bg/70 px-3 py-1.5 text-[12px] font-medium backdrop-blur">
              <span className="flex gap-1" aria-hidden>
                <span className="size-1.5 bg-indigo" />
                <span className="size-1.5 bg-violet" />
                <span className="size-1.5 bg-teal" />
              </span>
              {t('home.eyebrow')}
            </p>
            <h1 className="mt-6 text-[34px] leading-[1.06] font-semibold tracking-[-0.035em] sm:text-[48px] md:text-[56px] md:leading-[1.03] xl:text-[60px]">
              {t('home.title.lead')}{' '}
              <span className="bg-gradient-to-r from-indigo via-violet to-teal bg-clip-text text-transparent">{t('home.title.accent')}</span>
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
                <span className="grid size-5 place-items-center bg-teal/15 text-teal" aria-hidden>
                  <Check className="size-3.5" />
                </span>
                {t('home.trialNote', { minutes: pricing.data.trial.minutes })}
              </p>
            ) : null}
            <ul className="mt-8 hidden flex-wrap gap-x-5 gap-y-2 text-[13px] text-subtle sm:flex">
              {(['home.chip.chrome', 'home.chip.encrypted', 'home.chip.devices'] as const).map((k) => (
                <li key={k} className="flex items-center gap-1.5">
                  <ShieldCheck className="size-3.5 text-indigo" aria-hidden /> {t(k)}
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
          <h2 className="mt-3 text-2xl font-semibold tracking-tight md:text-[40px] md:leading-tight">{t('home.pillars.title')}</h2>
        </div>
        <div className="grid gap-3 md:grid-cols-3 md:gap-4">
          {PILLARS.map(({ key, icon: Icon, tone }) => (
            <article key={key} className={cn('group relative overflow-hidden border border-border bg-bg p-5 transition-colors hover:border-border-strong md:p-8')}>
              <span className={cn('absolute inset-x-0 top-0 h-0.5', TONE[tone].bg)} aria-hidden />
              <span className={cn('pointer-events-none absolute -top-16 -right-16 size-40 opacity-0 blur-3xl transition-opacity duration-500 group-hover:opacity-100', TONE[tone].soft)} aria-hidden />
              <div className="flex items-center gap-3 md:block">
                <span className={cn('grid size-10 shrink-0 place-items-center text-white md:size-12', TONE[tone].bg)} aria-hidden>
                  <Icon className="size-5 md:size-6" />
                </span>
                <h3 className="text-lg font-semibold tracking-tight md:mt-8 md:text-xl">{t(`home.p.${key}.title`)}</h3>
              </div>
              <p className="mt-3 text-sm leading-relaxed text-muted md:mt-3">{t(`home.p.${key}.body`)}</p>
            </article>
          ))}
        </div>
        <div className="mt-3 grid grid-cols-2 gap-px border border-border bg-border md:mt-4 lg:grid-cols-4">
          {FEATURES.map(({ key, icon: Icon, tone }) => (
            <div key={key} className="bg-bg p-4 md:p-6">
              <span className={cn('grid size-8 place-items-center', TONE[tone].soft, TONE[tone].text)} aria-hidden>
                <Icon className="size-4" />
              </span>
              <h3 className="mt-3 text-sm font-semibold md:mt-5 md:text-base">{t(`home.f.${key}.title`)}</h3>
              <p className="mt-1 hidden text-sm leading-relaxed text-muted sm:block">{t(`home.f.${key}.body`)}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="border-y border-border bg-surface">
        <div className={`${container} py-14 md:py-24`}>
          <Eyebrow>{t('home.how.eyebrow')}</Eyebrow>
          <h2 className="mt-3 text-2xl font-semibold tracking-tight md:text-[40px] md:leading-tight">{t('home.how.title')}</h2>
          <ol className="mt-8 grid gap-6 md:mt-12 md:grid-cols-3 md:gap-8">
            {([1, 2, 3] as const).map((n) => {
              const tone = PILLARS[n - 1]!.tone;
              return (
                <li key={n} className={cn('flex gap-4 border-t-2 pt-5 md:block md:pt-6', TONE[tone].border)}>
                  <span className={cn('font-mono text-sm font-semibold', TONE[tone].text)}>{String(n).padStart(2, '0')}</span>
                  <div>
                    <h3 className="text-base font-semibold tracking-tight md:mt-4 md:text-lg">{t(`home.how.${n}.title`)}</h3>
                    <p className="mt-1.5 text-sm leading-relaxed text-muted">{t(`home.how.${n}.body`)}</p>
                  </div>
                </li>
              );
            })}
          </ol>
        </div>
      </section>

      {areas.length ? (
        <section className={`${container} grid gap-8 py-14 md:grid-cols-[1fr_1.5fr] md:gap-10 md:py-24`}>
          <div>
            <Eyebrow>{t('home.regions.eyebrow')}</Eyebrow>
            <h2 className="mt-3 text-2xl font-semibold tracking-tight md:text-[40px] md:leading-tight">{t('home.regions.title')}</h2>
            <p className="mt-4 max-w-sm text-sm leading-relaxed text-muted">{t('home.regions.body')}</p>
            <p className="mt-6 flex items-baseline gap-2">
              <span className="text-[44px] font-semibold leading-none tracking-tight tabular-nums">{regions.length}</span>
              <span className="text-sm text-subtle">{t('home.regions.open')}</span>
            </p>
          </div>
          <ul className="border-t border-border">
            {areas.map(([area, places], i) => {
              const tone = TONES[i % TONES.length]!;
              return (
                <li key={area} className="grid gap-1.5 border-b border-border py-4 sm:grid-cols-[180px_1fr] sm:gap-6 md:py-5">
                  <p className="flex items-center gap-2 text-sm font-semibold">
                    <span className={cn('size-2', TONE[tone].bg)} aria-hidden />
                    {t(`area.${area}` as MessageKey)} <span className="font-mono text-xs font-normal text-subtle">{places.length}</span>
                  </p>
                  <p className="line-clamp-2 text-sm leading-relaxed text-muted sm:line-clamp-none">{places.join(locale === 'zh-CN' ? '、' : ' · ')}</p>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      <section className="relative isolate overflow-hidden bg-[#0b0b1a] text-white">
        <div className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(60%_120%_at_10%_0%,rgb(99_102_241/0.55),transparent_60%),radial-gradient(50%_100%_at_90%_100%,rgb(20_184_166/0.40),transparent_60%),radial-gradient(40%_80%_at_60%_0%,rgb(139_92_246/0.45),transparent_60%)]" aria-hidden />
        <div className={`${container} flex flex-col items-start justify-between gap-8 py-14 md:flex-row md:items-end md:py-20`}>
          <div>
            <h2 className="text-3xl font-semibold tracking-tight md:text-5xl md:leading-[1.05]">{t('home.cta.title')}</h2>
            <p className="mt-4 max-w-xl text-base text-white/75">{t('home.cta.body')}</p>
          </div>
          <div className="flex flex-wrap gap-3">
            <Button variant="ghost" size="lg" className="bg-white text-[#0b0b1a] hover:bg-white/85" onClick={go}>
              {signedIn ? t('nav.dashboard') : t('home.ctaStart')} <ArrowRight />
            </Button>
            <Link to="/pricing">
              <Button variant="ghost" size="lg" className="border border-white/40 text-white hover:border-white hover:bg-white/10">{t('home.ctaPricing')}</Button>
            </Link>
          </div>
        </div>
      </section>
    </>
  );
}

/** Soft color fields and a faint grid behind the hero. */
function HeroBackdrop() {
  return (
    <div className="pointer-events-none absolute inset-0 -z-10" aria-hidden>
      <div className="absolute inset-0 bg-[linear-gradient(to_right,var(--color-border)_1px,transparent_1px),linear-gradient(to_bottom,var(--color-border)_1px,transparent_1px)] bg-[size:56px_56px] opacity-60 [mask-image:radial-gradient(ellipse_at_top,black_20%,transparent_70%)]" />
      <div className="absolute -top-40 -left-32 size-[520px] bg-indigo/20 blur-[120px]" />
      <div className="absolute top-10 right-[-120px] size-[460px] bg-violet/20 blur-[120px]" />
      <div className="absolute bottom-[-180px] left-1/3 size-[420px] bg-teal/15 blur-[120px]" />
    </div>
  );
}

/** A drawing of the product: a browser window, the static IP websites see, and what persists. */
function BrowserMock() {
  const { t } = useI18n();
  return (
    <div className="relative mx-auto hidden w-full max-w-[560px] sm:block lg:mx-0" aria-hidden>
      <div className="relative border border-border-strong bg-bg shadow-[0_40px_80px_-40px_rgb(79_70_229/0.45)]">
        <div className="flex items-center gap-3 border-b border-border bg-surface px-4 py-2.5">
          <span className="flex gap-1.5">
            <span className="size-2.5 bg-rose" />
            <span className="size-2.5 bg-amber" />
            <span className="size-2.5 bg-teal" />
          </span>
          <span className="flex flex-1 items-center gap-2 truncate border border-border bg-bg px-3 py-1 font-mono text-[11px] text-muted">
            <Lock className="size-3 shrink-0 text-teal" /> https://example.com
          </span>
          <span className="hidden items-center gap-1 font-mono text-[11px] text-teal sm:flex">
            <span className="size-1.5 bg-teal [animation:cb-pulse_1.6s_ease-in-out_infinite]" /> {t('home.mock.live')} · 32 ms
          </span>
        </div>
        <div className="p-5 sm:p-7">
          <Eyebrow>{t('home.mock.address')}</Eyebrow>
          <p className="mt-3 flex flex-wrap items-baseline gap-x-3 gap-y-2">
            <span className="font-mono text-[26px] font-medium tracking-tight sm:text-[36px]">203.0.113.24</span>
            <span className="border border-teal/40 bg-teal/10 px-1.5 py-0.5 font-mono text-[11px] font-medium text-teal">{t('home.mock.static')} · JP Tokyo</span>
          </p>
          <div className="mt-6 space-y-2.5">
            <div className="h-2.5 w-3/4 bg-surface-2" />
            <div className="h-2.5 w-full bg-surface-2" />
            <div className="h-2.5 w-5/6 bg-surface-2" />
          </div>
          <div className="mt-6 grid grid-cols-3 gap-3">
            <div className="h-14 bg-gradient-to-br from-indigo to-violet sm:h-16" />
            <div className="h-14 bg-surface-2 sm:h-16" />
            <div className="h-14 bg-surface-2 sm:h-16" />
          </div>
        </div>
      </div>
      <FloatCard className="-top-12 -right-3 hidden sm:flex" tone="teal" icon={<Globe2 className="size-4" />} label={t('home.mock.ipKept')} />
      <FloatCard className="-bottom-5 -left-4 hidden sm:flex [animation-delay:1.2s]" tone="violet" icon={<HardDrive className="size-4" />} label={t('home.mock.saved')} />
    </div>
  );
}

function FloatCard({ className, tone, icon, label }: { className?: string; tone: Tone; icon: React.ReactNode; label: string }) {
  return (
    <div className={cn('absolute items-center gap-2.5 border border-border bg-bg/90 px-3 py-2 text-[13px] font-medium shadow-[0_16px_40px_-16px_rgb(0_0_0/0.3)] backdrop-blur [animation:cb-float_5s_ease-in-out_infinite]', className)}>
      <span className={cn('grid size-7 place-items-center text-white', TONE[tone].bg)}>{icon}</span>
      {label}
    </div>
  );
}
