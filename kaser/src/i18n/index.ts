import { en } from './en';
import { ar } from './ar';
import { useStore } from '@/store';

export type Lang = 'en' | 'ar';
export type Key = keyof typeof en;
export type L = { en: string; ar: string };

const dict: Record<Lang, Record<string, string>> = { en, ar };

export function translate(lang: Lang, key: Key, vars?: Record<string, string | number>) {
  let s = dict[lang][key] ?? en[key] ?? key;
  if (vars) for (const k of Object.keys(vars)) s = s.replace(`{${k}}`, String(vars[k]));
  return s;
}

export function useT() {
  const lang = useStore((s) => s.lang);
  return {
    lang,
    isRTL: lang === 'ar',
    t: (key: Key, vars?: Record<string, string | number>) => translate(lang, key, vars),
    l: (v: L) => v[lang],
  };
}

export const toArabicDigits = (s: string) => s.replace(/\d/g, (d) => '٠١٢٣٤٥٦٧٨٩'[+d]);
