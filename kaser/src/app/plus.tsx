import React, { useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import Animated, { FadeInDown, ZoomIn } from 'react-native-reanimated';
import { LinearGradient } from 'expo-linear-gradient';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Button, GlassCircle, Tap, haptic } from '@/components/ui';
import { useT } from '@/i18n';
import { useStore } from '@/store';
import { money } from '@/lib/format';
import { brand } from '@/theme';

const PRICES = { monthly: 19, yearly: 149 } as const;

export default function Plus() {
  const { t: tr, lang } = useT();
  const insets = useSafeAreaInsets();
  const plus = useStore((s) => s.plus);
  const setPlus = useStore((s) => s.setPlus);
  const [plan, setPlan] = useState<'monthly' | 'yearly'>('yearly');
  const perks: [keyof typeof Ionicons.glyphMap, string][] = [['bicycle', tr('plusB1')], ['wallet', tr('plusB2')], ['sparkles', tr('plusB3')]];
  return (
    <LinearGradient colors={['#2A2A2E', '#0E0E10']} style={{ flex: 1 }}>
      <ScrollView contentContainerStyle={{ padding: 24, paddingTop: insets.top + 12, paddingBottom: insets.bottom + 40, gap: 22 }} showsVerticalScrollIndicator={false}>
        <View style={{ alignItems: 'flex-start' }}><GlassCircle onPress={() => router.back()}><Ionicons name="close" size={22} color="#1B1B1F" /></GlassCircle></View>
        <Animated.View entering={ZoomIn.springify().damping(12)} style={{ alignItems: 'center', gap: 10 }}>
          <View style={styles.badge}><Ionicons name="star" size={40} color="#fff" /></View>
          <Text style={styles.title}>{tr('plusTitle')}</Text>
          <Text style={styles.sub}>{plus ? tr('plusActiveBody') : tr('plusSub')}</Text>
        </Animated.View>
        <View style={{ gap: 14 }}>
          {perks.map(([icon, text], i) => (
            <Animated.View key={text} entering={FadeInDown.delay(100 + i * 80).springify().damping(16)} style={styles.perk}>
              <View style={styles.perkIcon}><Ionicons name={icon} size={20} color={brand.gold} /></View>
              <Text style={{ color: '#fff', fontSize: 16, fontWeight: '600', flex: 1 }}>{text}</Text>
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
                  <Tap key={p} style={{ flex: 1 }} onPress={() => { haptic.select(); setPlan(p); }} scale={0.96} feedback={false}>
                    <View style={[styles.plan, { borderColor: on ? brand.gold : 'rgba(255,255,255,0.15)', backgroundColor: on ? 'rgba(228,178,90,0.12)' : 'rgba(255,255,255,0.05)' }]}>
                      {p === 'yearly' ? <View style={styles.save}><Text style={{ color: '#1B1B1F', fontSize: 11, fontWeight: '800' }}>{tr('plusSave')}</Text></View> : null}
                      <Text style={{ color: '#fff', fontWeight: '700', fontSize: 15 }}>{p === 'monthly' ? tr('plusMonthly') : tr('plusYearly')}</Text>
                      <Text style={{ color: brand.gold, fontWeight: '900', fontSize: 26, marginTop: 6 }}>{money(PRICES[p], lang)}</Text>
                      <Text style={{ color: 'rgba(255,255,255,0.6)', fontSize: 12 }}>{p === 'monthly' ? tr('perMonth') : tr('perYear')}</Text>
                    </View>
                  </Tap>
                );
              })}
            </View>
            <Button title={tr('subscribe')} icon="star" onPress={() => { haptic.success(); setPlus(plan); router.back(); }} />
          </>
        )}
      </ScrollView>
    </LinearGradient>
  );
}

const styles = StyleSheet.create({
  badge: { width: 88, height: 88, borderRadius: 30, backgroundColor: brand.goldDeep, alignItems: 'center', justifyContent: 'center', shadowColor: brand.gold, shadowOpacity: 0.5, shadowRadius: 30, shadowOffset: { width: 0, height: 12 } },
  title: { color: brand.gold, fontSize: 34, fontWeight: '900' },
  sub: { color: 'rgba(255,255,255,0.75)', fontSize: 16, textAlign: 'center', lineHeight: 22 },
  perk: { flexDirection: 'row', alignItems: 'center', gap: 14, padding: 14, borderRadius: 18, backgroundColor: 'rgba(255,255,255,0.07)' },
  perkIcon: { width: 40, height: 40, borderRadius: 13, backgroundColor: 'rgba(228,178,90,0.15)', alignItems: 'center', justifyContent: 'center' },
  plan: { borderWidth: 1.5, borderRadius: 22, borderCurve: 'continuous', padding: 16, minHeight: 124, justifyContent: 'center' },
  save: { position: 'absolute', top: -11, start: 12, backgroundColor: brand.gold, paddingHorizontal: 8, height: 22, borderRadius: 11, justifyContent: 'center' },
});
