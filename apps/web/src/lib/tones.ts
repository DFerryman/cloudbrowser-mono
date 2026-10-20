/** The six palette hues (packages/ui styles.css), each giving a kind of thing its own color. */
export type Tone = 'indigo' | 'violet' | 'teal' | 'amber' | 'rose' | 'sky';
export const TONES: readonly Tone[] = ['indigo', 'violet', 'teal', 'amber', 'rose', 'sky'];

/** Static class names per hue, so Tailwind sees every one of them. */
export const TONE: Record<Tone, { text: string; bg: string; soft: string; border: string; ring: string }> = {
  indigo: { text: 'text-indigo', bg: 'bg-indigo', soft: 'bg-indigo/10', border: 'border-indigo', ring: 'ring-indigo/40' },
  violet: { text: 'text-violet', bg: 'bg-violet', soft: 'bg-violet/10', border: 'border-violet', ring: 'ring-violet/40' },
  teal: { text: 'text-teal', bg: 'bg-teal', soft: 'bg-teal/10', border: 'border-teal', ring: 'ring-teal/40' },
  amber: { text: 'text-amber', bg: 'bg-amber', soft: 'bg-amber/10', border: 'border-amber', ring: 'ring-amber/40' },
  rose: { text: 'text-rose', bg: 'bg-rose', soft: 'bg-rose/10', border: 'border-rose', ring: 'ring-rose/40' },
  sky: { text: 'text-sky', bg: 'bg-sky', soft: 'bg-sky/10', border: 'border-sky', ring: 'ring-sky/40' },
};

/** A stable hue for any string (a region, an area), so it keeps its color everywhere. */
export function toneFor(key: string): Tone {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return TONES[h % TONES.length]!;
}
