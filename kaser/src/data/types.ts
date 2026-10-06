import type { L } from '@/i18n';

export type Option = { id: string; name: L; price: number };
export type OptionGroup = {
  id: string;
  title: L;
  required?: boolean;
  /** 1 = single choice (radio); >1 = multi choice up to `max` */
  max: number;
  options: Option[];
};
export type MenuItem = {
  id: string;
  name: L;
  desc: L;
  price: number;
  emoji: string;
  popular?: boolean;
  groups?: OptionGroup[];
};
export type MenuSection = { id: string; title: L; items: MenuItem[] };

export type Category = { id: string; name: L; emoji: string; colors: [string, string]; kind: 'food' | 'shop' };

export type Vendor = {
  id: string;
  name: L;
  tagline: L;
  categoryId: string;
  cuisine: L;
  emoji: string;
  colors: [string, string];
  rating: number;
  ratingCount: number;
  etaMin: number;
  etaMax: number;
  deliveryFee: number;
  minOrder: number;
  /** opening / closing hour, 24h. close < open means past midnight */
  hours: [number, number];
  area: L;
  promo?: L;
  busy?: boolean;
  menu: MenuSection[];
};

export type Promo = {
  code: string;
  title: L;
  desc: L;
  colors: [string, string];
  emoji: string;
  kind: 'percent' | 'freeDelivery' | 'flat';
  value: number;
  cap?: number;
  minSubtotal: number;
};

export type Address = {
  id: string;
  label: 'home' | 'work' | 'other';
  area: string;
  zone: string;
  street: string;
  building: string;
  unit: string;
  landmark: string;
};
