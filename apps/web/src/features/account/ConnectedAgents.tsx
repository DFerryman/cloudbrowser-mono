import { Button, Dialog, Section, useToast } from '@cloudbrowser/ui';
import { Unplug } from 'lucide-react';
import { useState } from 'react';
import { DocsLink } from '../../app/DocsLink.js';
import { useI18n } from '../../lib/i18n.js';
import { AgentClientRow } from '../instances/AgentAccess.js';
import { useAgentConnections, useDisconnectAgents } from '../instances/hooks.js';

/**
 * Every coding-agent key and sign-in of the account's browsers (docs/agent-access.md), so one can
 * be disconnected without first finding its browser, or all of them at once.
 */
export function ConnectedAgents({ className }: { className?: string }) {
  const { t, errorMessage } = useI18n();
  const toast = useToast();
  const list = useAgentConnections();
  const disconnect = useDisconnectAgents();
  const [confirm, setConfirm] = useState(false);
  const rows = list.data ?? [];
  const onError = (e: unknown) => toast(errorMessage(e), 'error');
  return (
    <Section title={t('account.agents.title')} description={t('account.agents.body')} action={<DocsLink to="coding-agents" />} className={className}>
      {rows.length ? (
        <ul className="divide-y divide-border text-sm" data-testid="account-agents">
          {rows.map((c) => (
            <AgentClientRow key={c.id} client={c} browserName={c.instanceName} pending={disconnect.isPending} onRemove={() => disconnect.mutate({ clientId: c.id }, { onError })} />
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted">{list.isPending ? t('common.loading') : list.isError ? errorMessage(list.error) : t('account.agents.none')}</p>
      )}
      {rows.length > 1 ? (
        <div className="mt-4 border-t border-border pt-4">
          <Button disabled={disconnect.isPending} onClick={() => setConfirm(true)}><Unplug /> {t('account.agents.disconnectAll')}</Button>
        </div>
      ) : null}
      <Dialog
        open={confirm}
        onOpenChange={setConfirm}
        title={t('account.agents.disconnectAllTitle')}
        description={t('account.agents.disconnectAllBody', { n: rows.length })}
        closeLabel={t('common.cancel')}
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setConfirm(false)}>{t('common.cancel')}</Button>
            <Button
              variant="danger"
              disabled={disconnect.isPending}
              onClick={() => disconnect.mutate({}, {
                onSuccess: () => { setConfirm(false); toast(t('account.agents.disconnectedAll')); },
                onError,
              })}
            >
              <Unplug /> {t('account.agents.disconnectAll')}
            </Button>
          </div>
        }
      >
        <p className="text-sm text-muted">{t('account.agents.disconnectAllHint')}</p>
      </Dialog>
    </Section>
  );
}
