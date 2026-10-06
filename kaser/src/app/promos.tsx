import { rise } from '@/lib/motion';
import React, { useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import Animated, { FadeInDown } from 'react-native-reanimated';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Tap, Txt, haptic } from '@/components/ui';
import { Header } from '@/components/Header';
import { useT } from '@/i18n';
import { useStore } from '@/store';
import { promos } from '@/data/catalog';
import { radius, useTheme } from '@/theme';

export default function Promos() {
  const t = useTheme();
  const { t: tr, l } = useT();
  const insets = useSafeAreaInsets();
  const cart = useStore((s) => s.cart);
  const setPromo = useStore((s) => s.setPromo);
  const current = useStore((s) => s.promoCode);
  const [copied, setCopied] = useState<string | null>(null);
  return (
    <View style={{ flex: 1, backgroundColor: t.bg }}>
      <Header title={tr('offers')} />
      <ScrollView contentContainerStyle={{ padding: 20, gap: 14, paddingBottom: insets.bottom + 40 }} showsVerticalScrollIndicator={false}>
        {promos.map((p, i) => (
          <Animated.View key={p.code} entering={rise(i * 60)}>
            <Tap
              scale={0.97}
              onPress={() => {
                haptic.success();
                if (cart) { setPromo(p.code); router.push('/cart'); } else { setCopied(p.code); }
              }}
            >
              <View style={{ borderRadius: radius.xl, borderCurve: 'continuous', padding: 20, flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: p.colors[0] }}>
                <View style={{ flex: 1, gap: 6 }}>
                  <Txt variant="title3" style={{ color: p.fg }}>{l(p.title)}</Txt>
                  <Text style={{ color: p.fg, opacity: 0.8, fontSize: 13 }}>{l(p.desc)}</Text>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 6 }}>
                    <View style={{ paddingHorizontal: 12, height: 32, borderRadius: 16, backgroundColor: p.fg === '#201B17' ? 'rgba(32,27,23,0.12)' : 'rgba(255,255,255,0.18)', justifyContent: 'center' }}>
                      <Text style={{ color: p.fg, fontWeight: '800', letterSpacing: 1.4 }}>{p.code}</Text>
                    </View>
                    <Text style={{ color: p.fg, fontSize: 12, fontWeight: '700' }}>{current === p.code ? '✓ ' + tr('promoApplied') : copied === p.code ? '✓' : cart ? tr('apply') : ''}</Text>
                  </View>
                </View>
                <Text style={{ fontSize: 56 }}>{p.emoji}</Text>
              </View>
            </Tap>
          </Animated.View>
        ))}
      </ScrollView>
    </View>
  );
}
