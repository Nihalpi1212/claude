import { router } from 'expo-router';
import { useStore } from '@/store';
import { haptic } from '@/components/ui';

/** Put a previous order's lines back into the cart and open it. */
export function reorder(orderId: string) {
  const s = useStore.getState();
  const o = s.orders.find((x) => x.id === orderId);
  if (!o) return;
  s.clearCart();
  for (const ln of o.lines) s.addToCart(o.vendorId, { itemId: ln.itemId, qty: ln.qty, sel: ln.sel, note: ln.note });
  haptic.success();
  router.push('/cart');
}
