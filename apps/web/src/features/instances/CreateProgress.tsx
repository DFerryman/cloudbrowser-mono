import { CREATE_PHASES, createPhaseForStep, type Instance } from '@cloudbrowser/contracts';
import { cn } from '@cloudbrowser/ui';
import { Check, Loader2 } from 'lucide-react';
import { useI18n } from '../../lib/i18n.js';

/** Reserving your dedicated IP → Creating encrypted storage → Starting Chrome → Checking your IP. */
export function CreateProgress({ instance, tone = 'default' }: { instance: Instance; tone?: 'default' | 'dark' }) {
  const { t } = useI18n();
  const current = CREATE_PHASES.indexOf(createPhaseForStep(instance.currentOperation?.step ?? null));
  return (
    <div>
      <ol className="space-y-1.5">
        {CREATE_PHASES.map((phase, i) => (
          <li
            key={phase}
            className={cn(
              'flex items-center gap-2 text-sm',
              i > current && (tone === 'dark' ? 'text-zinc-500' : 'text-muted'),
              i === current && 'font-medium',
            )}
          >
            {i < current ? (
              <Check className="size-4 text-running" aria-hidden />
            ) : i === current ? (
              <Loader2 className="size-4 animate-spin text-starting" aria-hidden />
            ) : (
              <span className="grid size-4 place-items-center" aria-hidden>
                <span className="size-1.5 rounded-full bg-current opacity-50" />
              </span>
            )}
            {t(`phase.${phase}`)}
          </li>
        ))}
      </ol>
      <p className={cn('mt-2 text-xs', tone === 'dark' ? 'text-zinc-400' : 'text-muted')}>{t('phase.typical')}</p>
    </div>
  );
}
