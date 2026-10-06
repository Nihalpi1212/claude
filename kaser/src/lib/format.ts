import type { Lang } from '@/i18n';

export function money(n: number, lang: Lang = 'en', forceDecimals = false) {
  const s = !forceDecimals && Math.abs(n % 1) < 0.005 ? n.toFixed(0) : n.toFixed(2);
  return lang === 'ar' ? `${s} ر.ق` : `QAR ${s}`;
}

export function pad(n: number) {
  return n < 10 ? `0${n}` : String(n);
}

export function timeLabel(ts: number, lang: Lang) {
  const d = new Date(ts);
  const h = d.getHours();
  const ampm = h >= 12 ? (lang === 'ar' ? 'م' : 'PM') : lang === 'ar' ? 'ص' : 'AM';
  return `${h % 12 === 0 ? 12 : h % 12}:${pad(d.getMinutes())} ${ampm}`;
}

export function dateLabel(ts: number, lang: Lang) {
  return new Date(ts).toLocaleDateString(lang === 'ar' ? 'ar-QA' : 'en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

export const formatPhone = (p: string) => `+974 ${p.slice(0, 4)} ${p.slice(4)}`;
export const validQatarMobile = (p: string) => /^[3567]\d{7}$/.test(p);
export const uid = (prefix = '') => prefix + Math.random().toString(36).slice(2, 8).toUpperCase();
