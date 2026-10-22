import type { AgentControlMode, Instance, Pairing } from '@cloudbrowser/contracts';
import { Button, cn, Hint, Input, Label, Section, useToast } from '@cloudbrowser/ui';
import { Bot, Check, Copy, Eye, EyeOff, Hand, Play, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { DocsLink } from '../../app/DocsLink.js';
import { useI18n, useRelativeTime } from '../../lib/i18n.js';
import { useAutomation, useCreatePairing, useRevokeClient, useSetControl, useUpdateInstance } from './hooks.js';

/**
 * Settings → Coding agent access (docs/agent-access.md): the switch chosen at creation, who may
 * drive the browser right now, the paired bridges and pairing a new one. A pairing code is shown
 * once; the bridge that redeems it gets a credential this page never sees.
 */
export function AgentAccessSection({ instance: i }: { instance: Instance }) {
  const { t, errorMessage } = useI18n();
  const relative = useRelativeTime();
  const toast = useToast();
  const status = useAutomation(i.id);
  const update = useUpdateInstance();
  const control = useSetControl();
  const pair = useCreatePairing();
  const revoke = useRevokeClient();
  const [name, setName] = useState('');
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => { setPairing(null); setName(''); }, [i.id]);

  const fail = (e: unknown) => toast(errorMessage(e), 'error');
  const setMode = (mode: AgentControlMode) => control.mutate({ id: i.id, mode }, { onError: fail });
  const toggle = (enabled: boolean) => update.mutate({ id: i.id, patch: { agentAccess: enabled } }, { onSuccess: () => toast(t('settings.saved')), onError: fail });
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast(t('agents.copyFailed'), 'error');
    }
  };
  const connected = status.data?.session ?? null;
  const connectedName = connected ? status.data?.clients.find((c) => c.id === connected.clientId)?.name ?? t('agents.unknownClient') : null;

  return (
    <Section title={t('agents.title')} description={t('agents.description')}>
      <label className="flex cursor-pointer items-start gap-3">
        <input type="checkbox" className="mt-0.5 size-4 accent-[var(--color-fg)]" checked={i.agentAccess} disabled={update.isPending} onChange={(e) => toggle(e.target.checked)} />
        <span className="min-w-0">
          <span className="block text-sm font-medium">{t('agents.allow')}</span>
          <span className="mt-0.5 block text-xs leading-relaxed text-subtle">{t('agents.allowHint')} <DocsLink to="coding-agents" /></span>
        </span>
      </label>

      {i.agentAccess ? (
        <>
          <div className="mt-5 border-t border-border pt-5">
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

          <div className="mt-5 border-t border-border pt-5">
            <p className="text-sm font-medium">{t('agents.clients')}</p>
            {status.data?.clients.length ? (
              <ul className="mt-2 divide-y divide-border text-sm">
                {status.data.clients.map((c) => (
                  <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                    <span className="min-w-0">
                      <span className="flex items-center gap-1.5 font-medium"><Bot className="size-4 text-muted" aria-hidden /> {c.name}</span>
                      <span className="block text-xs text-subtle">
                        {connected?.clientId === c.id ? t('agents.client.connected')
                          : c.activatedAt ? (c.lastSeenAt ? t('agents.client.lastSeen', { when: relative(c.lastSeenAt) ?? '' }) : t('agents.client.paired'))
                            : t('agents.client.pending')}
                      </span>
                    </span>
                    <Button size="sm" disabled={revoke.isPending} onClick={() => revoke.mutate({ id: i.id, clientId: c.id }, { onError: fail })}>
                      <Trash2 /> {t('agents.revoke')}
                    </Button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-2 text-sm text-muted">{status.isPending ? t('common.loading') : t('agents.noClients')}</p>
            )}
          </div>

          <div className="mt-5 border-t border-border pt-5">
            <p className="text-sm font-medium">{t('agents.pair')}</p>
            {pairing ? (
              <div className="mt-2 border border-border bg-surface p-4">
                <p className="text-sm">{t('agents.pair.codeHint')}</p>
                <p className="mt-2 font-mono text-xl font-semibold tracking-[0.12em] tabular-nums">{pairing.code}</p>
                <p className="mt-3 text-xs text-subtle">{t('agents.pair.command')}</p>
                <pre className="mt-1 overflow-x-auto bg-bg p-2 font-mono text-xs">{pairing.command}</pre>
                <div className="mt-3 flex flex-wrap gap-2">
                  <Button size="sm" onClick={() => void copy(pairing.command)}>{copied ? <Check /> : <Copy />} {copied ? t('agents.copied') : t('agents.copyCommand')}</Button>
                  <Button size="sm" variant="ghost" onClick={() => setPairing(null)}>{t('common.close')}</Button>
                </div>
                <Hint className="mt-2">{t('agents.pair.expires', { time: new Date(pairing.expiresAt).toLocaleTimeString() })}</Hint>
              </div>
            ) : (
              <div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-end">
                <div className="min-w-0 flex-1">
                  <Label htmlFor="pair-name">{t('agents.pair.name')}</Label>
                  <Input id="pair-name" value={name} maxLength={64} placeholder={t('agents.pair.namePlaceholder')} onChange={(e) => setName(e.target.value)} />
                </div>
                <Button
                  variant="primary"
                  className={cn('justify-center')}
                  disabled={!name.trim() || pair.isPending}
                  onClick={() => pair.mutate({ id: i.id, name: name.trim() }, { onSuccess: (p) => { setPairing(p); setName(''); }, onError: fail })}
                >
                  {t('agents.pair.create')}
                </Button>
              </div>
            )}
            <Hint className="mt-2">{t('agents.pair.hint')}</Hint>
          </div>
        </>
      ) : null}
    </Section>
  );
}
