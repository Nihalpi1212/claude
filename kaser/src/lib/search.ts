import { vendors, isOpen } from '@/data/vendors';
import type { MenuItem, Vendor } from '@/data/types';
import type { Lang } from '@/i18n';

export type SortKey = 'recommended' | 'rating' | 'fastest' | 'delivery';

export function sortVendors(list: Vendor[], sort: SortKey) {
  const a = [...list];
  switch (sort) {
    case 'rating': return a.sort((x, y) => y.rating - x.rating);
    case 'fastest': return a.sort((x, y) => x.etaMin - y.etaMin);
    case 'delivery': return a.sort((x, y) => x.deliveryFee - y.deliveryFee);
    default: return a.sort((x, y) => Number(isOpen(y)) - Number(isOpen(x)) || y.rating * Math.log(y.ratingCount) - x.rating * Math.log(x.ratingCount));
  }
}

const norm = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[ً-ٰٟ]/g, '').trim();

export function searchAll(q: string, lang: Lang) {
  const n = norm(q);
  if (!n) return { stores: [] as Vendor[], dishes: [] as { vendor: Vendor; item: MenuItem }[] };
  const hit = (...vals: string[]) => vals.some((v) => norm(v).includes(n));
  const stores = vendors.filter((v) => hit(v.name.en, v.name.ar, v.cuisine.en, v.cuisine.ar, v.tagline.en, v.tagline.ar));
  const dishes: { vendor: Vendor; item: MenuItem }[] = [];
  for (const v of vendors) for (const s of v.menu) for (const item of s.items) if (hit(item.name.en, item.name.ar, item.desc.en, item.desc.ar)) dishes.push({ vendor: v, item });
  return { stores, dishes: dishes.slice(0, 30) };
}
