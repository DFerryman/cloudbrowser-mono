import { TERMS_VERSION } from '@cloudbrowser/contracts';
import { Button, Dialog, Input, Label, Select, useToast } from '@cloudbrowser/ui';
import { useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { ADMIN_PAGE, post, usd, useAdmin, useAdminAction, useAdminPage, when, type AlertRow, type ClosureRow, type OperationRow, type Row, type UserRow } from './data.js';
import { useT } from './i18n.js';
import { Json, Mono, PageTitle, Pill, ReasonDialog, StatusPill, Table } from './ui.js';

export function AlertsPage() {
  const { t, term } = useT();
  const [open, setOpen] = useState(true);
  const alerts = useAdminPage<AlertRow>(`/alerts?open=${open ? 1 : 0}`, ADMIN_PAGE.alerts, { refetchInterval: 30_000 });
  const ack = useAdminAction((id: number) => post(`/alerts/${id}/ack`));
  return (
    <div>
      <PageTitle title={t('nav.alerts')}>
        <Select value={open ? 'open' : 'all'} onChange={(e) => setOpen(e.target.value === 'open')} className="w-40">
          <option value="open">{t('common.open')}</option>
          <option value="all">{t('common.all')}</option>
        </Select>
      </PageTitle>
      <p className="mb-3 text-xs text-muted">{t('alerts.note')}</p>
      <Table
        rows={alerts.rows}
        pager={alerts.pager}
        rowKey={(a) => a.id}
        columns={[t('col.when'), t('col.severity'), t('col.source'), t('col.alert'), t('col.detail'), t('col.sent'), '']}
        empty={t('alerts.empty')}
        cells={(a) => [
          when(a.createdAt),
          <StatusPill value={a.severity} tone={a.severity === 'critical' ? 'bad' : a.severity === 'warning' ? 'warn' : 'muted'} />,
          term(a.source),
          a.title,
          <Json value={a.detail} />,
          a.sentAt ? when(a.sentAt) : <span className="text-muted">{t('alerts.pending')}</span>,
          a.acknowledgedAt ? (
            <span className="text-xs text-muted">
              {t('alerts.acked', { when: when(a.acknowledgedAt) })}
              <br />
              {a.acknowledgedBy}
            </span>
          ) : (
            <Button size="sm" disabled={ack.isPending} onClick={() => ack.mutate(a.id)}>
              {t('alerts.ack')}
            </Button>
          ),
        ]}
      />
    </div>
  );
}

const KINDS = ['create', 'start', 'stop', 'recover', 'restore', 'resize_volume', 'delete', 'undelete', 'purge'];

export function OperationsPage() {
  const { t, term } = useT();
  const [status, setStatus] = useState('unfinished');
  const [kind, setKind] = useState('');
  const ops = useAdminPage<OperationRow>(`/operations?status=${status}${kind ? `&kind=${kind}` : ''}`, ADMIN_PAGE.operations, { refetchInterval: 15_000 });
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div>
      <PageTitle title={t('nav.operations')}>
        <div className="flex gap-2">
          <Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-36">
            <option value="unfinished">{t('ops.unfinished')}</option>
            <option value="failed">{t('ops.failed')}</option>
            <option value="all">{t('common.all')}</option>
          </Select>
          <Select value={kind} onChange={(e) => setKind(e.target.value)} className="w-36">
            <option value="">{t('common.anyKind')}</option>
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {term(k)}
              </option>
            ))}
          </Select>
        </div>
      </PageTitle>
      <Table
        rows={ops.rows}
        pager={ops.pager}
        rowKey={(o) => o.id}
        onRow={(o) => setOpen(o.id)}
        columns={[t('col.created'), t('col.kind'), t('col.status'), t('col.step'), t('col.attempt'), t('col.browser'), t('col.user'), t('col.error')]}
        cells={(o) => [
          when(o.createdAt),
          term(o.kind),
          <StatusPill value={o.status} tone={o.status === 'running' ? 'warn' : undefined} />,
          o.step ?? '—',
          o.attempt,
          <Link to={`/browsers/${o.instanceId}`} onClick={(e) => e.stopPropagation()} className="text-accent hover:underline">
            {o.instanceName ?? o.instanceId}
          </Link>,
          o.userEmail ?? '—',
          o.error ? (
            <span className="text-error">
              {o.errorClass}: {o.error}
            </span>
          ) : o.notBefore && !o.finishedAt ? (
            <span className="text-muted">{t('ops.nextTry', { when: when(o.notBefore) })}</span>
          ) : (
            '—'
          ),
        ]}
      />
      <OperationDialog id={open} onClose={() => setOpen(null)} />
    </div>
  );
}

/** One operation with its write-ahead step journal. */
export function OperationDialog({ id, onClose }: { id: string | null; onClose: () => void }) {
  const { t, term } = useT();
  const detail = useAdmin<{ operation: Row; steps: Row[] }>(`/operations/${id ?? ''}`, { enabled: id !== null });
  const op = id ? detail.data?.operation : undefined;
  return (
    <Dialog open={id !== null} onOpenChange={(o) => !o && onClose()} title={op ? `${term(String(op.kind))} · ${term(String(op.status))}` : t('ops.dialog')}>
      {op ? (
        <div className="space-y-3 text-sm">
          <p>
            <Mono>{String(op.id)}</Mono>
          </p>
          <Json value={{ params: op.params, attempt: op.attempt, error: op.error, errorClass: op.errorClass }} />
          <h3 className="font-medium">{t('ops.journal')}</h3>
          <Table
            rows={detail.data!.steps}
            rowKey={(s) => String(s.step)}
            columns={[t('col.step'), t('col.status'), t('col.attempts'), t('col.result')]}
            cells={(s) => [String(s.step), <StatusPill value={String(s.status)} />, String(s.attempts ?? ''), <Json value={s.result} />]}
          />
        </div>
      ) : (
        <p className="text-sm text-muted">{t('common.loading')}</p>
      )}
    </Dialog>
  );
}

export function FindingsPage() {
  const { t, errorText } = useT();
  const toast = useToast();
  const [status, setStatus] = useState('open');
  const rows = useAdminPage<Row>(`/findings?status=${status}`, ADMIN_PAGE.findings);
  const [resolving, setResolving] = useState<string | null>(null);
  const resolve = useAdminAction((v: { id: string; note: string }) => post(`/findings/${v.id}/resolve`, { note: v.note }));
  return (
    <div>
      <PageTitle title={t('nav.findings')}>
        <Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-36">
          <option value="open">{t('common.open')}</option>
          <option value="resolved">{t('findings.resolved')}</option>
          <option value="all">{t('common.all')}</option>
        </Select>
      </PageTitle>
      <p className="mb-3 text-xs text-muted">{t('findings.note')}</p>
      <Table
        rows={rows.rows}
        pager={rows.pager}
        rowKey={(r) => String(r.id)}
        columns={[t('col.when'), t('col.kind'), t('col.resource'), t('col.where'), t('col.browser'), t('col.detail'), '']}
        empty={t('findings.empty')}
        cells={(r) => [
          when(r.createdAt),
          <StatusPill value={String(r.kind)} />,
          <Mono>
            {String(r.resourceKind ?? '')} {String(r.providerId)}
          </Mono>,
          `${String(r.executor)}/${String(r.region)}`,
          r.instanceId ? (
            <Link to={`/browsers/${String(r.instanceId)}`} className="text-accent hover:underline">
              <Mono>{String(r.instanceId)}</Mono>
            </Link>
          ) : (
            '—'
          ),
          String(r.detail ?? ''),
          r.status === 'open' ? (
            <Button size="sm" onClick={() => setResolving(String(r.id))}>
              {t('findings.resolve')}
            </Button>
          ) : (
            <span className="text-xs text-muted">{t('findings.resolvedAt', { when: when(r.resolvedAt) })}</span>
          ),
        ]}
      />
      <ReasonDialog
        open={resolving !== null}
        title={t('findings.resolveTitle')}
        description={t('findings.resolveHelp')}
        confirm={t('findings.resolve')}
        busy={resolve.isPending}
        onClose={() => setResolving(null)}
        onConfirm={(note) => resolving && resolve.mutate({ id: resolving, note }, { onSuccess: () => setResolving(null), onError: (e) => toast(errorText(e), 'error') })}
      />
    </div>
  );
}

export function UsersPage() {
  const { t, term, errorText } = useT();
  const toast = useToast();
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const users = useAdminPage<UserRow>(`/users?q=${encodeURIComponent(query)}`, ADMIN_PAGE.users);
  const [pending, setPending] = useState<{ user: UserRow; action: 'suspend' | 'unsuspend' } | null>(null);
  const act = useAdminAction((v: { id: string; action: string; reason: string }) => post(`/users/${v.id}/actions`, { action: v.action, reason: v.reason }));
  const [credit, setCredit] = useState<UserRow | null>(null);
  const [amount, setAmount] = useState('5');
  const [unfreeze, setUnfreeze] = useState<UserRow | null>(null);
  const [resetTwoFactor, setResetTwoFactor] = useState<UserRow | null>(null);
  const reset2fa = useAdminAction((v: { id: string; reason: string }) => post(`/users/${v.id}/reset-two-factor`, { reason: v.reason }));
  const grant = useAdminAction((v: { id: string; amountMicros: number; reason: string }) => post(`/users/${v.id}/credit`, { amountMicros: v.amountMicros, reason: v.reason }));
  const thaw = useAdminAction((v: { id: string; reason: string }) => post(`/users/${v.id}/unfreeze`, { reason: v.reason }));
  const failed = (e: unknown) => toast(errorText(e), 'error');
  return (
    <div>
      <PageTitle title={t('nav.users')}>
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            setQuery(q.trim());
          }}
        >
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('users.searchPlaceholder')} className="w-64" />
          <Button type="submit">{t('common.search')}</Button>
        </form>
      </PageTitle>
      <Table
        rows={users.rows}
        pager={users.pager}
        rowKey={(u) => u.id}
        columns={[t('col.email'), t('col.joined'), t('col.balance'), t('col.browsers'), t('col.killSwitch')]}
        cells={(u) => [
          <span>
            {u.email} {u.admin ? <Pill>{t('users.staff')}</Pill> : null} {u.twoFactorEnabled ? <Pill tone="ok">2FA</Pill> : null}{' '}
            {u.termsVersion ? <Pill tone={u.termsVersion === TERMS_VERSION ? 'ok' : 'warn'}>{t('users.terms', { version: u.termsVersion })}</Pill> : null}
            {u.closure ? <Link to="/closures"><Pill tone={u.closure === 'closed' ? 'muted' : 'warn'}>{term(u.closure)}</Pill></Link> : null}
            <br />
            <Mono>{u.id}</Mono>
            {u.twoFactorEnabled ? (
              <Button size="sm" variant="ghost" className="ml-1" onClick={() => setResetTwoFactor(u)}>
                {t('users.reset2fa')}
              </Button>
            ) : null}
          </span>,
          when(u.createdAt),
          <span className="flex flex-wrap items-center gap-1.5">
            <span className="tabular-nums" title={t('users.balanceHint')}>
              <span className={u.balanceMicros < 0 ? 'text-error' : undefined}>{usd(u.balanceMicros)}</span>
              <span className="block text-xs text-muted">{t('users.balanceSplit', { available: usd(u.availableMicros), held: usd(u.reservedMicros) })}</span>
            </span>
            {u.frozenAt ? <Pill tone="bad">{t('users.frozen')}</Pill> : u.exhaustedAt ? <Pill tone="warn">{t('users.ranOut')}</Pill> : null}
            <Button size="sm" variant="ghost" onClick={() => setCredit(u)}>
              {t('users.credit')}
            </Button>
            {u.frozenAt ? (
              <Button size="sm" variant="ghost" onClick={() => setUnfreeze(u)}>
                {t('users.unfreeze')}
              </Button>
            ) : null}
          </span>,
          <Link to={`/browsers?q=${encodeURIComponent(u.email)}`} className="text-accent hover:underline">
            {u.browsers}
            {u.suspended ? t('users.suspendedCount', { n: u.suspended }) : ''}
          </Link>,
          u.suspended ? (
            <Button size="sm" onClick={() => setPending({ user: u, action: 'unsuspend' })}>
              {t('users.releaseAll')}
            </Button>
          ) : (
            <Button size="sm" variant="danger" disabled={!u.browsers} onClick={() => setPending({ user: u, action: 'suspend' })}>
              {t('users.suspendAll')}
            </Button>
          ),
        ]}
      />
      <ReasonDialog
        open={pending !== null}
        title={pending ? t(pending.action === 'suspend' ? 'users.suspendTitle' : 'users.releaseTitle', { email: pending.user.email }) : ''}
        description={pending?.action === 'suspend' ? t('users.suspendHelp') : undefined}
        confirm={t(pending?.action === 'suspend' ? 'users.suspendAll' : 'users.releaseAll')}
        danger={pending?.action === 'suspend'}
        busy={act.isPending}
        onClose={() => setPending(null)}
        onConfirm={(reason) => pending && act.mutate({ id: pending.user.id, action: pending.action, reason }, { onSuccess: () => setPending(null), onError: failed })}
      />
      <ReasonDialog
        open={credit !== null}
        title={credit ? t('users.creditTitle', { email: credit.email }) : ''}
        description={t('users.creditHelp')}
        confirm={t('users.apply')}
        busy={grant.isPending}
        onClose={() => setCredit(null)}
        onConfirm={(reason) => {
          const micros = Math.round(Number(amount) * 1_000_000);
          if (!credit || !Number.isFinite(micros) || micros === 0) return;
          grant.mutate({ id: credit.id, amountMicros: micros, reason }, { onSuccess: () => setCredit(null), onError: failed });
        }}
      >
        <Label htmlFor="credit-amount">{t('users.amount')}</Label>
        <Input id="credit-amount" type="number" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} className="mb-3 w-40" />
      </ReasonDialog>
      <ReasonDialog
        open={resetTwoFactor !== null}
        title={resetTwoFactor ? t('users.resetTitle', { email: resetTwoFactor.email }) : ''}
        description={t('users.resetHelp')}
        confirm={t('users.reset2fa')}
        danger
        busy={reset2fa.isPending}
        onClose={() => setResetTwoFactor(null)}
        onConfirm={(reason) => resetTwoFactor && reset2fa.mutate({ id: resetTwoFactor.id, reason }, { onSuccess: () => setResetTwoFactor(null), onError: failed })}
      />
      <ReasonDialog
        open={unfreeze !== null}
        title={unfreeze ? t('users.unfreezeTitle', { email: unfreeze.email }) : ''}
        description={t('users.unfreezeHelp')}
        confirm={t('users.unfreeze')}
        busy={thaw.isPending}
        onClose={() => setUnfreeze(null)}
        onConfirm={(reason) => unfreeze && thaw.mutate({ id: unfreeze.id, reason }, { onSuccess: () => setUnfreeze(null), onError: failed })}
      />
    </div>
  );
}

/** In what currency an order was paid, in its smallest unit. */
const orderMoney = (cents: number, currency: string) => {
  const f = new Intl.NumberFormat('en-US', { style: 'currency', currency });
  return f.format(cents / 10 ** (f.resolvedOptions().maximumFractionDigits ?? 2));
};
const ERASE_DAYS = 30;

/** Closed accounts and their unused paid credit, for support when a user asks for a refund (api closure.ts). */
export function ClosuresPage() {
  const { t, term } = useT();
  const rows = useAdminPage<ClosureRow>('/closures', ADMIN_PAGE.closures);
  return (
    <div>
      <PageTitle title={t('nav.closures')} />
      <p className="mb-3 max-w-3xl text-xs text-muted">{t('closures.note')}</p>
      <Table
        rows={rows.rows}
        pager={rows.pager}
        rowKey={(r) => r.userId}
        columns={[t('col.account'), t('col.requested'), t('col.status'), t('col.reason'), t('col.browsers'), t('col.finalBalance'), t('col.unusedPaid'), t('col.paidOrders'), t('col.erased')]}
        empty={t('closures.empty')}
        cells={(r) => [
          <span>
            {r.email ?? <span className="text-muted">{t('closures.erasedEmail')}</span>}
            <br />
            <Mono>{r.userId}</Mono>
          </span>,
          when(r.requestedAt),
          <Pill tone={r.status === 'closed' ? 'muted' : 'warn'}>{term(r.status)}</Pill>,
          r.reason ? t(`closures.reason.${r.reason}`) : '—',
          r.browsers,
          r.balanceMicros === null ? <span className="text-xs text-muted">{t('closures.pending')}</span> : <span className="tabular-nums">{usd(r.balanceMicros)}</span>,
          r.paidMicros === null ? '—' : <span className="tabular-nums">{usd(r.paidMicros)}</span>,
          r.paidOrders?.length ? (
            <ul className="space-y-1">
              {r.paidOrders.map((o) => (
                <li key={o.orderId}>
                  <span className="font-medium tabular-nums">{orderMoney(o.refundCents, o.currency)}</span> <span className="text-xs text-muted">{o.provider}</span>
                  <br />
                  <Mono>{o.orderId}</Mono>
                </li>
              ))}
            </ul>
          ) : (
            '—'
          ),
          r.erasedAt ? when(r.erasedAt) : <span className="text-xs text-muted">{t('closures.erasesOn', { when: when(new Date(new Date(r.requestedAt).getTime() + ERASE_DAYS * 86_400_000).toISOString()) })}</span>,
        ]}
      />
    </div>
  );
}

export function AuditPage() {
  const { t } = useT();
  const [params] = useSearchParams();
  const [target, setTarget] = useState(params.get('target') ?? '');
  const [actor, setActor] = useState('');
  const [filters, setFilters] = useState({ target: params.get('target') ?? '', actor: '' });
  const rows = useAdminPage<Row>(`/audit?target=${encodeURIComponent(filters.target)}&actor=${encodeURIComponent(filters.actor)}`, ADMIN_PAGE.audit);
  return (
    <div>
      <PageTitle title={t('nav.audit')}>
        <form
          className="flex flex-wrap gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            setFilters({ target: target.trim(), actor: actor.trim() });
          }}
        >
          <Input value={target} onChange={(e) => setTarget(e.target.value)} placeholder={t('audit.target')} className="w-56" />
          <Input value={actor} onChange={(e) => setActor(e.target.value)} placeholder={t('audit.actor')} className="w-44" />
          <Button type="submit">{t('common.filter')}</Button>
        </form>
      </PageTitle>
      <Table
        rows={rows.rows}
        pager={rows.pager}
        rowKey={(r) => String(r.id)}
        columns={[t('col.when'), t('col.actor'), t('col.action'), t('col.target'), t('col.detail')]}
        cells={(r) => [when(r.createdAt), <Mono>{String(r.actor)}</Mono>, String(r.action), <Mono>{String(r.target)}</Mono>, <Json value={r.detail} />]}
      />
    </div>
  );
}
