import { Info } from 'lucide-react';
import { anchor, type Article } from '../content/types.js';

/** Renders a docs article or a policy from its blocks. */
export function ArticleBody({ article }: { article: Article }) {
  return (
    <div className="space-y-4 text-[15px] leading-relaxed">
      {article.blocks.map((b, i) => {
        if ('h' in b)
          return (
            <h2 key={i} id={anchor(b)} className="scroll-mt-24 pt-6 text-xl font-semibold tracking-tight first:pt-0">
              {b.h}
            </h2>
          );
        if ('ul' in b)
          return (
            <ul key={i} className="space-y-2 text-muted [&>li]:relative [&>li]:pl-5 [&>li]:before:absolute [&>li]:before:top-[0.7em] [&>li]:before:left-0 [&>li]:before:h-px [&>li]:before:w-2.5 [&>li]:before:bg-fg">
              {b.ul.map((li) => (
                <li key={li}>{li}</li>
              ))}
            </ul>
          );
        if ('note' in b)
          return (
            <p key={i} className="flex gap-2.5 border-l-2 border-fg bg-surface px-4 py-3 text-sm text-fg">
              <Info className="mt-0.5 size-4 shrink-0" aria-hidden /> {b.note}
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
