import React, { useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import Animated from 'react-native-reanimated';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { RingPattern } from '@/components/Brand';
import { Button, GlassCircle, Tap, haptic } from '@/components/ui';
import { rise } from '@/lib/motion';
import { useT } from '@/i18n';
import { useStore } from '@/store';
import { money } from '@/lib/format';
import { brand, radius } from '@/theme';

const PRICES = { monthly: 19, yearly: 149 } as const;

export default function Rewards() {
  const { t: tr, lang } = useT();
  const insets = useSafeAreaInsets();
  const plus = useStore((s) => s.plus);
  const setPlus = useStore((s) => s.setPlus);
  const [plan, setPlan] = useState<'monthly' | 'yearly'>('yearly');
  const perks: [keyof typeof Ionicons.glyphMap, string][] = [['bicycle', tr('plusB1')], ['wallet', tr('plusB2')], ['sparkles', tr('plusB3')]];
  return (
    <View style={{ flex: 1, backgroundColor: brand.ink }}>
      <ScrollView contentContainerStyle={{ padding: 24, paddingTop: insets.top + 12, paddingBottom: insets.bottom + 40, gap: 24 }} showsVerticalScrollIndicator={false}>
        <View style={{ alignItems: 'flex-start' }}><GlassCircle onPress={() => router.back()}><Ionicons name="close" size={22} color={brand.ink} /></GlassCircle></View>
        <Animated.View entering={rise()} style={styles.hero}>
          <RingPattern width={360} height={200} color={brand.ink} opacity={0.14} />
          <View style={styles.badge}><Ionicons name="star" size={36} color={brand.orange} /></View>
          <Text style={styles.title}>{tr('plusTitle')}</Text>
          <Text style={styles.sub}>{plus ? tr('plusActiveBody') : tr('plusSub')}</Text>
        </Animated.View>
        <View style={{ gap: 12 }}>
          {perks.map(([icon, text], i) => (
            <Animated.View key={text} entering={rise(80 + i * 60)} style={styles.perk}>
              <View style={styles.perkIcon}><Ionicons name={icon} size={20} color={brand.orange} /></View>
              <Text style={{ color: brand.cream, fontSize: 16, fontWeight: '600', flex: 1 }}>{text}</Text>
            </Animated.View>
          ))}
        </View>
        {plus ? (
          <Button variant="danger" title={tr('cancelPlus')} onPress={() => setPlus(null)} />
        ) : (
          <>
            <View style={{ flexDirection: 'row', gap: 12 }}>
              {(['monthly', 'yearly'] as const).map((p) => {
                const on = plan === p;
                return (
                  <Tap key={p} style={{ flex: 1 }} onPress={() => { haptic.select(); setPlan(p); }} scale={0.97} feedback={false}>
                    <View style={[styles.plan, { borderColor: on ? brand.orange : 'rgba(255,248,238,0.18)', backgroundColor: on ? 'rgba(253,137,18,0.12)' : 'rgba(255,248,238,0.04)' }]}>
                      {p === 'yearly' ? <View style={styles.save}><Text style={{ color: brand.ink, fontSize: 11, fontWeight: '800' }}>{tr('plusSave')}</Text></View> : null}
                      <Text style={{ color: brand.cream, fontWeight: '700', fontSize: 15 }}>{p === 'monthly' ? tr('plusMonthly') : tr('plusYearly')}</Text>
                      <Text style={{ color: brand.orange, fontWeight: '900', fontSize: 26, marginTop: 6 }}>{money(PRICES[p], lang)}</Text>
                      <Text style={{ color: 'rgba(255,248,238,0.6)', fontSize: 12 }}>{p === 'monthly' ? tr('perMonth') : tr('perYear')}</Text>
                    </View>
                  </Tap>
                );
              })}
            </View>
            <Button title={tr('subscribe')} icon="star" onPress={() => { haptic.success(); setPlus(plan); router.back(); }} />
          </>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  hero: { alignItems: 'center', gap: 10, padding: 24, borderRadius: radius.xl, borderCurve: 'continuous', backgroundColor: brand.orange, overflow: 'hidden' },
  badge: { width: 76, height: 76, borderRadius: 38, backgroundColor: brand.ink, alignItems: 'center', justifyContent: 'center' },
  title: { color: brand.ink, fontSize: 32, fontWeight: '900' },
  sub: { color: brand.ink, fontSize: 16, textAlign: 'center', lineHeight: 22, fontWeight: '500' },
  perk: { flexDirection: 'row', alignItems: 'center', gap: 14, padding: 14, borderRadius: radius.lg, backgroundColor: 'rgba(255,248,238,0.07)' },
  perkIcon: { width: 40, height: 40, borderRadius: 20, backgroundColor: 'rgba(253,137,18,0.16)', alignItems: 'center', justifyContent: 'center' },
  plan: { borderWidth: 1.5, borderRadius: radius.lg, borderCurve: 'continuous', padding: 16, minHeight: 124, justifyContent: 'center' },
  save: { position: 'absolute', top: -11, start: 12, backgroundColor: brand.orange, paddingHorizontal: 8, height: 22, borderRadius: 11, justifyContent: 'center' },
});
