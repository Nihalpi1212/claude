import { Alert } from 'react-native';
import { useStore } from '@/store';
import { translate } from '@/i18n';
import type { CartLine } from './pricing';

/** Add to cart; if the cart holds another store's items, confirm before replacing. */
export function addToCartSafe(vendorId: string, line: Omit<CartLine, 'key'>, onDone?: () => void) {
  const { cart, lang, addToCart, clearCart } = useStore.getState();
  if (cart && cart.vendorId !== vendorId && cart.lines.length > 0) {
    Alert.alert(translate(lang, 'differentStore'), translate(lang, 'differentStoreBody'), [
      { text: translate(lang, 'cancel'), style: 'cancel' },
      {
        text: translate(lang, 'newCart'),
        style: 'destructive',
        onPress: () => {
          clearCart();
          addToCart(vendorId, line);
          onDone?.();
        },
      },
    ]);
    return false;
  }
  addToCart(vendorId, line);
  onDone?.();
  return true;
}

export const needsOptions = (item: { groups?: { required?: boolean }[] }) => !!item.groups?.some((g) => g.required) || false;
