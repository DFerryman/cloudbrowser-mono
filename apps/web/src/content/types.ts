/** Structured long-form content (docs and policies), written once per language. */
export type Block = { h: string; id?: string } | { p: string } | { ul: string[] } | { note: string };

export type Article = {
  slug: string;
  title: string;
  summary: string;
  blocks: Block[];
};

/** A heading's anchor: its explicit id, or its text in lowercase with dashes. */
export const anchor = (b: { h: string; id?: string }) =>
  b.id ?? b.h.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '');
