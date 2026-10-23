import { ChevronRight, Info } from 'lucide-react';
import { anchor, type Article, type Block } from '../content/types.js';

function ArticleBlock({ block: b }: { block: Block }) {
  if ('h' in b)
    return (
      <h2 id={anchor(b)} className="scroll-mt-24 pt-6 text-xl font-semibold tracking-tight first:pt-0">
        {b.h}
      </h2>
    );
  if ('ul' in b)
    return (
      <ul className="space-y-2 text-muted [&>li]:relative [&>li]:pl-5 [&>li]:before:absolute [&>li]:before:top-[0.7em] [&>li]:before:left-0 [&>li]:before:h-px [&>li]:before:w-2.5 [&>li]:before:bg-fg">
        {b.ul.map((li) => (
          <li key={li}>{li}</li>
        ))}
      </ul>
    );
  if ('note' in b)
    return (
      <p className="flex gap-2.5 border-l-2 border-fg bg-surface px-4 py-3 text-sm text-fg">
        <Info className="mt-0.5 size-4 shrink-0" aria-hidden /> {b.note}
      </p>
    );
  if ('code' in b)
    return (
      <figure className="border border-border">
        {b.label ? <figcaption className="border-b border-border bg-surface px-3 py-1 font-mono text-[11px] text-subtle">{b.label}</figcaption> : null}
        <pre className="overflow-x-auto bg-bg p-3 font-mono text-xs leading-relaxed"><code>{b.code}</code></pre>
      </figure>
    );
  if ('details' in b)
    return (
      <details className="group border border-border">
        <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-2.5 font-medium select-none hover:bg-surface [&::-webkit-details-marker]:hidden">
          <ChevronRight className="size-4 shrink-0 text-muted transition-transform group-open:rotate-90" aria-hidden /> {b.details}
        </summary>
        <div className="space-y-3 border-t border-border p-4 text-sm">
          {b.blocks.map((inner, i) => <ArticleBlock key={i} block={inner} />)}
        </div>
      </details>
    );
  return <p className="text-muted">{b.p}</p>;
}

/** Renders a docs article or a policy from its blocks. */
export function ArticleBody({ article }: { article: Article }) {
  return (
    <div className="space-y-4 text-[15px] leading-relaxed">
      {article.blocks.map((b, i) => <ArticleBlock key={i} block={b} />)}
    </div>
  );
}

/** The article's headings, for an "in this article" list. */
export const headings = (article: Article) => article.blocks.filter((b): b is { h: string; id?: string } => 'h' in b);
