import { Info } from 'lucide-react';
import { anchor, type Article } from '../content/types.js';

/** Renders a docs article or a policy from its blocks. */
export function ArticleBody({ article }: { article: Article }) {
  return (
    <div className="space-y-4 text-[15px] leading-relaxed">
      {article.blocks.map((b, i) => {
        if ('h' in b)
          return (
            <h2 key={i} id={anchor(b)} className="scroll-mt-20 pt-4 text-lg font-semibold tracking-tight">
              {b.h}
            </h2>
          );
        if ('ul' in b)
          return (
            <ul key={i} className="list-disc space-y-1.5 pl-5 text-muted marker:text-subtle">
              {b.ul.map((li) => (
                <li key={li}>{li}</li>
              ))}
            </ul>
          );
        if ('note' in b)
          return (
            <p key={i} className="flex gap-2 rounded-[var(--radius-control)] border border-accent/30 bg-accent/5 px-4 py-3 text-sm">
              <Info className="mt-0.5 size-4 shrink-0 text-accent" aria-hidden /> {b.note}
            </p>
          );
        return (
          <p key={i} className="text-muted">
            {b.p}
          </p>
        );
      })}
    </div>
  );
}

/** The article's headings, for an "in this article" list. */
export const headings = (article: Article) => article.blocks.filter((b): b is { h: string; id?: string } => 'h' in b);
