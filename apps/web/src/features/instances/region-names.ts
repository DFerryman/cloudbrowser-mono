import type { Region } from '@cloudbrowser/contracts';
import type { Locale } from '../../lib/i18n.js';

/** Region cities in Chinese; English uses the city as stored. */
const CITY_ZH: Record<string, string> = {
  'N. Virginia': '弗吉尼亚北部', Ohio: '俄亥俄', 'N. California': '加利福尼亚北部', Oregon: '俄勒冈', Montreal: '蒙特利尔',
  Calgary: '卡尔加里', 'Querétaro': '克雷塔罗', 'São Paulo': '圣保罗', Dublin: '都柏林', London: '伦敦', Paris: '巴黎',
  Frankfurt: '法兰克福', Zurich: '苏黎世', Stockholm: '斯德哥尔摩', Milan: '米兰', 'Aragón': '阿拉贡', 'Tel Aviv': '特拉维夫',
  UAE: '阿联酋', Bahrain: '巴林', 'Cape Town': '开普敦', 'Hong Kong': '香港', Taipei: '台北', Mumbai: '孟买', Hyderabad: '海得拉巴',
  Tokyo: '东京', Seoul: '首尔', Osaka: '大阪', Singapore: '新加坡', Sydney: '悉尼', Jakarta: '雅加达', Melbourne: '墨尔本',
  'Kuala Lumpur': '吉隆坡', Auckland: '奥克兰', Bangkok: '曼谷', West: '西部',
};
/** City-states: the city already names the place. */
const CITY_STATES = new Set(['HK', 'SG', 'BH']);

const displayNames = new Map<Locale, Intl.DisplayNames | null>();
function countryName(code: string, locale: Locale): string {
  if (!displayNames.has(locale)) {
    try { displayNames.set(locale, new Intl.DisplayNames([locale], { type: 'region' })); } catch { displayNames.set(locale, null); }
  }
  try { return (code && displayNames.get(locale)?.of(code)) || code; } catch { return code; }
}

/** "Tokyo, Japan" / "东京 · 日本": where the browser runs and where its IP is. */
export function regionPlace(r: Pick<Region, 'city' | 'country' | 'name'>, locale: Locale): string {
  const city = locale === 'zh-CN' ? (CITY_ZH[r.city] ?? r.city) : r.city;
  if (!r.country || r.city === r.name) return r.name;
  if (CITY_STATES.has(r.country)) return city;
  return locale === 'zh-CN' ? `${countryName(r.country, locale)} · ${city}` : `${city}, ${countryName(r.country, locale)}`;
}

/** Words a user might type to find a region. */
export function regionSearchText(r: Region, locale: Locale): string {
  return [r.id, r.name, r.city, CITY_ZH[r.city], r.country, countryName(r.country, 'en'), countryName(r.country, locale)].filter(Boolean).join(' ').toLowerCase();
}
