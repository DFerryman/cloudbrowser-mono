import { extendTailwindMerge } from 'tailwind-merge';

/** The design tokens' extra sizes, so a later class replaces an earlier one of the same kind. */
const merge = extendTailwindMerge({
  extend: { theme: { text: ['xs', 'sm', 'base', 'lg', 'xl', '2xl', '3xl', '4xl'] } },
});

/** Joins class names; when two set the same property, the later one wins (a caller's override). */
export function cn(...parts: Array<string | false | null | undefined>) {
  return merge(parts.filter(Boolean).join(' '));
}
