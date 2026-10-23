import { Button, cn } from '@cloudbrowser/ui';
import { useI18n } from '../lib/i18n.js';

/**
 * What a section shows when its data failed to load and there is nothing older to show: the
 * reason and a way to try again, rather than a skeleton that never resolves.
 */
export function LoadError({ error, onRetry, className }: { error: unknown; onRetry?: () => void; className?: string }) {
  const { t, errorMessage } = useI18n();
  return (
    <div role="alert" className={cn('flex flex-wrap items-center gap-3 text-sm text-error', className)}>
      <span>{errorMessage(error)}</span>
      {onRetry ? <Button size="sm" onClick={onRetry}>{t('common.retry')}</Button> : null}
    </div>
  );
}
