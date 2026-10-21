import { browserEstimate, type Region, type RegionPricing } from '@cloudbrowser/contracts';
import { CountryTag, cn, Input } from '@cloudbrowser/ui';
import { AlertTriangle, CircleCheck, CircleSlash, Info, Search } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { DocsLink } from '../../app/DocsLink.js';
import { useI18n } from '../../lib/i18n.js';
import type { MessageKey } from '../../messages/en.js';
import { money } from '../../lib/money.js';
import { regionPlace, regionSearchText } from './region-names.js';

const CACHE_KEY = 'nevazu.latency.v1';
const CACHE_MS = 10 * 60_000;
/** Shown before "show all": the nearest few, plus the selected one. */
const NEAREST = 5;

/** Creation is open but no browser has run here yet; unknown (older API) is not flagged. */
const untested = (r: Region) => r.availability !== 'unavailable' && r.launchVerifiedAt === null;

type Cached = Record<string, { ms: number; at: number }>;
function readCache(): Cached {
  try {
    const all = JSON.parse(sessionStorage.getItem(CACHE_KEY) ?? '{}') as Cached;
    return Object.fromEntries(Object.entries(all).filter(([, v]) => Date.now() - v.at < CACHE_MS));
  } catch {
    return {};
  }
}
function writeCache(id: string, ms: number) {
  try {
    sessionStorage.setItem(CACHE_KEY, JSON.stringify({ ...readCache(), [id]: { ms, at: Date.now() } }));
  } catch {
    // Storage may be unavailable (private mode); the measurement is simply repeated next time.
  }
}

/** Round trip to a region's ping endpoint. The first request also opens the connection, so it is not counted. */
async function measure(url: string): Promise<number | null> {
  const samples: number[] = [];
  for (let n = 0; n < 3; n++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 4_000);
    const start = performance.now();
    try {
      await fetch(url, { mode: 'no-cors', cache: 'no-store', credentials: 'omit', signal: ctl.signal });
      samples.push(performance.now() - start);
    } catch {
      break;
    } finally {
      clearTimeout(timer);
    }
  }
  const warm = samples.slice(1);
  return warm.length ? Math.round(Math.min(...warm)) : null;
}

/**
 * Latency from the user's own network to each region, measured in their browser while the
 * dialog is open (a few at a time, cached for ten minutes). A hint: the region is never picked
 * for them.
 */
function useMeasuredLatency(regions: Region[] | undefined, active: boolean) {
  const [measured, setMeasured] = useState<Record<string, number>>(() => Object.fromEntries(Object.entries(readCache()).map(([id, v]) => [id, v.ms])));
  const probes = regions?.filter((r) => r.probeUrl).map((r) => `${r.id} ${r.probeUrl}`).join('|') ?? '';
  useEffect(() => {
    if (!active || !probes) return;
    let cancelled = false;
    const cached = readCache();
    const todo = probes.split('|').map((p) => p.split(' ') as [string, string]).filter(([id]) => !cached[id]);
    let next = 0;
    const worker = async () => {
      for (let item = todo[next++]; item && !cancelled; item = todo[next++]) {
        const ms = await measure(item[1]);
        if (ms === null || cancelled) continue;
        writeCache(item[0], ms);
        setMeasured((m) => ({ ...m, [item[0]]: ms }));
      }
    };
    void Promise.all(Array.from({ length: 4 }, worker));
    return () => {
      cancelled = true;
    };
  }, [active, probes]);
  return measured;
}

export type Latency = { ms: number; measured: boolean };

const AVAILABILITY: Record<Region['availability'], { icon: typeof CircleCheck; color: string; key: MessageKey }> = {
  available: { icon: CircleCheck, color: 'text-running', key: 'create.region.available' },
  limited: { icon: AlertTriangle, color: 'text-starting', key: 'create.region.limited' },
  unavailable: { icon: CircleSlash, color: 'text-subtle', key: 'create.region.unavailableShort' },
};
const latencyTone = (ms: number) => (ms <= 80 ? 'bg-running' : ms <= 160 ? 'bg-starting' : 'bg-error');

/**
 * Where a new browser lives. Each region shows where its IP is, how far it is from the user
 * (measured, or estimated until measured), whether it can take a browser now and what an hour
 * costs. The nearest regions come first; the nearest available one is marked.
 */
export function RegionPicker({ open, regions, loading, pricing, value, onChange, storageFor, priceLabel, reasonFor }: {
  open: boolean;
  regions: Region[] | undefined;
  loading: boolean;
  pricing: RegionPricing[] | undefined;
  value: string;
  onChange: (id: string) => void;
  storageFor: (p: RegionPricing) => number;
  priceLabel?: string;
  /** Why a region cannot be chosen, in place of its own availability (e.g. Premium is not offered there). */
  reasonFor?: (r: Region) => string | null;
}) {
  const { t, locale } = useI18n();
  const measured = useMeasuredLatency(regions, open);
  const [query, setQuery] = useState('');
  const [showAll, setShowAll] = useState(false);

  const latency = (r: Region): Latency | null =>
    measured[r.id] !== undefined ? { ms: measured[r.id]!, measured: true } : typeof r.estimatedRttMs === 'number' ? { ms: r.estimatedRttMs, measured: false } : null;
  const selectable = (r: Region) => r.acceptingNew;

  const sorted = useMemo(() => {
    const rank = (r: Region) => (selectable(r) ? 0 : 1);
    return [...(regions ?? [])].sort((a, b) => rank(a) - rank(b) || (latency(a)?.ms ?? Infinity) - (latency(b)?.ms ?? Infinity) || a.name.localeCompare(b.name, undefined, { numeric: true }));
  }, [regions, measured]);
  const recommended = sorted.find((r) => selectable(r) && r.availability === 'available' && latency(r))?.id ?? null;

  const q = query.trim().toLowerCase();
  const long = sorted.length > NEAREST + 1;
  const shown = q
    ? sorted.filter((r) => regionSearchText(r, locale).includes(q))
    : showAll || !long
      ? sorted
      : sorted.filter((r, i) => i < NEAREST || r.id === value);
  const selected = regions?.find((r) => r.id === value);

  return (
    <div>
      <p className="mb-2 text-xs leading-relaxed text-muted">{t('create.region.intro')}</p>
      {long ? (
        <div className="relative mb-2">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-subtle" aria-hidden />
          <Input
            type="search"
            className="pl-8"
            value={query}
            placeholder={t('create.region.search')}
            aria-label={t('create.region.search')}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      ) : null}
      <div className="divide-y divide-border overflow-hidden border border-border" role="radiogroup" aria-label={t('create.region')}>
        {shown.map((r) => {
          const p = pricing?.find((x) => x.regionId === r.id);
          const hourly = p?.rates ? browserEstimate(p.rates, { storageGb: storageFor(p), rootVolumeGb: p.rootVolumeGb, backups: false }).runningTotalHour : null;
          const disabled = !selectable(r);
          const status = reasonFor?.(r) ?? (r.availabilityReason ? t(`create.region.reason.${r.availabilityReason}` as MessageKey) : r.inventory ? t('create.region.stock', { count: r.inventory.available }) : null);
          const reason = [status, untested(r) ? t('create.region.untested') : null].filter(Boolean).join(' · ') || null;
          return (
            <RegionRow
              key={r.id}
              region={r}
              place={regionPlace(r, locale)}
              checked={value === r.id}
              disabled={disabled}
              recommended={recommended === r.id}
              onChange={() => onChange(r.id)}
              reason={reason}
              latency={latency(r)}
              price={disabled ? null : priceLabel ?? (hourly !== null ? t('price.perHour', { amount: money(hourly, locale) }) : null)}
            />
          );
        })}
        {loading ? <div className="h-32 bg-surface-2 [animation:cb-pulse_1.5s_ease-in-out_infinite]" /> : null}
        {!loading && q && !shown.length ? <p className="px-3 py-4 text-sm text-muted">{t('create.region.noMatch')}</p> : null}
      </div>
      {long && !q ? (
        <button type="button" className="mt-2.5 text-sm font-medium text-accent underline-offset-4 hover:underline" aria-expanded={showAll} onClick={() => setShowAll((s) => !s)}>
          {showAll ? t('create.region.showNearest') : t('create.region.showAll', { count: sorted.length })}
        </button>
      ) : null}
      {selected?.availability === 'limited' && selected.availabilityReason === 'capacity' ? (
        <p role="status" className="mt-2 flex gap-2 border-l-2 border-starting bg-starting/5 px-3 py-2.5 text-xs leading-relaxed">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-starting" aria-hidden />
          <span>{t('create.region.limitedNotice', { region: regionPlace(selected, locale) })}</span>
        </p>
      ) : null}
      {selected && untested(selected) ? (
        <p role="status" className="mt-2 flex gap-2 border-l-2 border-border-strong bg-surface px-3 py-2.5 text-xs leading-relaxed">
          <Info className="mt-0.5 size-3.5 shrink-0 text-muted" aria-hidden />
          <span>{t('create.region.untestedNotice', { region: regionPlace(selected, locale) })}</span>
        </p>
      ) : null}
      <p className="mt-2 flex gap-2 text-xs leading-relaxed text-subtle">
        <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden />
        <span>
          {t('create.region.latencyHelp')} {t('create.permanent')} <DocsLink to="browsers#regions" />
        </span>
      </p>
    </div>
  );
}

function RegionRow({ region, place, checked, disabled, recommended, onChange, reason, latency, price }: {
  region: Region; place: string; checked: boolean; disabled: boolean; recommended: boolean; onChange: () => void;
  reason: string | null; latency: Latency | null; price: string | null;
}) {
  const { t } = useI18n();
  const a = AVAILABILITY[region.availability ?? (region.acceptingNew ? 'available' : 'unavailable')];
  const StatusIcon = a.icon;
  return (
    <label
      className={cn(
        'relative flex items-center gap-3 px-3 py-3 transition-colors duration-150 has-[:focus-visible]:bg-surface-2',
        disabled ? 'cursor-not-allowed opacity-55' : 'cursor-pointer',
        checked && !disabled ? 'bg-surface shadow-[inset_2px_0_0_0_var(--color-fg)]' : !disabled && 'hover:bg-surface',
      )}
    >
      <input type="radio" name="region" value={region.id} className="peer sr-only" checked={checked} disabled={disabled} onChange={onChange} />
      <span className={cn('grid size-4 shrink-0 place-items-center rounded-full border transition-colors', checked && !disabled ? 'border-fg' : 'border-border-strong')} aria-hidden>
        {checked && !disabled ? <span className="size-2 rounded-full bg-fg" /> : null}
      </span>
      <CountryTag code={region.country} size="sm" muted={disabled} />
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-sm font-medium">{place}</span>
          {recommended ? (
            <span className="inline-flex shrink-0 items-center border border-accent/40 px-1.5 py-px text-[10px] font-semibold tracking-[0.08em] text-accent uppercase">
              {t('create.region.recommended')}
            </span>
          ) : null}
        </span>
        <span className="mt-0.5 flex min-w-0 items-center gap-1 text-xs text-subtle">
          <StatusIcon className={cn('size-3.5 shrink-0', a.color)} aria-hidden />
          <span className="shrink-0">{t(a.key)}</span>
          {reason ? (
            <>
              <span aria-hidden>·</span>
              <span className="shrink-0">{reason}</span>
            </>
          ) : null}
          <span aria-hidden>·</span>
          <span className="truncate">{region.name}</span>
        </span>
      </span>
      <span className="shrink-0 text-right">
        {price ? <span className="block text-sm font-medium tabular-nums">{price}</span> : null}
        {latency && !disabled ? (
          <span
            className="mt-0.5 flex items-center justify-end gap-1.5 text-xs text-subtle tabular-nums"
            title={latency.measured ? t('create.region.latencyMeasured') : t('create.region.latencyEstimated')}
          >
            <span className={cn('size-1.5 rounded-full', latencyTone(latency.ms))} aria-hidden />
            {latency.measured ? '' : '≈'}{latency.ms} ms
          </span>
        ) : null}
      </span>
    </label>
  );
}
