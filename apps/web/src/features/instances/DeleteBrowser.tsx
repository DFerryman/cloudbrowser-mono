import type { Instance } from '@cloudbrowser/contracts';
import { Button, Dialog, Input, Label, useToast } from '@cloudbrowser/ui';
import { useId, useState } from 'react';
import { useI18n } from '../../lib/i18n.js';
import { useLifecycle } from './hooks.js';

/**
 * Permanent deletion asks for the browser's exact name, the same in Settings → Danger zone and
 * in a browser card's menu, so a slip cannot delete the wrong browser. With `onCancel` (the
 * dialog) the actions sit below the field; otherwise next to it.
 */
export function DeleteBrowserForm({ instance: i, onDeleted, onCancel }: { instance: Instance; onDeleted?: () => void; onCancel?: () => void }) {
  const { t, errorMessage } = useI18n();
  const toast = useToast();
  const lifecycle = useLifecycle();
  const id = useId();
  const [typed, setTyped] = useState('');
  const busy = lifecycle.isPending && lifecycle.variables?.action === 'delete';
  const ready = typed === i.name && !busy && i.status !== 'deleting';
  const submit = () => {
    if (!ready) return;
    lifecycle.mutate({ id: i.id, action: 'delete' }, { onSuccess: () => onDeleted?.(), onError: (e) => toast(errorMessage(e), 'error') });
  };
  const confirm = (
    <Button type="submit" variant="danger" disabled={!ready}>
      {t('settings.delete')}
    </Button>
  );
  return (
    <form onSubmit={(e) => { e.preventDefault(); submit(); }}>
      <Label htmlFor={id}>{t('settings.deleteType', { name: i.name })}</Label>
      {onCancel ? (
        <>
          <Input id={id} value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" autoFocus />
          <div className="mt-4 flex justify-end gap-2">
            <Button type="button" onClick={onCancel}>{t('common.cancel')}</Button>
            {confirm}
          </div>
        </>
      ) : (
        <div className="flex max-w-xl gap-2">
          <Input id={id} value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />
          {confirm}
        </div>
      )}
    </form>
  );
}

export function DeleteBrowserDialog({ instance, open, onClose }: { instance: Instance; open: boolean; onClose: () => void }) {
  const { t } = useI18n();
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()} title={t('browsers.deleteTitle', { name: instance.name })} description={t('settings.deleteBody')} closeLabel={t('common.cancel')}>
      {/* A new form each time it opens, so the name is never already typed. */}
      {open ? <DeleteBrowserForm instance={instance} onDeleted={onClose} onCancel={onClose} /> : null}
    </Dialog>
  );
}
