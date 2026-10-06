import { rise } from '@/lib/motion';
import React from 'react';
import { Text, View } from 'react-native';
import Animated, { FadeInDown, FadeOutDown, LinearTransition } from 'react-native-reanimated';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { Tap } from './ui';
import { useT } from '@/i18n';
import { useCartTotals, useStore } from '@/store';
import { vendorById } from '@/data/vendors';
import { money } from '@/lib/format';
import { radius, shadow, useTheme } from '@/theme';

/** Floating "View cart" capsule. */
export function CartBar({ bottom }: { bottom: number }) {
  const t = useTheme();
  const { t: tr, l, lang } = useT();
  const cart = useStore((s) => s.cart);
  const totals = useCartTotals();
  if (!cart || !totals) return null;
  const v = vendorById(cart.vendorId);
  return (
    <Animated.View
      key="cartbar"
      entering={rise()}
      exiting={FadeOutDown}
      layout={LinearTransition.duration(220)}
      style={{ position: 'absolute', start: 16, end: 16, bottom }}
    >
      <Tap onPress={() => router.push('/cart')} scale={0.97}>
        <View style={[{ height: 60, borderRadius: radius.xl, borderCurve: 'continuous', flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, gap: 12, backgroundColor: t.primary }, shadow(t, 3), { shadowColor: '#FD8912' }]}>
          <View style={{ width: 34, height: 34, borderRadius: 17, backgroundColor: t.onPrimary, alignItems: 'center', justifyContent: 'center' }}>
            <Text style={{ color: '#FFF8EE', fontWeight: '800' }}>{totals.count}</Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={{ color: t.onPrimary, fontWeight: '800', fontSize: 16 }}>{tr('viewCart')}</Text>
            <Text numberOfLines={1} style={{ color: t.onPrimary, opacity: 0.75, fontSize: 12 }}>{v ? l(v.name) : ''}</Text>
          </View>
          <Text style={{ color: t.onPrimary, fontWeight: '800', fontSize: 16 }}>{money(totals.subtotal, lang)}</Text>
          <Ionicons name="bag-handle" size={20} color={t.onPrimary} />
        </View>
      </Tap>
    </Animated.View>
  );
}
