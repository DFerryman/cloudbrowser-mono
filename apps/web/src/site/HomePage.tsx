import { REGION_INFO, type RegionId } from '@cloudbrowser/contracts';
import { Button, Card } from '@cloudbrowser/ui';
import { ArrowRight, Globe2, HardDrive, Lock, MonitorSmartphone, MoonStar, Wallet, Zap } from 'lucide-react';
import { useNavigate } from 'react-router';
import { regionKey } from '../features/instances/status.js';
import { useI18n } from '../lib/i18n.js';
import { SUPPORT_EMAIL } from '../lib/site.js';
import { useSignedIn } from './hooks.js';
import { container } from './PublicShell.js';

const FEATURES = [
  { key: 'ip', icon: Globe2 },
  { key: 'data', icon: Lock },
  { key: 'view', icon: Zap },
  { key: 'sleep', icon: MoonStar },
  { key: 'billing', icon: Wallet },
  { key: 'devices', icon: MonitorSmartphone },
] as const;

const REGIONS: RegionId[] = ['syd1', 'tyo1', 'usw1'];

/** The public homepage: what the product is, how it works, and the way in. */
export function HomePage() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const signedIn = useSignedIn();
  const primary = signedIn ? (
    <Button variant="primary" className="h-10 px-5" onClick={() => navigate('/browsers')}>
      {t('nav.dashboard')} <ArrowRight />
    </Button>
  ) : (
    <Button variant="primary" className="h-10 px-5" onClick={() => navigate('/sign-in')}>
      {t('nav.signIn')} <ArrowRight />
    </Button>
  );

  return (
    <>
      <section className={`${container} grid items-center gap-10 pt-14 pb-16 md:grid-cols-[1.1fr_1fr] md:pt-20`}>
        <div>
          <p className="inline-flex items-center gap-2 rounded-full border border-border bg-surface px-3 py-1 text-xs font-medium text-muted">
            <span className="size-1.5 rounded-full bg-running" aria-hidden /> {t('home.eyebrow')}
          </p>
          <h1 className="mt-5 text-[32px] leading-tight font-semibold tracking-tight md:text-5xl md:leading-[1.1]">{t('home.title')}</h1>
          <p className="mt-5 max-w-xl text-base leading-relaxed text-muted">{t('home.subtitle')}</p>
          <div className="mt-8 flex flex-wrap gap-3">
            {primary}
            <Button className="h-10 px-5" onClick={() => navigate('/pricing')}>
              {t('home.ctaPricing')}
            </Button>
          </div>
          {!signedIn ? <p className="mt-4 text-xs text-subtle">{t('home.inviteOnly')}</p> : null}
        </div>
        <BrowserMock />
      </section>

      <section className="border-y border-border bg-surface py-16">
        <div className={`${container} grid gap-4 sm:grid-cols-2 lg:grid-cols-3`}>
          {FEATURES.map(({ key, icon: Icon }) => (
            <Card key={key} className="p-5">
              <span className="grid size-9 place-items-center rounded-[var(--radius-control)] bg-accent/10 text-accent" aria-hidden>
                <Icon className="size-[18px]" />
              </span>
              <h2 className="mt-4 text-base font-semibold">{t(`home.f.${key}.title`)}</h2>
              <p className="mt-1.5 text-sm leading-relaxed text-muted">{t(`home.f.${key}.body`)}</p>
            </Card>
          ))}
        </div>
      </section>

      <section className={`${container} py-16`}>
        <h2 className="text-xl font-semibold tracking-tight md:text-2xl">{t('home.how.title')}</h2>
        <ol className="mt-8 grid gap-6 md:grid-cols-3">
          {([1, 2, 3] as const).map((n) => (
            <li key={n} className="flex gap-4">
              <span className="grid size-8 shrink-0 place-items-center rounded-full border border-border font-mono text-sm font-semibold">{n}</span>
              <div>
                <h3 className="font-semibold">{t(`home.how.${n}.title`)}</h3>
                <p className="mt-1 text-sm leading-relaxed text-muted">{t(`home.how.${n}.body`)}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>

      <section className={`${container} pb-16`}>
        <div className="grid gap-6 rounded-[var(--radius-card)] border border-border p-6 md:grid-cols-[1fr_1.4fr] md:p-8">
          <div>
            <h2 className="text-xl font-semibold tracking-tight">{t('home.regions.title')}</h2>
            <p className="mt-2 text-sm leading-relaxed text-muted">{t('home.regions.body')}</p>
          </div>
          <ul className="grid gap-3 sm:grid-cols-3">
            {REGIONS.map((id) => (
              <li key={id} className="rounded-[var(--radius-control)] border border-border bg-surface px-4 py-3">
                <span className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[11px] font-medium text-muted">{REGION_INFO[id].country}</span>
                <p className="mt-2 text-sm font-medium">{t(regionKey(id))}</p>
                <p className="text-xs text-subtle">{REGION_INFO[id].timezone}</p>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section className="border-t border-border bg-surface py-16">
        <div className={`${container} flex flex-col items-start justify-between gap-6 md:flex-row md:items-center`}>
          <div>
            <h2 className="text-xl font-semibold tracking-tight md:text-2xl">{t('home.cta.title')}</h2>
            <p className="mt-2 text-sm text-muted">{t('home.cta.body')}</p>
          </div>
          <div className="flex flex-wrap gap-3">
            {primary}
            {!signedIn ? (
              <a href={`mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent('Nevazu invitation')}`}>
                <Button className="h-10 px-5">{t('home.cta.request')}</Button>
              </a>
            ) : null}
          </div>
        </div>
      </section>
    </>
  );
}

/** A small drawing of a browser in a window, with its region and dedicated IP. */
function BrowserMock() {
  const { t } = useI18n();
  return (
    <div className="relative" aria-hidden>
      <div className="absolute -inset-6 -z-10 rounded-[32px] bg-linear-to-br from-accent/15 via-transparent to-running/10 blur-2xl" />
      <div className="overflow-hidden rounded-[var(--radius-card)] border border-border bg-bg shadow-xl">
        <div className="flex items-center gap-2 border-b border-border bg-surface px-3 py-2.5">
          <span className="size-2.5 rounded-full bg-error/70" />
          <span className="size-2.5 rounded-full bg-starting/70" />
          <span className="size-2.5 rounded-full bg-running/70" />
          <span className="ml-3 flex-1 truncate rounded-md bg-surface-2 px-3 py-1 font-mono text-[11px] text-muted">https://example.com</span>
        </div>
        <div className="space-y-3 p-5">
          <div className="flex items-center justify-between gap-3 rounded-[var(--radius-control)] border border-border px-3 py-2.5">
            <span className="text-xs text-muted">{t('home.mock.address')}</span>
            <span className="flex items-center gap-2 font-mono text-xs">
              <span className="rounded bg-surface-2 px-1.5 py-0.5 text-[11px] text-muted">JP</span> 203.0.113.24
            </span>
          </div>
          <div className="h-3 w-3/4 rounded bg-surface-2" />
          <div className="h-3 w-full rounded bg-surface-2" />
          <div className="h-3 w-5/6 rounded bg-surface-2" />
          <div className="grid grid-cols-3 gap-3 pt-2">
            <div className="h-16 rounded-[var(--radius-control)] bg-accent/10" />
            <div className="h-16 rounded-[var(--radius-control)] bg-surface-2" />
            <div className="h-16 rounded-[var(--radius-control)] bg-surface-2" />
          </div>
          <div className="flex items-center gap-2 pt-1 text-xs text-muted">
            <HardDrive className="size-3.5" /> <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-2"><span className="block h-full w-1/3 rounded-full bg-accent" /></span>
          </div>
        </div>
      </div>
    </div>
  );
}
