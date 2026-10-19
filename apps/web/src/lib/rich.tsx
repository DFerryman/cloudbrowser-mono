import { Fragment, type ReactNode } from 'react';

/** Fills `{name}` placeholders in a translated string with elements, such as links. */
export function rich(text: string, parts: Record<string, ReactNode>): ReactNode {
  return text.split(/(\{\w+\})/).map((piece, i) => {
    const key = /^\{(\w+)\}$/.exec(piece)?.[1];
    return <Fragment key={i}>{key !== undefined && key in parts ? parts[key] : piece}</Fragment>;
  });
}
