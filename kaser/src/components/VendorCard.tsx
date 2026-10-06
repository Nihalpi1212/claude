import { rise } from '@/lib/motion';
import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Animated, { FadeInDown, useAnimatedStyle, useSharedValue, withSequence, withTiming } from 'react-native-reanimated';
import { Ionicons } from '@expo/vector-icons';
import { router } from 'expo-router';
import { Art, Badge, Stars, Tap, Txt, haptic } from './ui';
import { useT } from '@/i18n';
import { useStore } from '@/store';
import { type Vendor } from '@/data/types';
import { isOpen } from '@/data/vendors';
import { money } from '@/lib/format';
import { radius, shadow, useTheme } from '@/theme';

export function Heart({ id, size = 20 }: { id: string; size?: number }) {
  const t = useTheme();
  const fav = useStore((s) => s.favorites.includes(id));
  const toggle = useStore((s) => s.toggleFavorite);
  const k = useSharedValue(1);
  const a = useAnimatedStyle(() => ({ transform: [{ scale: k.value }] }));
  return (
    <Tap
      onPress={() => {
        haptic.medium();
        toggle(id);
        k.value = withSequence(withTiming(1.2, { duration: 100 }), withTiming(1, { duration: 140 }));
      }}
      scale={0.85}
      feedback={false}
    >
      <View style={[styles.heart, { backgroundColor: t.isDark ? 'rgba(32,27,23,0.9)' : 'rgba(255,255,255,0.95)' }]}>
        <Animated.View style={a}>
          <Ionicons name={fav ? 'heart' : 'heart-outline'} size={size} color={fav ? t.danger : t.text} />
        </Animated.View>
      </View>
    </Tap>
  );
}

export function EtaPill({ v }: { v: Vendor }) {
  const { t: tr } = useT();
  return (
    <View style={styles.eta}>
      <Text style={{ fontSize: 12, fontWeight: '800', color: '#201B17' }}>
        {v.etaMin}–{v.etaMax} {tr('min')}
      </Text>
    </View>
  );
}

export function VendorCard({ v, delay = 0, width, compact }: { v: Vendor; delay?: number; width?: number; compact?: boolean }) {
  const t = useTheme();
  const { t: tr, l, lang } = useT();
  const open = isOpen(v);
  return (
    <Animated.View entering={rise(delay)} style={width ? { width } : undefined}>
      <Tap onPress={() => router.push(`/restaurant/${v.id}`)} scale={0.975}>
        <View style={[{ backgroundColor: t.card, borderRadius: radius.lg, borderCurve: 'continuous', overflow: 'hidden' }, shadow(t, 1)]}>
          <View>
            <Art emoji={v.emoji} colors={v.colors} radiusPx={0} style={{ height: compact ? 112 : 150, width: '100%', opacity: open ? 1 : 0.55 }} />
            <View style={styles.topRow}>
              {v.promo ? (
                <View style={[styles.promo, { backgroundColor: t.primary }]}>
                  <Ionicons name="pricetag" size={11} color={t.onPrimary} />
                  <Text numberOfLines={1} style={{ color: t.onPrimary, fontSize: 12, fontWeight: '800', maxWidth: 170 }}>{l(v.promo)}</Text>
                </View>
              ) : <View />}
              <Heart id={v.id} />
            </View>
            <View style={styles.bottomRow}>
              {!open ? <Badge text={tr('closed')} tone="neutral" icon="moon" /> : v.busy ? <Badge text={tr('busy')} tone="warning" icon="flame" /> : <View />}
              <EtaPill v={v} />
            </View>
          </View>
          <View style={{ padding: 14, gap: 4 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
              <Txt variant="headline" numberOfLines={1} style={{ flex: 1 }}>{l(v.name)}</Txt>
              <Stars value={v.rating} />
            </View>
            <Txt variant="footnote" color="secondary" numberOfLines={1}>
              {l(v.cuisine)} · {l(v.area)}
            </Txt>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4 }}>
              <Ionicons name="bicycle" size={15} color={v.deliveryFee === 0 ? t.success : t.textSecondary} />
              <Txt variant="footnote" color={v.deliveryFee === 0 ? 'success' : 'secondary'} style={{ fontWeight: '600' }}>
                {v.deliveryFee === 0 ? tr('freeDelivery') : money(v.deliveryFee, lang)}
              </Txt>
              <Txt variant="footnote" color="tertiary">•</Txt>
              <Txt variant="footnote" color="secondary">{tr('minOrder')} {money(v.minOrder, lang)}</Txt>
            </View>
          </View>
        </View>
      </Tap>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  heart: { width: 40, height: 40, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  topRow: { position: 'absolute', top: 12, start: 12, end: 12, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  bottomRow: { position: 'absolute', bottom: 10, start: 12, end: 12, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  promo: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 10, height: 26, borderRadius: radius.pill },
  eta: { backgroundColor: 'rgba(255,255,255,0.95)', paddingHorizontal: 10, height: 26, borderRadius: radius.pill, justifyContent: 'center' },
});
