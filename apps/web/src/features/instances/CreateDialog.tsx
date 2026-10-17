import { BrowserLocale, CreateInstanceBody, SCREEN_SIZES, type Region } from '@cloudbrowser/contracts';
import { Button, cn, Dialog, Input, Label, Select } from '@cloudbrowser/ui';
import { ChevronRight } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { useI18n, type Locale } from '../../lib/i18n.js';
import { useCreateInstance, useInstances, useMe, useRegions } from './hooks.js';

const UI_TO_BROWSER_LOCALE: Record<Locale, BrowserLocale> = { en: 'en-US', 'zh-CN': 'zh-CN' };

/** Measures latency from the user's own network as a hint; the region is never picked for them. */
function useLatency(regions: Region[] | undefined) {
  const [ms, setMs] = useState<Record<string, number>>({});
  useEffect(() => {
    if (!regions) return;
    let cancelled = false;
    for (const r of regions) {
      if (!r.probeUrl) continue;
      const url = r.probeUrl;
      void (async () => {
        const samples: number[] = [];
        for (let n = 0; n < 3; n++) {
          const start = performance.now();
          try {
            await fetch(url, { mode: 'no-cors', cache: 'no-store' });
            samples.push(performance.now() - start);
          } catch {
            return;
          }
        }
        if (!cancelled) setMs((m) => ({ ...m, [r.id]: Math.round(Math.min(...samples)) }));
      })();
    }
    return () => {
      cancelled = true;
    };
  }, [regions]);
  return ms;
}

export function CreateDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (instanceId: string) => void }) {
  const { t, locale, errorMessage } = useI18n();
  const regions = useRegions();
  const instances = useInstances();
  const me = useMe();
  const create = useCreateInstance();
  const latency = useLatency(regions.data);

  const [name, setName] = useState('');
  const [regionId, setRegionId] = useState<Region['id']>('tyo1');
  const [browserLocale, setBrowserLocale] = useState<BrowserLocale>(UI_TO_BROWSER_LOCALE[locale]);
  const [screen, setScreen] = useState<(typeof SCREEN_SIZES)[number]>('auto');
  const [advanced, setAdvanced] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setName(`Browser ${(instances.data?.length ?? 0) + 1}`);
      setError(null);
    }
  }, [open, instances.data?.length]);

  const atLimit = me.data ? me.data.usage.browsers >= me.data.entitlements.maxBrowsers : false;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const parsed = CreateInstanceBody.safeParse({ name, regionId, locale: browserLocale, screen });
    if (!parsed.success) {
      setError(t('error.validation_failed'));
      return;
    }
    try {
      const res = await create.mutateAsync(parsed.data);
      onCreated(res.instanceId);
    } catch (err) {
      setError(errorMessage(err));
    }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()} title={t('create.title')} closeLabel={t('common.cancel')}>
      <form onSubmit={submit} className="space-y-5">
        <div>
          <Label htmlFor="name">{t('create.name')}</Label>
          <Input id="name" value={name} maxLength={64} required onChange={(e) => setName(e.target.value)} />
        </div>

        <fieldset>
          <legend className="mb-1.5 text-sm font-medium">{t('create.region')}</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {(regions.data ?? []).map((r) => {
              const disabled = !r.acceptingNew;
              return (
                <label
                  key={r.id}
                  className={cn(
                    'flex cursor-pointer flex-col rounded-[var(--radius-control)] border p-3 transition-colors',
                    regionId === r.id ? 'border-accent ring-1 ring-accent' : 'border-border hover:bg-surface',
                    disabled && 'cursor-not-allowed opacity-60',
                  )}
                >
                  <input
                    type="radio"
                    name="region"
                    value={r.id}
                    className="sr-only"
                    checked={regionId === r.id}
                    disabled={disabled}
                    onChange={() => setRegionId(r.id)}
                  />
                  <span className="flex items-center justify-between font-medium">
                    {t(`create.region.${r.id}`)}
                    {latency[r.id] !== undefined ? <span className="font-mono text-xs text-muted">{latency[r.id]} ms</span> : null}
                  </span>
                  <span className="text-xs text-muted">{disabled ? t('create.region.unavailable') : t(`create.region.${r.id}.hint`)}</span>
                </label>
              );
            })}
          </div>
          <p className="mt-2 text-xs leading-relaxed text-muted">{t('create.note')}</p>
        </fieldset>

        <div>
          <button type="button" className="flex items-center gap-1 text-sm font-medium" aria-expanded={advanced} onClick={() => setAdvanced((a) => !a)}>
            <ChevronRight className={cn('size-4 transition-transform', advanced && 'rotate-90')} />
            {t('create.advanced')}
          </button>
          {advanced ? (
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              <div>
                <Label htmlFor="locale">{t('create.language')}</Label>
                <Select id="locale" value={browserLocale} onChange={(e) => setBrowserLocale(e.target.value as BrowserLocale)}>
                  <option value="zh-CN">简体中文</option>
                  <option value="en-US">English (US)</option>
                  <option value="ja-JP">日本語</option>
                </Select>
              </div>
              <div>
                <Label htmlFor="screen">{t('create.screen')}</Label>
                <Select id="screen" value={screen} onChange={(e) => setScreen(e.target.value as typeof screen)}>
                  {SCREEN_SIZES.map((s) => (
                    <option key={s} value={s}>
                      {s === 'auto' ? t('create.screen.auto') : s.replace('x', ' × ')}
                    </option>
                  ))}
                </Select>
              </div>
            </div>
          ) : null}
        </div>

        {atLimit && me.data ? <p className="text-sm text-muted">{t('create.atLimit', { max: me.data.entitlements.maxBrowsers })}</p> : null}
        {error ? (
          <p role="alert" className="text-sm text-error">
            {error}
          </p>
        ) : null}

        <div className="flex justify-end gap-2">
          <Button onClick={onClose}>{t('common.cancel')}</Button>
          <Button type="submit" variant="primary" disabled={create.isPending || atLimit}>
            {t('create.submit')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
