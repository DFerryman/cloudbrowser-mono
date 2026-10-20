import type { ComponentStatus } from '@cloudbrowser/contracts';
import { Card, cn, Hint, Skeleton } from '@cloudbrowser/ui';
import { AlertTriangle, CheckCircle2, XCircle } from 'lucide-react';
import { regionPlace } from '../features/instances/region-names.js';
import { useI18n } from '../lib/i18n.js';
import { usePublicStatus } from './hooks.js';
import { container, PublicHero } from './PublicShell.js';

const LOOK: Record<ComponentStatus, { icon: typeof CheckCircle2; color: string; banner: string }> = {
  operational: { icon: CheckCircle2, color: 'text-running', banner: 'border-l-running' },
  degraded: { icon: AlertTriangle, color: 'text-starting', banner: 'border-l-starting' },
  outage: { icon: XCircle, color: 'text-error', banner: 'border-l-error' },
};

/** Live service status from the api's own checks; refreshed every minute. */
export function StatusPage() {
  const { t, locale } = useI18n();
  const status = usePublicStatus();
  const s = status.data;
  // No answer at all is itself an outage signal for a visitor.
  const overall: ComponentStatus = s?.status ?? (status.isError ? 'outage' : 'operational');
  const Overall = LOOK[overall].icon;

  return (
    <>
      <PublicHero eyebrow={t('nav.status')} title={t('status.title')} />
      <section className={`${container} space-y-6 pb-16`}>
        {status.isPending ? (
          <Skeleton className="h-20" />
        ) : (
          <div role="status" className={cn('flex items-center gap-4 border border-l-2 border-border px-6 py-6', LOOK[overall].banner)}>
            <Overall className={cn('size-7 shrink-0', LOOK[overall].color)} aria-hidden />
            <div>
              <p className="text-xl font-semibold tracking-tight">{status.isError ? t('status.unreachable') : t(`status.all.${overall}`)}</p>
              {s ? <Hint>{t('status.checked', { time: new Date(s.checkedAt).toLocaleTimeString(locale) })}</Hint> : null}
            </div>
          </div>
        )}
        {s?.creationPaused ? <p className="border-l-2 border-starting bg-surface px-4 py-3 text-sm">{t('status.paused')}</p> : null}
        {s ? (
          <div className="grid gap-4 md:grid-cols-2">
            <Card className="p-5 md:p-6">
              <h2 className="text-[15px] font-semibold tracking-tight">{t('status.components')}</h2>
              <ul className="mt-3 divide-y divide-border">
                {s.components.map((c) => (
                  <Row key={c.id} label={t(`status.component.${c.id}`)} status={c.status} />
                ))}
              </ul>
            </Card>
            <Card className="p-5 md:p-6">
              <h2 className="text-[15px] font-semibold tracking-tight">{t('status.regions')}</h2>
              <ul className="mt-3 divide-y divide-border">
                {s.regions.map((r) => (
                  <Row
                    key={r.regionId}
                    label={regionPlace(r, locale)}
                    detail={r.availabilityReason === 'capacity' || r.availabilityReason === 'provider_issue' || r.availabilityReason === 'blocked'
                      ? t(`create.region.reason.${r.availabilityReason}`)
                      : `${t(r.acceptingNew ? 'status.region.ok' : 'status.region.noNew')}${r.acceptingNew && r.launchVerifiedAt === null ? ` · ${t('create.region.untested')}` : ''}`}
                    status={r.status}
                  />
                ))}
              </ul>
            </Card>
          </div>
        ) : null}
        <Hint>{t('status.note')}</Hint>
      </section>
    </>
  );
}

function Row({ label, detail, status }: { label: string; detail?: string; status: ComponentStatus }) {
  const { t } = useI18n();
  const Icon = LOOK[status].icon;
  return (
    <li className="flex items-center justify-between gap-3 py-2.5">
      <span className="min-w-0">
        <span className="block text-sm">{label}</span>
        {detail ? <span className="block text-xs text-subtle">{detail}</span> : null}
      </span>
      <span className={cn('inline-flex shrink-0 items-center gap-1.5 text-sm font-medium', LOOK[status].color)}>
        <Icon className="size-4" aria-hidden /> {t(`status.${status}`)}
      </span>
    </li>
  );
}
