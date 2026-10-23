import { Link } from 'react-router';
import { useI18n } from '../lib/i18n.js';

/**
 * “Learn more” into the docs, for a hint whose details were moved there. `to` is `slug#heading`.
 * `newTab` for a link inside a form or dialog, whose work following the link would throw away.
 */
export function DocsLink({ to, label, newTab = false }: { to: string; label?: string; newTab?: boolean }) {
  const { t } = useI18n();
  return (
    <Link to={`/docs/${to}`} {...(newTab ? { target: '_blank', rel: 'noopener' } : {})} className="font-medium whitespace-nowrap text-accent hover:underline">
      {label ?? t('common.learnMore')}
    </Link>
  );
}
