import type { Instance } from '@cloudbrowser/contracts';
import { Button, Card, cn, Menu, MenuItem, Pagination, Skeleton, usePaged } from '@cloudbrowser/ui';
import { ArrowDownUp, Check, CircleDot, Gauge, LayoutGrid, List, Moon, Plus, Search, Wallet, X } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { PageHeader } from '../../app/AppShell.js';
import { useI18n } from '../../lib/i18n.js';
import { money } from '../../lib/money.js';
import { PAGE_SIZE, usePagerLabels } from '../../lib/paging.js';
import { TONE, type Tone } from '../../lib/tones.js';
import type { MessageKey } from '../../messages/en.js';
import { fundedHours, isLowBalance, runwayLabel } from '../billing/access.js';
import { useBilling } from '../billing/hooks.js';
import { BrowserCard, BrowserRow } from './BrowserCard.js';
import { CreateDialog } from './CreateDialog.js';
import { useInstances, useMe, useRegions } from './hooks.js';
import { regionSearchText } from './region-names.js';
import { shownStatus } from './status.js';

type Filter = 'all' | 'running' | 'sleeping' | 'attention';
type Sort = 'recent' | 'name' | 'status' | 'created';
type View = 'grid' | 'list';

const ATTENTION = new Set(['needs_attention', 'failed', 'provider_issue', 'waiting_capacity', 'deleting']);
const STATUS_ORDER: Record<string, number> = { running: 0, starting: 1, creating: 1, stopping: 2, sleeping: 3 };

function matches(i: Instance, f: Filter) {
  const s = shownStatus(i);
  if (f === 'running') return s === 'running' || s === 'starting' || s === 'creating';
  if (f === 'sleeping') return s === 'sleeping' || s === 'stopping';
  if (f === 'attention') return ATTENTION.has(s) || !!i.stopReason || !!i.deletesAt;
  return true;
}

/** A per-browser preference that survives reloads; storage may be blocked, so failures are ignored. */
function usePref<T extends string>(key: string, initial: T, allowed: readonly T[]) {
  const [value, setValue] = useState<T>(() => {
    try {
      const v = localStorage.getItem(key) as T | null;
      return v && allowed.includes(v) ? v : initial;
    } catch {
      return initial;
    }
  });
  const set = (v: T) => {
    setValue(v);
    try {
      localStorage.setItem(key, v);
    } catch {
      // Not remembered.
    }
  };
  return [value, set] as const;
}

export function BrowsersPage() {
  const { t, locale, errorMessage } = useI18n();
  const navigate = useNavigate();
  const location = useLocation();
  const instances = useInstances();
  const regions = useRegions();
  const me = useMe();
  const billing = useBilling();
  const pagerLabels = usePagerLabels();
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [sort, setSort] = usePref<Sort>('nevazu.browsers.sort', 'recent', ['recent', 'name', 'status', 'created']);
  // Phones get the compact list by default: a page of cards would mean a lot of scrolling.
  const [view, setView] = usePref<View>('nevazu.browsers.view', typeof window !== 'undefined' && window.innerWidth < 640 ? 'list' : 'grid', ['grid', 'list']);
  const retryId = new URLSearchParams(location.search).get('retry');
  const retry = instances.data?.find((i) => i.id === retryId && i.status === 'failed');
  const dialogOpen = location.pathname === '/browsers/new';
  // The session view opens automatically once a new browser's IP check passes (page 1).
  const [openWhenReady, setOpenWhenReady] = useState<string | null>(null);

  useEffect(() => {
    if (!openWhenReady) return;
    const i = instances.data?.find((x) => x.id === openWhenReady);
    if (i?.status === 'running') navigate(`/b/${i.id}`);
    else if (i && i.status !== 'creating') setOpenWhenReady(null);
  }, [instances.data, openWhenReady, navigate]);

  const all = instances.data ?? [];
  const counts = useMemo(() => ({
    all: all.length,
    running: all.filter((i) => matches(i, 'running')).length,
    sleeping: all.filter((i) => matches(i, 'sleeping')).length,
    attention: all.filter((i) => matches(i, 'attention')).length,
  }), [all]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const region = (id: string) => regions.data?.find((r) => r.id === id);
    const list = all.filter((i) => matches(i, filter) && (!q || [i.name, i.ipAddress ?? '', i.regionId, region(i.regionId) ? regionSearchText(region(i.regionId)!, locale) : ''].join(' ').toLowerCase().includes(q)));
    const time = (s: string | null) => (s ? Date.parse(s) : 0);
    return [...list].sort((a, b) =>
      sort === 'name' ? a.name.localeCompare(b.name, locale, { numeric: true })
        : sort === 'status' ? (STATUS_ORDER[shownStatus(a)] ?? 9) - (STATUS_ORDER[shownStatus(b)] ?? 9) || a.name.localeCompare(b.name, locale)
          : sort === 'created' ? time(b.createdAt) - time(a.createdAt)
            : time(b.lastActiveAt ?? b.createdAt) - time(a.lastActiveAt ?? a.createdAt));
  }, [all, filter, query, sort, regions.data, locale]);
  const paged = usePaged(shown, view === 'list' ? PAGE_SIZE.browsers * 2 : PAGE_SIZE.browsers);

  const newButton = (
    <Button variant="primary" className="bg-gradient-to-r from-indigo to-violet text-white hover:bg-transparent hover:brightness-110" onClick={() => navigate('/browsers/new')}>
      <Plus /> {t('browsers.new')}
    </Button>
  );
  const b = billing.data;
  const hours = b ? fundedHours(b) : null;
  const filtered = filter !== 'all' || query.trim() !== '';

  return (
    <>
      <PageHeader
        title={t('browsers.title')}
        description={all.length ? t('browsers.summary', { running: counts.running, sleeping: counts.sleeping }) : undefined}
        action={all.length ? <span className="hidden md:inline-flex">{newButton}</span> : null}
      />
      {instances.isPending ? (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {[0, 1, 2].map((n) => (
            <Skeleton key={n} className="h-48" />
          ))}
        </div>
      ) : instances.isError ? (
        <p className="text-sm text-error">{errorMessage(instances.error)}</p>
      ) : all.length === 0 ? (
        <EmptyState action={newButton} />
      ) : (
        <>
          <div className="mb-5 hidden grid-cols-3 gap-3 sm:grid lg:grid-cols-4">
            <StatTile tone="teal" icon={CircleDot} label={t('browsers.stat.running')} value={String(counts.running)} note={me.data ? t('browsers.stat.ofMax', { max: me.data.entitlements.maxBrowsers }) : undefined} onClick={() => setFilter(filter === 'running' ? 'all' : 'running')} active={filter === 'running'} />
            <StatTile tone="sky" icon={Moon} label={t('browsers.stat.sleeping')} value={String(counts.sleeping)} note={t('browsers.stat.sleepingNote')} onClick={() => setFilter(filter === 'sleeping' ? 'all' : 'sleeping')} active={filter === 'sleeping'} />
            <StatTile tone="indigo" icon={Wallet} label={t('browsers.stat.balance')} value={b ? money(b.availableMicros, locale) : '—'} note={hours !== null ? t('nav.runway', { time: runwayLabel(t, hours) }) : undefined} warn={!!b && isLowBalance(b)} to="/billing" />
            <StatTile className="hidden lg:flex" tone="amber" icon={Gauge} label={t('browsers.stat.spend')} value={b ? t('browsers.stat.spendValue', { amount: money(b.burnHourMicros, locale) }) : '—'} note={b ? t('browsers.stat.month', { amount: money(b.month.totalMicros, locale) }) : undefined} to="/billing" />
          </div>

          <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center">
            <div className="relative min-w-0 flex-1 sm:max-w-sm">
              <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-subtle" aria-hidden />
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t('browsers.search')}
                aria-label={t('browsers.search')}
                className="h-9 w-full border border-border bg-bg pr-8 pl-9 text-sm outline-none transition-colors placeholder:text-subtle hover:border-border-strong focus-visible:border-indigo"
              />
              {query ? (
                <button type="button" className="absolute top-1/2 right-2 grid size-6 -translate-y-1/2 place-items-center text-subtle hover:text-fg" onClick={() => setQuery('')} aria-label={t('browsers.clearFilters')}>
                  <X className="size-3.5" />
                </button>
              ) : null}
            </div>
            <div className="flex items-center gap-2">
              <div className="flex min-w-0 flex-1 border border-border" role="tablist" aria-label={t('browsers.title')}>
                {(['all', 'running', 'sleeping', 'attention'] as const).map((f) => (
                  <button
                    key={f}
                    type="button"
                    role="tab"
                    aria-selected={filter === f}
                    onClick={() => setFilter(f)}
                    className={cn(
                      'flex h-9 min-w-0 flex-1 items-center justify-center gap-1.5 px-2.5 text-[13px] font-medium whitespace-nowrap transition-colors sm:flex-none',
                      filter === f ? 'bg-fg text-bg' : 'text-muted hover:bg-surface hover:text-fg',
                      f === 'attention' && counts.attention > 0 && filter !== f && 'text-error',
                    )}
                  >
                    <span className="truncate">{t(`browsers.filter.${f}` as MessageKey)}</span>
                    <span className={cn('font-mono text-[11px] tabular-nums', filter === f ? 'text-bg/70' : 'text-subtle')}>{counts[f]}</span>
                  </button>
                ))}
              </div>
              <Menu
                trigger={
                  <Button size="icon" variant="ghost" className="size-9 border border-border" aria-label={t('browsers.sort')} title={t('browsers.sort')}>
                    <ArrowDownUp />
                  </Button>
                }
              >
                {(['recent', 'name', 'status', 'created'] as const).map((s) => (
                  <MenuItem key={s} onSelect={() => setSort(s)}>
                    <span className="flex-1">{t(`browsers.sort.${s}` as MessageKey)}</span>
                    {sort === s ? <Check className="text-indigo" aria-hidden /> : null}
                  </MenuItem>
                ))}
              </Menu>
              <div className="hidden border border-border sm:flex" role="radiogroup" aria-label={t('browsers.view.grid')}>
                {([['grid', LayoutGrid], ['list', List]] as const).map(([v, Icon]) => (
                  <button key={v} type="button" role="radio" aria-checked={view === v} onClick={() => setView(v)} title={t(`browsers.view.${v}`)} aria-label={t(`browsers.view.${v}`)} className={cn('grid size-9 place-items-center transition-colors [&_svg]:size-4', view === v ? 'bg-surface-2 text-fg' : 'text-subtle hover:text-fg')}>
                    <Icon />
                  </button>
                ))}
              </div>
            </div>
          </div>

          {shown.length === 0 ? (
            <Card className="flex flex-col items-center gap-3 p-10 text-center">
              <p className="text-sm text-muted">{t('browsers.noMatch')}</p>
              {filtered ? <Button size="sm" onClick={() => { setFilter('all'); setQuery(''); }}>{t('browsers.clearFilters')}</Button> : null}
            </Card>
          ) : view === 'grid' ? (
            <div className="grid gap-4 md:grid-cols-2 2xl:grid-cols-3">
              {paged.rows.map((i) => (
                <BrowserCard key={i.id} instance={i} />
              ))}
            </div>
          ) : (
            <Card className="divide-y divide-border">
              <div className="hidden grid-cols-[minmax(0,1.3fr)_minmax(0,1.4fr)_minmax(0,0.8fr)_auto] gap-4 bg-surface px-4 py-2 text-[11px] font-semibold tracking-[0.12em] text-subtle uppercase lg:grid">
                <span>{t('browsers.col.name')}</span>
                <span>{t('browsers.col.where')}</span>
                <span>{t('browsers.col.used')}</span>
                <span className="w-40" />
              </div>
              {paged.rows.map((i) => (
                <BrowserRow key={i.id} instance={i} />
              ))}
            </Card>
          )}
          <Pagination className="mt-4" page={paged.page} pages={paged.pages} onPage={paged.setPage} labels={pagerLabels} />
        </>
      )}
      <CreateDialog
        open={dialogOpen}
        initialInstance={retry}
        onClose={() => navigate('/browsers')}
        onCreated={(id) => {
          setOpenWhenReady(id);
          navigate('/browsers');
        }}
      />
    </>
  );
}

/** A key figure that is also a shortcut: it filters the list or opens the page behind it. */
function StatTile({ tone, icon: Icon, label, value, note, onClick, to, active, warn, className }: {
  tone: Tone; icon: typeof Wallet; label: string; value: string; note?: string; onClick?: () => void; to?: string; active?: boolean; warn?: boolean; className?: string;
}) {
  const body: ReactNode = (
    <>
      <span className={cn('absolute inset-x-0 top-0 h-0.5', TONE[tone].bg, !active && 'opacity-70')} aria-hidden />
      <span className="flex items-center gap-2">
        <span className={cn('hidden size-7 shrink-0 place-items-center sm:grid', active ? cn(TONE[tone].bg, 'text-white') : cn(TONE[tone].soft, TONE[tone].text))} aria-hidden>
          <Icon className="size-4" />
        </span>
        <span className="truncate text-[11px] font-semibold tracking-[0.1em] text-subtle uppercase sm:text-xs sm:tracking-[0.08em]">{label}</span>
      </span>
      <span className={cn('mt-2 block truncate text-xl font-semibold tracking-tight tabular-nums sm:mt-3 sm:text-[26px] sm:leading-none', warn ? 'text-error' : active && TONE[tone].text)}>{value}</span>
      {note ? <span className={cn('mt-1.5 hidden truncate text-xs sm:block', warn ? 'text-error' : 'text-subtle')}>{note}</span> : null}
    </>
  );
  const cls = cn(
    'relative flex min-w-0 flex-col overflow-hidden border bg-bg p-3 text-left transition-[border-color,background-color] sm:p-4',
    active ? cn(TONE[tone].border, TONE[tone].soft) : 'border-border hover:border-border-strong',
    className,
  );
  if (to) return <Link to={to} className={cls}>{body}</Link>;
  return <button type="button" className={cls} aria-pressed={active} onClick={onClick}>{body}</button>;
}

function EmptyState({ action }: { action: ReactNode }) {
  const { t } = useI18n();
  const items = [
    { key: 'browsers.guarantee.ip', tone: 'teal' },
    { key: 'browsers.guarantee.data', tone: 'violet' },
    { key: 'browsers.guarantee.view', tone: 'indigo' },
  ] as const;
  return (
    <Card className="relative mx-auto max-w-2xl overflow-hidden p-8 text-center md:p-12">
      <div className="pointer-events-none absolute -top-24 left-1/2 size-72 -translate-x-1/2 bg-indigo/15 blur-3xl" aria-hidden />
      <span className="relative mx-auto grid size-14 place-items-center bg-gradient-to-br from-indigo to-violet text-white" aria-hidden>
        <Plus className="size-6" />
      </span>
      <p className="relative mt-5 text-lg font-semibold tracking-tight md:text-xl">{t('browsers.emptyTitle')}</p>
      <ul className="relative mx-auto mt-6 inline-flex flex-col gap-2.5 text-left text-sm text-muted">
        {items.map(({ key, tone }) => (
          <li key={key} className="flex items-start gap-2.5">
            <span className={cn('mt-0.5 grid size-5 shrink-0 place-items-center', TONE[tone].soft, TONE[tone].text)}><Check className="size-3.5" aria-hidden /></span>
            {t(key)}
          </li>
        ))}
      </ul>
      <div className="relative mt-8">{action}</div>
    </Card>
  );
}
