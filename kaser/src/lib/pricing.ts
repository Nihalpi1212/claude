import { vendorById } from '@/data/vendors';
import { promos } from '@/data/catalog';
import type { MenuItem, Promo } from '@/data/types';

export type CartLine = {
  key: string;
  itemId: string;
  qty: number;
  /** groupId -> selected option ids */
  sel: Record<string, string[]>;
  note?: string;
};

export const SERVICE_FEE = 2;
export const PRIORITY_FEE = 4;
export const PLUS_FREE_DELIVERY_MIN = 30;

export function findItem(vendorId: string, itemId: string): MenuItem | undefined {
  const v = vendorById(vendorId);
  if (!v) return undefined;
  for (const s of v.menu) for (const i of s.items) if (i.id === itemId) return i;
  return undefined;
}

export function unitPrice(item: MenuItem, sel: Record<string, string[]>) {
  let p = item.price;
  for (const g of item.groups ?? []) {
    for (const oid of sel[g.id] ?? []) p += g.options.find((o) => o.id === oid)?.price ?? 0;
  }
  return p;
}

export function lineKey(itemId: string, sel: Record<string, string[]>, note?: string) {
  const s = Object.keys(sel).sort().map((k) => `${k}:${[...sel[k]].sort().join('+')}`).join('|');
  return `${itemId}#${s}#${note ?? ''}`;
}

export function findPromo(code: string): Promo | undefined {
  return promos.find((p) => p.code === code.trim().toUpperCase());
}

export type Totals = {
  subtotal: number;
  deliveryFee: number;
  serviceFee: number;
  priorityFee: number;
  discount: number;
  tip: number;
  total: number;
  freeBecause?: 'plus' | 'promo' | 'store';
};

export function computeTotals(opts: {
  vendorId: string;
  lines: CartLine[];
  promo?: Promo;
  tip: number;
  plus: boolean;
  priority?: boolean;
}): Totals {
  const v = vendorById(opts.vendorId);
  const subtotal = opts.lines.reduce((s, l) => {
    const it = findItem(opts.vendorId, l.itemId);
    return s + (it ? unitPrice(it, l.sel) * l.qty : 0);
  }, 0);
  const promoOk = opts.promo && subtotal >= opts.promo.minSubtotal ? opts.promo : undefined;
  let deliveryFee = v?.deliveryFee ?? 0;
  let freeBecause: Totals['freeBecause'];
  if (deliveryFee === 0) freeBecause = 'store';
  else if (promoOk?.kind === 'freeDelivery') { deliveryFee = 0; freeBecause = 'promo'; }
  else if (opts.plus && subtotal >= PLUS_FREE_DELIVERY_MIN) { deliveryFee = 0; freeBecause = 'plus'; }
  let discount = 0;
  if (promoOk?.kind === 'percent') discount = Math.min(promoOk.cap ?? Infinity, (subtotal * promoOk.value) / 100);
  if (promoOk?.kind === 'flat') discount = Math.min(subtotal, promoOk.value);
  discount = Math.round(discount * 100) / 100;
  const serviceFee = opts.plus ? 0 : SERVICE_FEE;
  const priorityFee = opts.priority ? PRIORITY_FEE : 0;
  const total = Math.max(0, subtotal + deliveryFee + serviceFee + priorityFee - discount + opts.tip);
  return { subtotal, deliveryFee, serviceFee, priorityFee, discount, tip: opts.tip, total, freeBecause };
}

export function optionText(item: MenuItem, sel: Record<string, string[]>) {
  const en: string[] = [];
  const ar: string[] = [];
  for (const g of item.groups ?? []) {
    for (const oid of sel[g.id] ?? []) {
      const o = g.options.find((x) => x.id === oid);
      if (o) { en.push(o.name.en); ar.push(o.name.ar); }
    }
  }
  return { en: en.join(' · '), ar: ar.join(' · ') };
}
