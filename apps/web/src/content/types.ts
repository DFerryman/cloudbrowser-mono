/** Structured long-form content (docs and policies), written once per language. */
export type Block =
  | { h: string; id?: string }
  | { p: string }
  | { ul: string[] }
  | { note: string }
  /** Text to copy as is: a command or a configuration file, with where it goes. */
  | { code: string; label?: string }
  /** A folded section: details most readers skip. Markdown shows it as a subheading, unfolded. */
  | { details: string; blocks: Block[] };

export type Article = {
  slug: string;
  title: string;
  summary: string;
  blocks: Block[];
};

/** A heading's anchor: its explicit id, or its text in lowercase with dashes. */
export const anchor = (b: { h: string; id?: string }) =>
  b.id ?? b.h.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '');
