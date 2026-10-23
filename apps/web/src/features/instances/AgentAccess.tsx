import type { AgentControlMode, AgentKey, AutomationClient, AutomationStatus, Instance } from '@cloudbrowser/contracts';
import { Button, cn, Dialog, Hint, Input, Label, Section, Select, useToast } from '@cloudbrowser/ui';
import { Check, ChevronRight, Copy, Eye, EyeOff, Hand, KeyRound, Play, Trash2 } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router';
import { DocsLink } from '../../app/DocsLink.js';
import { useI18n, useRelativeTime } from '../../lib/i18n.js';
import type { MessageKey } from '../../messages/en.js';
import { agentHandoff, agentServer, agentSetups, keyEnvCommands, type AgentClient } from './agent-setup.js';
import { useAutomation, useCreateAgentKey, useRevokeClient, useSetControl, useUpdateInstance } from './hooks.js';

type Expiry = '7' | '30' | '90' | '365' | 'never';
const EXPIRIES: Expiry[] = ['7', '30', '90', '365', 'never'];

/** Copies text and says so for a moment; a refused clipboard is reported instead. */
function useCopy() {
  const { t } = useI18n();
  const toast = useToast();
  const [copied, setCopied] = useState<string | null>(null);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(null), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  const copy = async (id: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(id);
    } catch {
      toast(t('agents.copyFailed'), 'error');
    }
  };
  return { copied, copy };
}

function CopyButton({ id, text, copy }: { id: string; text: string; copy: ReturnType<typeof useCopy> }) {
  const { t } = useI18n();
  const done = copy.copied === id;
  return (
    <Button size="sm" variant="ghost" className="shrink-0" onClick={() => void copy.copy(id, text)}>
      {done ? <Check /> : <Copy />} {t(done ? 'agents.copied' : 'agents.copy')}
    </Button>
  );
}

/** A code or text block with a copy button and a label (a file, a terminal, who it is for). */
function CodeBox({ id, label, code, copy, wrap = false, testId }: {
  id: string;
  label: string;
  code: string;
  copy: ReturnType<typeof useCopy>;
  /** Prose wraps; configuration keeps its lines and scrolls. */
  wrap?: boolean;
  testId?: string;
}) {
  return (
    <div className="border border-border">
      <div className="flex items-center justify-between gap-2 border-b border-border bg-surface px-3 py-1">
        <span className="truncate font-mono text-[11px] text-subtle">{label}</span>
        <CopyButton id={id} text={code} copy={copy} />
      </div>
      <pre className={cn('max-h-64 overflow-auto bg-bg p-3 font-mono text-xs leading-relaxed', wrap && 'break-words whitespace-pre-wrap')} data-testid={testId}>{code}</pre>
    </div>
  );
}

function Choices<T extends string>({ label, options, value, onChange }: {
  label: string;
  options: { id: T; label: string }[];
  value: T;
  onChange: (id: T) => void;
}) {
  return (
    <div role="tablist" aria-label={label} className="flex flex-wrap gap-1">
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          role="tab"
          aria-selected={o.id === value}
          className={cn('border px-2.5 py-1 text-xs transition-colors',
            o.id === value ? 'border-fg bg-fg text-bg' : 'border-border text-muted hover:border-border-strong hover:text-fg')}
          onClick={() => onChange(o.id)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
  return (
    <section className="space-y-2.5">
      <h3 className="flex items-center gap-2 text-sm font-medium">
        <span className="grid size-5 shrink-0 place-items-center border border-border-strong font-mono text-[11px]" aria-hidden>{n}</span>
        {title}
      </h3>
      {children}
    </section>
  );
}

/**
 * Connecting an agent (docs/agent-access.md): nothing to install, and the agent sets itself up.
 * The user's part is the secret: create a key (shown once; only its hash is kept) and save it in
 * an environment variable. The agent gets a short setup that refers to the variable and points it
 * to the steps for its own client; the same steps, filled in, are folded away for doing it by hand.
 */
function AgentConnect({ instance: i, status }: { instance: Instance; status: AutomationStatus | undefined }) {
  const { t, errorMessage } = useI18n();
  const toast = useToast();
  const create = useCreateAgentKey();
  const copy = useCopy();
  const [name, setName] = useState('');
  const [expiry, setExpiry] = useState<Expiry>('90');
  const [capability, setCapability] = useState<'control' | 'view'>('control');
  const [created, setCreated] = useState<AgentKey | null>(null);
  const [client, setClient] = useState<AgentClient>('claude-code');
  const [system, setSystem] = useState<'unix' | 'windows'>(() => (typeof navigator !== 'undefined' && /Windows/i.test(navigator.userAgent) ? 'windows' : 'unix'));
  useEffect(() => { setCreated(null); setName(''); }, [i.id]);

  const url = created?.mcpUrl ?? status?.mcpUrl ?? '';
  const server = url ? agentServer({ url, browserName: i.name }) : null;
  const setups = server ? agentSetups(server) : [];
  const setup = setups.find((s) => s.client === client) ?? setups[0];

  return (
    <div className="space-y-6">
      <Step n={1} title={t('agents.step.key')}>
        {created ? (
          <div className="border border-accent/50 bg-accent/5 p-4" role="status">
            <p className="flex items-center gap-1.5 text-sm font-medium"><KeyRound className="size-4" aria-hidden /> {t('agents.key.createdTitle', { name: created.name })}</p>
            <p className="mt-1 text-xs leading-relaxed text-muted">{t('agents.key.createdHint')}</p>
            <div className="mt-2 flex items-center gap-2 border border-border bg-bg px-3 py-1.5">
              <code className="min-w-0 flex-1 break-all font-mono text-xs" data-testid="agent-key">{created.key}</code>
              <CopyButton id="key" text={created.key} copy={copy} />
            </div>
            {server ? (
              <div className="mt-4 space-y-2">
                <p className="text-sm font-medium">{t('agents.env.title', { env: server.env })}</p>
                <Choices
                  label={t('agents.env.title', { env: server.env })}
                  options={[{ id: 'unix', label: t('agents.env.unix') }, { id: 'windows', label: t('agents.env.windows') }]}
                  value={system}
                  onChange={setSystem}
                />
                <CodeBox id="env" label={t('agents.setup.terminal')} code={keyEnvCommands(server.env, created.key)[system]} copy={copy} testId="agent-key-env" />
                <Hint>{t('agents.env.hint')}</Hint>
              </div>
            ) : null}
            <Button size="sm" variant="ghost" className="mt-2" onClick={() => setCreated(null)}>{t('agents.key.done')}</Button>
          </div>
        ) : (
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              const keyName = name.trim();
              if (!keyName) return;
              create.mutate(
                { id: i.id, body: { name: keyName, expiresInDays: expiry === 'never' ? null : (Number(expiry) as 7 | 30 | 90 | 365), capability } },
                { onSuccess: (key) => { setCreated(key); setName(''); }, onError: (e) => toast(errorMessage(e), 'error') },
              );
            }}
          >
            <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto_auto]">
              <div className="min-w-0">
                <Label htmlFor={`agent-key-name-${i.id}`}>{t('agents.key.name')}</Label>
                <Input id={`agent-key-name-${i.id}`} value={name} maxLength={64} placeholder={t('agents.key.namePlaceholder')} onChange={(e) => setName(e.target.value)} />
              </div>
              <div>
                <Label htmlFor={`agent-key-expiry-${i.id}`}>{t('agents.key.expires')}</Label>
                <Select id={`agent-key-expiry-${i.id}`} value={expiry} onChange={(e) => setExpiry(e.target.value as Expiry)}>
                  {EXPIRIES.map((d) => <option key={d} value={d}>{t(`agents.key.expires.${d}` as MessageKey)}</option>)}
                </Select>
              </div>
              <div>
                <Label htmlFor={`agent-key-capability-${i.id}`}>{t('agents.key.capability')}</Label>
                <Select id={`agent-key-capability-${i.id}`} value={capability} onChange={(e) => setCapability(e.target.value as 'control' | 'view')}>
                  <option value="control">{t('agents.key.capability.control')}</option>
                  <option value="view">{t('agents.key.capability.view')}</option>
                </Select>
              </div>
            </div>
            <Button type="submit" variant="primary" disabled={!name.trim() || create.isPending}><KeyRound /> {t('agents.key.create')}</Button>
            {server && status?.clients.length ? <Hint>{t('agents.key.skip', { env: server.env })}</Hint> : null}
          </form>
        )}
      </Step>

      {server ? (
        <Step n={2} title={t('agents.step.handoff')}>
          <p className="text-sm leading-relaxed text-muted">{t('agents.handoff.hint', { env: server.env })}</p>
          <CodeBox id="handoff" label={t('agents.handoff.label')} code={agentHandoff(server, i.name)} copy={copy} wrap testId="agent-handoff" />
        </Step>
      ) : (
        <p className="text-sm text-muted">{t('common.loading')}</p>
      )}

      {server && setup ? (
        <details className="group border border-border" data-testid="agent-manual">
          <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2.5 text-sm font-medium select-none hover:bg-surface [&::-webkit-details-marker]:hidden">
            <ChevronRight className="size-4 shrink-0 text-muted transition-transform group-open:rotate-90" aria-hidden />
            {t('agents.manual.title')}
          </summary>
          <div className="space-y-3 border-t border-border p-3">
            <div>
              <p className="text-xs text-muted">{t('agents.connect.url')}</p>
              <div className="mt-1 flex items-center gap-2 border border-border bg-surface px-3 py-1.5">
                <code className="min-w-0 flex-1 truncate font-mono text-xs" data-testid="mcp-url">{server.url}</code>
                <CopyButton id="url" text={server.url} copy={copy} />
              </div>
            </div>
            <Choices
              label={t('agents.setup.title')}
              options={setups.map((s) => ({ id: s.client, label: s.client === 'other' ? t('agents.setup.other') : s.label }))}
              value={setup.client}
              onChange={setClient}
            />
            <CodeBox
              id={`setup-${setup.client}`}
              label={setup.client === 'other' ? t('agents.setup.otherWhere') : setup.where === 'Terminal' ? t('agents.setup.terminal') : setup.where}
              code={setup.code}
              copy={copy}
              testId="agent-setup"
            />
            <Hint>{t(`agents.setup.hint.${setup.client}` as MessageKey, { env: server.env })}</Hint>
          </div>
        </details>
      ) : null}
      <Hint>{t('agents.security')} <DocsLink to="coding-agents" /></Hint>
    </div>
  );
}

/** The browser's keys (and paired bridges from before), with the connected one marked. */
function AgentKeys({ instance: i, status }: { instance: Instance; status: AutomationStatus | undefined }) {
  const { t, errorMessage, locale } = useI18n();
  const relative = useRelativeTime();
  const toast = useToast();
  const revoke = useRevokeClient();
  const connectedId = status?.session?.clientId ?? null;
  const describe = (c: AutomationClient) => {
    if (connectedId === c.id) return t('agents.keys.connected');
    const parts = [
      c.lastSeenAt ? (c.lastClient ? t('agents.keys.lastUsedBy', { when: relative(c.lastSeenAt) ?? '', client: c.lastClient }) : t('agents.keys.lastUsed', { when: relative(c.lastSeenAt) ?? '' })) : t('agents.keys.neverUsed'),
      c.expiresAt ? (Date.parse(c.expiresAt) <= Date.now() ? t('agents.keys.expired') : t('agents.keys.expiresOn', { date: new Date(c.expiresAt).toLocaleDateString(locale) })) : null,
    ];
    return parts.filter(Boolean).join(' · ');
  };
  return (
    <div>
      <p className="text-sm font-medium">{t('agents.keys')}</p>
      {status?.clients.length ? (
        <ul className="mt-2 divide-y divide-border text-sm" data-testid="agent-keys">
          {status.clients.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
              <span className="min-w-0">
                <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 font-medium">
                  <KeyRound className="size-4 text-muted" aria-hidden /> {c.name}
                  {c.keyPrefix ? <code className="font-mono text-xs font-normal text-subtle">{c.keyPrefix}…</code> : null}
                  {c.kind === 'bridge' ? <span className="text-xs font-normal text-subtle">{t('agents.keys.legacy')}</span> : null}
                  {c.capability === 'view' ? <span className="text-xs font-normal text-subtle">{t('agents.keys.viewOnly')}</span> : null}
                </span>
                <span className={cn('block text-xs', connectedId === c.id ? 'text-running' : 'text-subtle')}>{describe(c)}</span>
              </span>
              <Button size="sm" disabled={revoke.isPending} onClick={() => revoke.mutate({ id: i.id, clientId: c.id }, { onError: (e) => toast(errorMessage(e), 'error') })}>
                <Trash2 /> {t('agents.revoke')}
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-sm text-muted">{status ? t('agents.keys.none') : t('common.loading')}</p>
      )}
    </div>
  );
}

/** Who may drive the browser now, with the choices that change it. */
function AgentControl({ instance: i, status }: { instance: Instance; status: AutomationStatus | undefined }) {
  const { t, errorMessage } = useI18n();
  const toast = useToast();
  const control = useSetControl();
  const setMode = (mode: AgentControlMode) => control.mutate({ id: i.id, mode }, { onError: (e) => toast(errorMessage(e), 'error') });
  const connected = status?.session ?? null;
  const connectedName = connected ? status?.clients.find((c) => c.id === connected.clientId)?.name ?? t('agents.unknownClient') : null;
  return (
    <div>
      <p className="text-sm font-medium">{t('agents.control')}</p>
      <p className="mt-1 text-sm text-muted">
        {connected ? t('agents.connected', { name: connectedName ?? '' }) : t('agents.notConnected')}
        {' · '}
        {t(`agents.mode.${i.agentControl}`)}
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        {i.agentControl !== 'agent' ? (
          <Button variant="primary" disabled={control.isPending} onClick={() => setMode('agent')}><Play /> {t('agents.handBack')}</Button>
        ) : (
          <Button disabled={control.isPending} onClick={() => setMode('user')}><Hand /> {t('agents.pause')}</Button>
        )}
        {i.agentControl !== 'privacy' ? (
          <Button disabled={control.isPending} onClick={() => setMode('privacy')}><EyeOff /> {t('agents.privacy')}</Button>
        ) : (
          <Button disabled={control.isPending} onClick={() => setMode('user')}><Eye /> {t('agents.privacyOff')}</Button>
        )}
      </div>
      <Hint className="mt-2">{t('agents.controlHint')}</Hint>
    </div>
  );
}

function AccessSwitch({ instance: i }: { instance: Instance }) {
  const { t, errorMessage } = useI18n();
  const toast = useToast();
  const update = useUpdateInstance();
  return (
    <label className="flex cursor-pointer items-start gap-3">
      <input
        type="checkbox"
        className="mt-0.5 size-4 accent-[var(--color-fg)]"
        checked={i.agentAccess}
        disabled={update.isPending}
        onChange={(e) => update.mutate({ id: i.id, patch: { agentAccess: e.target.checked } }, { onSuccess: () => toast(t('settings.saved')), onError: (err) => toast(errorMessage(err), 'error') })}
      />
      <span className="min-w-0">
        <span className="block text-sm font-medium">{t('agents.allow')}</span>
        <span className="mt-0.5 block text-xs leading-relaxed text-subtle">{t('agents.allowHint')} <DocsLink to="coding-agents" /></span>
      </span>
    </label>
  );
}

/**
 * Settings → Coding agent access (docs/agent-access.md): the switch chosen at creation, who may
 * drive the browser right now, connecting an agent, and the browser's access keys.
 */
export function AgentAccessSection({ instance: i }: { instance: Instance }) {
  const { t } = useI18n();
  const status = useAutomation(i.id);
  return (
    <Section title={t('agents.title')} description={t('agents.description')}>
      <AccessSwitch instance={i} />
      {i.agentAccess ? (
        <>
          <div className="mt-5 border-t border-border pt-5"><AgentControl instance={i} status={status.data} /></div>
          <div className="mt-5 border-t border-border pt-5">
            <p className="mb-3 text-sm font-medium">{t('agents.connect.title')}</p>
            <AgentConnect instance={i} status={status.data} />
          </div>
          <div className="mt-5 border-t border-border pt-5"><AgentKeys instance={i} status={status.data} /></div>
        </>
      ) : null}
    </Section>
  );
}

/** The dashboard's way in: connect an agent to one browser without leaving the list. */
export function AgentConnectDialog({ instance: i, open, onClose }: { instance: Instance; open: boolean; onClose: () => void }) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const status = useAutomation(i.id, open && i.agentAccess);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => { if (!next) onClose(); }}
      size="lg"
      title={t('agents.dialog.title', { name: i.name })}
      description={t('agents.connect.description')}
      closeLabel={t('common.close')}
      footer={
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Button variant="ghost" onClick={() => { onClose(); navigate(`/browsers/${i.id}/settings`); }}>{t('agents.dialog.settings')}</Button>
          <Button onClick={onClose}>{t('common.close')}</Button>
        </div>
      }
    >
      <AccessSwitch instance={i} />
      {i.agentAccess ? (
        <>
          {status.data?.session ? <p className="mt-4 text-sm text-running">{t('agents.connected', { name: status.data.clients.find((c) => c.id === status.data!.session!.clientId)?.name ?? t('agents.unknownClient') })}</p> : null}
          <div className="mt-5 border-t border-border pt-5"><AgentConnect instance={i} status={status.data} /></div>
          <div className="mt-5 border-t border-border pt-5"><AgentKeys instance={i} status={status.data} /></div>
        </>
      ) : (
        <p className="mt-4 text-sm text-muted">{t('agents.dialog.off')}</p>
      )}
    </Dialog>
  );
}
