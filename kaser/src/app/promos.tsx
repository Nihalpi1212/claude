import React, { useState } from 'react';
import { ScrollView, Text, View } from 'react-native';
import Animated, { FadeInDown } from 'react-native-reanimated';
import { LinearGradient } from 'expo-linear-gradient';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Tap, Txt, haptic } from '@/components/ui';
import { Header } from '@/components/Header';
import { useT } from '@/i18n';
import { useStore } from '@/store';
import { promos } from '@/data/catalog';
import { useTheme } from '@/theme';

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
          <Animated.View key={p.code} entering={FadeInDown.delay(i * 60).springify().damping(16)}>
            <Tap
              scale={0.97}
              onPress={() => {
                haptic.success();
                if (cart) { setPromo(p.code); router.push('/cart'); } else { setCopied(p.code); }
              }}
            >
              <LinearGradient colors={p.colors} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={{ borderRadius: 26, borderCurve: 'continuous', padding: 20, flexDirection: 'row', alignItems: 'center', gap: 12 }}>
                <View style={{ flex: 1, gap: 6 }}>
                  <Txt variant="title3" style={{ color: '#fff' }}>{l(p.title)}</Txt>
                  <Text style={{ color: 'rgba(255,255,255,0.85)', fontSize: 13 }}>{l(p.desc)}</Text>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 6 }}>
                    <View style={{ paddingHorizontal: 12, height: 30, borderRadius: 15, backgroundColor: 'rgba(255,255,255,0.22)', justifyContent: 'center' }}>
                      <Text style={{ color: '#fff', fontWeight: '800', letterSpacing: 1.4 }}>{p.code}</Text>
                    </View>
                    <Text style={{ color: '#fff', fontSize: 12, fontWeight: '600' }}>{current === p.code ? '✓ ' + tr('promoApplied') : copied === p.code ? '✓' : cart ? tr('apply') : ''}</Text>
                  </View>
                </View>
                <Text style={{ fontSize: 56 }}>{p.emoji}</Text>
              </LinearGradient>
            </Tap>
          </Animated.View>
        ))}
      </ScrollView>
    </View>
  );
}
