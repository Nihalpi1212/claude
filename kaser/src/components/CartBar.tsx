import React from 'react';
import { Text, View } from 'react-native';
import Animated, { FadeInDown, FadeOutDown, LinearTransition } from 'react-native-reanimated';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { Tap } from './ui';
import { useT } from '@/i18n';
import { useCartTotals, useStore } from '@/store';
import { vendorById } from '@/data/vendors';
import { money } from '@/lib/format';
import { brand, shadow, useTheme } from '@/theme';

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
      entering={FadeInDown.springify().damping(15)}
      exiting={FadeOutDown}
      layout={LinearTransition.springify()}
      style={{ position: 'absolute', start: 16, end: 16, bottom }}
    >
      <Tap onPress={() => router.push('/cart')} scale={0.97}>
        <LinearGradient
          colors={[brand.maroonLight, brand.maroon]}
          start={{ x: 0, y: 0 }}
          end={{ x: 1, y: 1 }}
          style={[{ height: 60, borderRadius: 22, borderCurve: 'continuous', flexDirection: 'row', alignItems: 'center', paddingHorizontal: 14, gap: 12 }, shadow(t, 3), { shadowColor: brand.maroon }]}
        >
          <View style={{ width: 34, height: 34, borderRadius: 17, backgroundColor: 'rgba(255,255,255,0.22)', alignItems: 'center', justifyContent: 'center' }}>
            <Text style={{ color: '#fff', fontWeight: '800' }}>{totals.count}</Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={{ color: '#fff', fontWeight: '700', fontSize: 16 }}>{tr('viewCart')}</Text>
            <Text numberOfLines={1} style={{ color: 'rgba(255,255,255,0.8)', fontSize: 12 }}>{v ? l(v.name) : ''}</Text>
          </View>
          <Text style={{ color: '#fff', fontWeight: '800', fontSize: 16 }}>{money(totals.subtotal, lang)}</Text>
          <Ionicons name="bag-handle" size={20} color="#fff" />
        </LinearGradient>
      </Tap>
    </Animated.View>
  );
}
