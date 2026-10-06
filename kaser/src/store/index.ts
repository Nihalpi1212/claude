import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Lang } from '@/i18n';
import type { Address } from '@/data/types';
import { couriers } from '@/data/catalog';
import { type CartLine, computeTotals, findPromo, lineKey, type Totals } from '@/lib/pricing';
import { uid } from '@/lib/format';
import { stageOf } from '@/lib/orders';

export type PaymentMethod = 'applepay' | 'googlepay' | 'card' | 'cash' | 'wallet';
export type DeliveryMode = 'standard' | 'priority' | 'scheduled';

export type Order = {
  id: string;
  vendorId: string;
  lines: (CartLine & { name: { en: string; ar: string }; emoji: string; unit: number; optionText: { en: string; ar: string } })[];
  totals: Totals;
  address: Address;
  payment: PaymentMethod;
  mode: DeliveryMode;
  scheduledFor?: number;
  notes: string;
  leaveAtDoor: boolean;
  createdAt: number;
  etaMinutes: number;
  courierIdx: number;
  status: 'active' | 'delivered' | 'cancelled';
  rating?: number;
  promo?: string;
  cashbackPaid?: boolean;
};

export type WalletTx = { id: string; at: number; amount: number; kind: 'topup' | 'order' | 'cashback' };

type State = {
  hydrated: boolean;
  lang: Lang;
  onboarded: boolean;
  user: { name: string; phone: string } | null;
  guest: boolean;
  addresses: Address[];
  selectedAddressId?: string;
  cart: { vendorId: string; lines: CartLine[] } | null;
  promoCode?: string;
  tip: number;
  orders: Order[];
  favorites: string[];
  wallet: number;
  walletTx: WalletTx[];
  plus: null | 'monthly' | 'yearly';
  recent: string[];

  setLang: (l: Lang) => void;
  finishOnboarding: () => void;
  signIn: (u: { name: string; phone: string }) => void;
  continueAsGuest: () => void;
  signOut: () => void;
  saveAddress: (a: Omit<Address, 'id'> & { id?: string }) => string;
  deleteAddress: (id: string) => void;
  selectAddress: (id: string) => void;
  addToCart: (vendorId: string, line: Omit<CartLine, 'key'>) => void;
  setQty: (key: string, qty: number) => void;
  clearCart: () => void;
  setPromo: (code?: string) => void;
  setTip: (n: number) => void;
  toggleFavorite: (vendorId: string) => void;
  placeOrder: (o: Omit<Order, 'id' | 'createdAt' | 'status' | 'courierIdx'>) => string;
  cancelOrder: (id: string) => void;
  rateOrder: (id: string, stars: number) => void;
  tick: () => void;
  topUp: (amt: number) => void;
  setPlus: (p: State['plus']) => void;
  addRecent: (q: string) => void;
  clearRecent: () => void;
};

export const useStore = create<State>()(
  persist(
    (set, get) => ({
      hydrated: false,
      lang: 'en',
      onboarded: false,
      user: null,
      guest: false,
      addresses: [],
      cart: null,
      tip: 0,
      orders: [],
      favorites: ['majlis', 'karak'],
      wallet: 25,
      walletTx: [{ id: 'w0', at: Date.now(), amount: 25, kind: 'cashback' }],
      plus: null,
      recent: [],

      setLang: (lang) => set({ lang }),
      finishOnboarding: () => set({ onboarded: true }),
      signIn: (user) => set({ user, guest: false }),
      continueAsGuest: () => set({ guest: true }),
      signOut: () => set({ user: null, guest: false, cart: null, promoCode: undefined }),

      saveAddress: (a) => {
        const id = a.id ?? uid('A');
        set((s) => {
          const next = { ...a, id } as Address;
          const exists = s.addresses.some((x) => x.id === id);
          return {
            addresses: exists ? s.addresses.map((x) => (x.id === id ? next : x)) : [...s.addresses, next],
            selectedAddressId: s.selectedAddressId ?? id,
          };
        });
        return id;
      },
      deleteAddress: (id) =>
        set((s) => {
          const addresses = s.addresses.filter((a) => a.id !== id);
          return { addresses, selectedAddressId: s.selectedAddressId === id ? addresses[0]?.id : s.selectedAddressId };
        }),
      selectAddress: (id) => set({ selectedAddressId: id }),

      addToCart: (vendorId, line) =>
        set((s) => {
          const key = lineKey(line.itemId, line.sel, line.note);
          const base = s.cart && s.cart.vendorId === vendorId ? s.cart.lines : [];
          const hit = base.find((l) => l.key === key);
          const lines = hit
            ? base.map((l) => (l.key === key ? { ...l, qty: l.qty + line.qty } : l))
            : [...base, { ...line, key }];
          return { cart: { vendorId, lines }, promoCode: s.cart?.vendorId === vendorId ? s.promoCode : undefined };
        }),
      setQty: (key, qty) =>
        set((s) => {
          if (!s.cart) return {};
          const lines = qty <= 0 ? s.cart.lines.filter((l) => l.key !== key) : s.cart.lines.map((l) => (l.key === key ? { ...l, qty } : l));
          return lines.length ? { cart: { ...s.cart, lines } } : { cart: null, promoCode: undefined };
        }),
      clearCart: () => set({ cart: null, promoCode: undefined, tip: 0 }),
      setPromo: (promoCode) => set({ promoCode }),
      setTip: (tip) => set({ tip }),
      toggleFavorite: (id) =>
        set((s) => ({ favorites: s.favorites.includes(id) ? s.favorites.filter((f) => f !== id) : [...s.favorites, id] })),

      placeOrder: (o) => {
        const id = String(Math.floor(100000 + Math.random() * 899999));
        const order: Order = { ...o, id, createdAt: Date.now(), status: 'active', courierIdx: Math.floor(Math.random() * couriers.length) };
        set((s) => ({
          orders: [order, ...s.orders],
          cart: null,
          promoCode: undefined,
          tip: 0,
          wallet: o.payment === 'wallet' ? +(s.wallet - o.totals.total).toFixed(2) : s.wallet,
          walletTx: o.payment === 'wallet' ? [{ id: uid('T'), at: Date.now(), amount: -o.totals.total, kind: 'order' as const }, ...s.walletTx] : s.walletTx,
        }));
        return id;
      },
      cancelOrder: (id) =>
        set((s) => {
          const o = s.orders.find((x) => x.id === id);
          const refund = o?.payment === 'wallet' || o?.payment === 'card' || o?.payment === 'applepay' || o?.payment === 'googlepay';
          return {
            orders: s.orders.map((x) => (x.id === id ? { ...x, status: 'cancelled' as const } : x)),
            wallet: o && refund ? +(s.wallet + o.totals.total).toFixed(2) : s.wallet,
            walletTx: o && refund ? [{ id: uid('T'), at: Date.now(), amount: o.totals.total, kind: 'topup' as const }, ...s.walletTx] : s.walletTx,
          };
        }),
      rateOrder: (id, rating) => set((s) => ({ orders: s.orders.map((o) => (o.id === id ? { ...o, rating } : o)) })),

      tick: () => {
        const s = get();
        let changed = false;
        let wallet = s.wallet;
        const tx: WalletTx[] = [];
        const orders = s.orders.map((o) => {
          if (o.status !== 'active' || stageOf(o) < 4) return o;
          changed = true;
          let cashbackPaid = o.cashbackPaid;
          if (s.plus && !cashbackPaid) {
            const cb = +(o.totals.subtotal * 0.05).toFixed(2);
            wallet = +(wallet + cb).toFixed(2);
            tx.push({ id: uid('T'), at: Date.now(), amount: cb, kind: 'cashback' });
            cashbackPaid = true;
          }
          return { ...o, status: 'delivered' as const, cashbackPaid };
        });
        if (changed) set({ orders, wallet, walletTx: [...tx, ...s.walletTx] });
      },

      topUp: (amt) =>
        set((s) => ({ wallet: +(s.wallet + amt).toFixed(2), walletTx: [{ id: uid('T'), at: Date.now(), amount: amt, kind: 'topup' }, ...s.walletTx] })),
      setPlus: (plus) => set({ plus }),
      addRecent: (q) => set((s) => ({ recent: [q, ...s.recent.filter((r) => r !== q)].slice(0, 8) })),
      clearRecent: () => set({ recent: [] }),
    }),
    {
      name: 'kaser-store-v1',
      storage: createJSONStorage(() => AsyncStorage),
      partialize: ({ hydrated, ...rest }) => Object.fromEntries(Object.entries(rest).filter(([, v]) => typeof v !== 'function')) as any,
      onRehydrateStorage: () => () => useStore.setState({ hydrated: true }),
    }
  )
);

export function useCartTotals(priority = false): (Totals & { count: number }) | null {
  const cart = useStore((s) => s.cart);
  const promoCode = useStore((s) => s.promoCode);
  const tip = useStore((s) => s.tip);
  const plus = useStore((s) => !!s.plus);
  if (!cart) return null;
  const t = computeTotals({ vendorId: cart.vendorId, lines: cart.lines, promo: promoCode ? findPromo(promoCode) : undefined, tip, plus, priority });
  return { ...t, count: cart.lines.reduce((n, l) => n + l.qty, 0) };
}
