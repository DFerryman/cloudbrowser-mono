import type { Instance, NeverSleepQuote } from '@cloudbrowser/contracts';
import { NEVER_SLEEP_TIMEOUT_S } from '@cloudbrowser/contracts';
import { Button, Dialog, Skeleton, useToast } from '@cloudbrowser/ui';
import { Link } from 'react-router';
import { useI18n } from '../../lib/i18n.js';
import { money } from '../../lib/money.js';
import type { MessageKey } from '../../messages/en.js';
import { useNeverSleepQuote, useRegionInfo, useUpdateInstance } from './hooks.js';

/**
 * Turning on Never sleep shows what 24 hours of continuous running costs in the browser's region
 * (compute, IP and storage) and the credit it needs, and only then asks for confirmation. The
 * server checks the same quote again and refuses a price the user did not see.
 */
export function NeverSleepDialog({ instance: i, open, onClose }: { instance: Instance; open: boolean; onClose: () => void }) {
  const { t, locale, errorMessage } = useI18n();
  const toast = useToast();
  const quote = useNeverSleepQuote(i.id, open);
  const update = useUpdateInstance();
  const region = useRegionInfo(i.regionId);
  const q = quote.data;
  const m = (v: number) => money(v, locale);
  const confirm = (data: NeverSleepQuote) =>
    update.mutate(
      { id: i.id, patch: { idleTimeoutS: NEVER_SLEEP_TIMEOUT_S, priceVersion: data.priceVersion ?? undefined } },
      {
        onSuccess: () => { toast(t('settings.saved')); onClose(); },
        onError: (e) => { toast(errorMessage(e), 'error'); void quote.refetch(); },
      },
    );
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()} title={t('neverSleep.title', { name: i.name })} description={t('neverSleep.body')} closeLabel={t('common.cancel')}>
      {!q ? (
        <Skeleton className="h-32" />
      ) : (
        <div className="space-y-4 text-sm" data-testid="never-sleep-quote">
          <div>
            <p className="font-medium">{t('neverSleep.dayCost', { region: region.name, amount: m(q.day.totalMicros) })}</p>
            <dl className="mt-2 grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-muted">
              <dt>{t('neverSleep.compute')}</dt><dd className="text-right tabular-nums">{m(q.day.computeMicros)}</dd>
              <dt>{t('neverSleep.ip')}</dt><dd className="text-right tabular-nums">{m(q.day.ipMicros)}</dd>
              <dt>{t('neverSleep.storage')}</dt><dd className="text-right tabular-nums">{m(q.day.storageMicros)}</dd>
            </dl>
            <p className="mt-1 text-xs text-subtle">{t('neverSleep.dataExtra')}</p>
          </div>
          <p>{t('neverSleep.credit', { available: m(q.availableMicros), required: m(q.requiredMicros) })}</p>
          <p className="text-muted">{t('neverSleep.stops')}</p>
          {q.reason ? (
            <p role="alert" className="rounded-md border border-error/40 bg-error/10 p-3 text-error">
              {t(`neverSleep.reason.${q.reason}` as MessageKey, { required: m(q.requiredMicros), available: m(q.availableMicros) })}
              {q.reason === 'no_topup' || q.reason === 'insufficient_credit' ? <> <Link to="/billing" className="underline">{t('neverSleep.addCredit')}</Link></> : null}
            </p>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button type="button" onClick={onClose}>{t('common.cancel')}</Button>
            <Button type="button" variant="primary" disabled={!q.allowed || update.isPending} onClick={() => confirm(q)}>
              {t('neverSleep.confirm')}
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}
