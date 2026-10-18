import { MICROS_PER_USD } from '@cloudbrowser/contracts';

/**
 * Money is held in micro-dollars. Amounts of a dollar or more show cents; per-unit rates show
 * enough digits to be exact (an IP is $0.006 an hour, not "$0.01").
 */
export function money(micros: number, locale: string) {
  const usd = micros / MICROS_PER_USD;
  const abs = Math.abs(usd);
  const max = abs === 0 || abs >= 1 ? 2 : 4;
  return new Intl.NumberFormat(locale, { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: max }).format(usd);
}

export const cents = (c: number) => c * (MICROS_PER_USD / 100);

/** A quantity with up to two decimals, for usage tables. */
export function quantity(n: number, locale: string) {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: n < 10 ? 2 : 1 }).format(n);
}

export function bytes(n: number | null | undefined) {
  if (n == null) return '—';
  if (n < 1 << 20) return `${Math.max(1, Math.round(n / 1024))} KB`;
  if (n < 1 << 30) return `${(n / (1 << 20)).toFixed(1)} MB`;
  return `${(n / (1 << 30)).toFixed(1)} GB`;
}
