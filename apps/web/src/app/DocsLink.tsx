import { Link } from 'react-router';
import { useI18n } from '../lib/i18n.js';

/** “Learn more” into the docs, for a hint whose details were moved there. `to` is `slug#heading`. */
export function DocsLink({ to, label }: { to: string; label?: string }) {
  const { t } = useI18n();
  return (
    <Link to={`/docs/${to}`} className="font-medium whitespace-nowrap text-accent hover:underline">
      {label ?? t('common.learnMore')}
    </Link>
  );
}
